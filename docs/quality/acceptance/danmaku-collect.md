<!--
  弹幕采集链路验收场景（文档式 Gherkin）：seg.so 全段采集入库 → 幂等重采 → 304 判停+段完整性 → 多 P → verify 五项 → bundle+popup 复制。
  格式对齐 [comments-collect.md](comments-collect.md) / [main-pipeline.md](main-pipeline.md) 先例；规则见 [docs/quality/RULES.md](../RULES.md) §5。
  不做机器校验；映射过期时发现顺手改。场景下方的「→」引用均为真实存在的测试文件与用例名（2026-10-07 核对）。
  规格唯一来源：[docs/plans/danmaku/PLAN.md](../../plans/danmaku/PLAN.md)（§7.4 场景清单、§2/§4/§5/§6 行为定义）。
-->

# Feature: B 站弹幕采集链路

单视频（含多 P）弹幕池全量采集入库：宿主 CLI 直连 B 站（seg.so 360s 分段 protobuf）→ server HTTP ingest 幂等 upsert →
304 越界判停 → 校验统计 → bundle 时间轴原料 + popup 查看/复制。链路上每一步的行为都有自动化测试锁定。

## Scenario: 单 P 全段采集入库（protobuf 解析 → 字段映射 → upsert）

- Given 视频已在库（danmaku 挂 videos.id；extra 有 aid/cid/pages），cookie 可选（匿名实测可用）
- When `danmaku collect --bvid <BV>`（seg.so segment_index 1..N=ceil(duration/360) 逐段拉取，
  手写 wire-format 解析 protobuf，白名单字段号映射入库列，白名单外按 wire-type 跳过并计数）
- Then 弹幕条目按字段字典落位：显示时间 progress_ms（-1 高级弹幕原值保留）、mode/fontsize/color/mid_hash/content/
  ctime_s（unix 秒原值）/weight/pool/action；唯一键取 field12 `id_str` 字符串（field1 int64 经 JS Number 尾数漂移，严禁作键）；
  分批 ingest（bvid/cid/page/fetched_at/batch_id 批次盖章）入库，回执 `fetched_total` 与 `store.inserted` 对账

→ [apps/collector-server/src/cli/bili-danmaku.test.ts](../../../apps/collector-server/src/cli/bili-danmaku.test.ts)
　（wire-format 解析纯函数：varint/长字符串/未知字段跳过与计数/截断体抛错；字段映射全列含 progress=-1 保留、idStr 字符串）
→ [apps/collector-server/src/cli/commands/danmaku.test.ts](../../../apps/collector-server/src/cli/commands/danmaku.test.ts)
　`batch-size 1 逐条冲刷:每条弹幕一个 ingest 批,body 带 bvid/cid/page/fetched_at/batch_id`、
　`回执结构:before/after rows 哨兵、store 累计、verify 段嵌入、video 三元组`
→ [apps/collector-server/src/http/danmaku.test.ts](../../../apps/collector-server/src/http/danmaku.test.ts)
　`弹幕 ingest：正常 200（白名单映射落位 + 批次级 cid/page 盖章 + inserted 计数 + 首采列）`
→ [apps/collector-server/src/db/danmaku.test.ts](../../../apps/collector-server/src/db/danmaku.test.ts)
　`upsert：空数组不开事务直接返回零计数；非空批恰开一次事务`

## Scenario: 幂等重采（同 id_str 二次 upsert，首采列保留）

- Given 该视频弹幕已采过一轮（行带 first_seen_at / batch_id），本轮重采全量重拉
- When 同 id_str 弹幕再次入库（同批跨段池快照重叠亦可能出现重复 id_str）
- Then 观测列（progress_ms/content/weight 等）以本轮值刷新，首采列（first_seen_at/batch_id）保留；
  同批重复 id_str 幂等吸收为单行；回执 inserted/updated 计数区分首采与更新——无水位/missing 机制，
  全量重拉即增量

→ [apps/collector-server/src/db/danmaku.test.ts](../../../apps/collector-server/src/db/danmaku.test.ts)
　`upsert 幂等：同 id_str 二次入库刷新观测列、保留首采列，返回 inserted/updated 计数`、
　`upsert：同批重复 id_str（跨段池快照重叠）幂等吸收为单行`
→ [apps/collector-server/src/http/danmaku.test.ts](../../../apps/collector-server/src/http/danmaku.test.ts)
　`弹幕 ingest：幂等二次 ingest（updated 计数 + 观测列刷新 + 首采列 first_seen_at/batch_id 保留）`

## Scenario: 304 越界判停 + 段完整性（越界哨兵与预算保护）

- Given 视频时长确定段数 N=ceil(duration/360)，越界段 B 站恒返回 HTTP 304 空体（`bili-status-code: -304`，业务响应非错误）
- When 段循环推进：N 计算判停为主，304 提前判停为哨兵；200 空体段后出现非空段属变长分段改版信号（日志告警不中断）
- Then 整 P 全 304 → 本 P 立即断且**非 partial**（不浪费预算）；`--max-segments` 显式触顶 → partial `segments_cap`；
  请求预算 `--max-requests` 用尽 → partial `request_budget`；风控三档退避（30s/120s/300s）尽 → partial `risk_abort`，
  已入库批次保留（行级幂等，重跑安全）；回执 `pages[].segments_expected/fetched` 承载段完整性（采集时点事实，不落库）

→ [apps/collector-server/src/cli/commands/danmaku.test.ts](../../../apps/collector-server/src/cli/commands/danmaku.test.ts)
　`304 越界哨兵:整 P 全 304 → 本 P 立即断且非 partial,不浪费预算`、
　`--max-segments 1 触顶:P1 采 1 段后 partial segments_cap,后续 P 不再启动`、
　`请求预算 3:P1 采完(2 请求)+P2 采 1 段(第 3 请求)后 partial request_budget`、
　`风控三档退避:seg 恒 412 → sleeps=[30s,120s,300s],4 次尝试后 partial risk_abort`、
　`空段转非空警示:seg1 空 200 + seg2 非空 → [fetch] 变长分段疑似改版,不中断采完`

## Scenario: 多 P 视频分 cid 采集（page=all 串行 / --page n 过滤）

- Given 多 P 视频（每 P 独立 cid/duration → 独立弹幕池），库内 extra.pages 承载分 P 清单
- When `danmaku collect --bvid <BV>`（默认 `--page all`）或 `--page 2`（只采第 2 个分 P）
- Then 各 P 按 cid 隔离串行采集（每 P 独立算段数独立判停），入库行带 cid/page 列多 P 共存互不干扰；
  `--page` 非法值（0/abc）或越界（超过分 P 数）→ ARGS 退 2；extra 缺分 P 信息时 view 回查补齐（只读不回写）

→ [apps/collector-server/src/cli/commands/danmaku.test.ts](../../../apps/collector-server/src/cli/commands/danmaku.test.ts)
　`多 P 全采:page=all 串行两 P,segmentsForDuration 积分(720s→2 段,400s→2 段),回执 pages 统计对账`、
　`--page 2 过滤:只采第 2 个分 P(段请求仅 cid=457)`、
　`extra 无分 P 信息 → view 回查补 aid/pages/duration(只读不回写),stat.danmaku 进回执`
→ [apps/collector-server/src/db/danmaku.test.ts](../../../apps/collector-server/src/db/danmaku.test.ts)
　`多 P 共存：两 cid 两 page 并存互不干扰，danmakuCount 按 cid/page 聚合`
→ [apps/collector-server/src/cli/commands/danmaku.cli.test.ts](../../../apps/collector-server/src/cli/commands/danmaku.cli.test.ts)
　`collect --page 非法(0/abc)与越界(3/共 2 P)→ ARGS 退 2`

## Scenario: verify 校验五项（R1-R5 统计与完整性）

- Given 库内弹幕行存在各类形态：负 progress（非高级弹幕）、mode/pool 分布、weight 分位、ctime 跨度、空视频
- When `danmaku verify --bvid <BV>`（DB 只读；collect 收尾也经 server 端点内嵌同一校验）
- Then 五项输出：R1 `negative_progress`（只计 mode<7，NULL mode 三值逻辑排除）/ R2 `dup_id` 防御断言（UNIQUE 下恒 0）/
  R3 mode 分布 + weight 分位（nearest-rank，无值回落 null）/ R4 60s 直方图 + 峰值分钟（并列取更早）/
  R5 ctime 范围（unix 秒原值口径）；CLI 真进程回执经全局 `--format json` 输出，显式 `--server` 出「只读本地 --db」警告；
  BV 不在库退 5、`--bvid` 缺失退 2

→ [apps/collector-server/src/db/danmaku.test.ts](../../../apps/collector-server/src/db/danmaku.test.ts)
　`verifyDanmaku：60s 直方图按整分钟分桶升序，峰值分钟并列取更早分钟`、
　`verifyDanmaku：负 progress 不进直方图；negative_progress 只计 mode<7（NULL mode 三值逻辑排除）`、
　`verifyDanmaku：mode 分布（NULL 不入）；weight 分位 nearest-rank、无值回落 null`、
　`verifyDanmaku：dup_id 防御断言恒 0 + ctime 范围；空视频全空形态`
→ [apps/collector-server/src/cli/commands/danmaku.cli.test.ts](../../../apps/collector-server/src/cli/commands/danmaku.cli.test.ts)
　`verify:真实临时库读 danmaku 表出 R1-R5 统计(峰值分钟并列取小 / weight 分位 / --server 忽略警告)`、
　`verify:BV 不在库 → NOT_FOUND 退 5;--bvid 缺失 → ARGS 退 2`
→ [apps/collector-server/src/http/danmaku.test.ts](../../../apps/collector-server/src/http/danmaku.test.ts)
　`弹幕 verify：§5.3 统计 200（R1 负 progress/R3 分布分位/R4 直方图峰值/R5 ctime）/ 只读幂等 / 不在库 404 / 缺参 400`

## Scenario: bundle 弹幕原料 + popup 查看/一键复制（消费端）

- Given 库内已有弹幕的视频（含多 P 与无时间点行）
- When `export bundle` 出包（无新参数）；扩展 popup（0.1.34+）在 B 站视频页拉 `/api/danmaku/list` 展示并点「复制」
- Then bundle 出 `danmaku/<BV>.md` 时间轴正文（60s 桶分小节、桶内 progress 升序、`[MM:SS]` 时间戳、
  mode>1 尾注 `[M<mode>]`、多 P `## P<N>` 分组、无时间点行归 P 末尾小节、空 P 不出小节）+
  manifest `danmaku` 摘要（file/rows/pages/peak_minute_rows/last_collected_at；0 弹幕视频省略字段不出文件）；
  popup 复制文本每条一行 `[MM:SS] 内容`（与 bundle 正文同形态，progress 缺失出 `[--:--]`，行间 \n 无尾随换行）

→ [apps/collector-server/src/cli/bundle-danmaku.test.ts](../../../apps/collector-server/src/cli/bundle-danmaku.test.ts)
　`buildBundle:有弹幕视频出 danmaku/<BV>.md + manifest danmaku 摘要;0 弹幕视频省略字段不出文件`、
　`md 头部:标题/引用统计行(采集日·总数·分 P 数·峰值分钟)/说明行,末尾换行`、
　`mode 标注:mode 1 滚动不加注;4 底部/5 顶部等 mode>1 尾注 [M<mode>]`、
　`多 P:每 P 出「## P<N> cid=<cid>」分组,桶小节带 P 前缀防跨 P 重名`、
　`无时间点行(负值/NULL)归 P 末尾「无时间点」小节,不进分钟桶;单 P 时小节不带 P 前缀`、
　`峰值分钟:多 P 同分钟桶不合并((video,cid,桶) 计数取 max),负值/NULL 不计,并列取先见桶`
→ [apps/subtitle-collector/test/popup-danmaku.test.mjs](../../../apps/subtitle-collector/test/popup-danmaku.test.mjs)
　`formatDanmakuCopy：正常多行，行间 \n、无尾随换行`、
　`formatDanmakuCopy：progress_ms null → [--:--] 行`、
　`formatClock：3600s → 1:00:00（H:MM:SS，小时不补零）`、
　`danmakuCopyStats：多行文本按行数计`

---

## 测试轮次记录表

| 轮次 | 日期 | 命令 | 结果 | 备注 |
|---|---|---|---|---|
| 待首次 `pnpm qa` | — | — | 结果回填 | C7 文档同步落盘时的占位行 |
