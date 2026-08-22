<!--
  主链路验收场景样例（文档式 Gherkin）：批量采集 → 入库 → 导出 bundle。
  用途：给 spec 作者示范「中文 Given/When/Then 场景 → 自动化测试映射」的标注格式，
  规则见 [docs/quality/RULES.md](../RULES.md) §5。不做机器校验；映射过期时发现顺手改。
  场景下方的「→」引用均为真实存在的测试文件与用例名（2026-08-23 核对）。
-->

# Feature: 字幕批量采集主链路

批量采集 B 站 / YouTube 视频字幕：任务批量建立与去重 → 派发扩展执行 → 上报入库 →
默认轨排序 → 失败重试 → 导出分析原料 bundle。链路上每一步的行为都有自动化测试锁定。

## Scenario: 批量建任务去重

- Given UP 主名下 30 个视频，其中 5 个已有 pending/dispatched 在途任务
- When 用户在 popup 勾选批量提交（`createTasksBatch`）
- Then 只新建 25 条 pending 任务，在途 5 条不重复建；已到终态的视频允许重采再建新任务
- And youtube 来源按 11 位 vid 独立去重域，不与 bvid 混淆

→ [apps/collector-server/src/tasks/tasks.test.ts](../../../apps/collector-server/src/tasks/tasks.test.ts)
　`createTasksBatch：批量建 pending 任务；pending/dispatched 去重，终态允许重采`、
　`createTasksBatch：source=youtube（11 位 vid 校验 + watch URL + 独立去重域）`

## Scenario: 扩展上报入库（WS 链路）

- Given 扩展已连接 server（hello 握手完成）
- When 用户打开有字幕的视频页，扩展从页面抽取元信息组装 payload 并经 WS 发 `ingest`
- Then server 写入 SQLite（video + creator + subtitle_track + subtitle_version）并回 `ingest-ack`
- And popup「已收集」区块刷新；无字幕视频 `tracks:[]` 不炸

→ [apps/collector-server/src/ws/server.test.ts](../../../apps/collector-server/src/ws/server.test.ts)
　`ingest 消息：服务端写入 SQLite 并回 ingest-ack`
→ [apps/subtitle-collector/test/ingest-payload.test.mjs](../../../apps/subtitle-collector/test/ingest-payload.test.mjs)
　`buildIngestPayload 组装完整 payload（含轨+版本）`、`buildIngestPayload 无字幕 → tracks:[]`
→ [apps/collector-server/src/db/ingest.test.ts](../../../apps/collector-server/src/db/ingest.test.ts)
　`首次 ingest：video + creator + track + version 都插入`

## Scenario: 重复入库幂等（刷新重采零新增）

- Given 视频 BV 已入库且字幕内容未变（body_hash 相同）
- When 用户点「刷新字幕」触发再次上报同一视频
- Then 元信息不动、已有 version 跳过，不产生新版本行；title 没变则 change_log 不增加
- And 任务行回报「已刷新：无新增」

→ [apps/collector-server/src/db/ingest.test.ts](../../../apps/collector-server/src/db/ingest.test.ts)
　`同 video 再 ingest：元信息不变则不动，version 已存在则跳过`、
　`版本去重：同 body 不同签名 URL → 跳过；body 变化 → 新版本行`

## Scenario: 派发优先上次执行者

- Given 任务上次由扩展 A 执行（无论成败），现处于待派发态；扩展 A、B 均在线空闲
- When server 为该任务挑选执行扩展（`pickClientForTask`）
- Then 优先派给 A（重试不换环境，保登录态/风控上下文）；A 忙时回落任意空闲，不空转等待
- And creator 本人在线时优先归 creator，其次才是上次执行者

→ [apps/collector-server/src/tasks/tasks.test.ts](../../../apps/collector-server/src/tasks/tasks.test.ts)
　`pickClientForTask：无 creator、上次执行者在线空闲 → 优先回原扩展（重试不换环境）`、
　`pickClientForTask：上次执行者忙 → 回落任意空闲（软偏好不 wait 不空转）`、
　`pickClientForTask：creator 在线 → 归 creator（即便别人空闲/曾是执行者）`

## Scenario: 失败重试

- Given 任务处于 failed / limited 终态
- When 用户在任务行点重试（`retryTask`）
- Then 原地重置回 pending：行 id / batch 不变（重试并入原批次），旧执行结果清空
- And 库内已有字幕轨的视频直接置 succeeded 免重采，不重置不派发

→ [apps/collector-server/src/tasks/tasks.test.ts](../../../apps/collector-server/src/tasks/tasks.test.ts)
　`retryTask：failed/limited 原地重置回 pending（行 id/batch 不变,旧执行结果清空）`、
　`retryTask：库内已有字幕轨 → 直接置 succeeded 免重采（不重置 pending 不派发）`

## Scenario: 默认轨优先级（CC中文 > AI中文 > 英文）

- Given 视频同时有多条字幕轨：中文人工 CC（track_type=2）、中文 ASR（type=1）、英文 CC、翻译轨（type=3）
- When 查询视频详情（`getVideo`）
- Then 轨道按 CC中文 > AI中文 > 英文 CC > 英文 ASR 排序，排序后首轨标 `is_default`
- And 翻译轨（YouTube tlang 机翻）排在所有原文轨之后——英文视频默认正文不再落机翻中文

→ [apps/collector-server/src/db/queries.test.ts](../../../apps/collector-server/src/db/queries.test.ts)
　`getVideo: 默认轨优先级 CC中文 > AI中文 > 英文`、
　`getVideo: 翻译轨(type=3) 排在原文 CC/ASR 之后——YouTube 默认轨不再落机翻中文`

## Scenario: export bundle 产物结构

- Given 库内一批视频：多数有字幕、个别无字幕或 payload 损坏
- When `export bundle`（按 UP 主 / 搜索主题 / 过滤器圈定）
- Then 产出分析原料目录三件套：`manifest.json`（filters 回显 + total/exported 计数）+
  `videos/*.txt`（正文为 `[分:秒] 字幕` 行格式，取默认轨，`--track en` 可覆盖）+ `ANALYZE.md`
- And 无字幕视频 `subtitle:null` 不出正文文件；payload 损坏记入 `errors[]`，整包不中断

→ [apps/collector-server/src/cli/bundle.test.ts](../../../apps/collector-server/src/cli/bundle.test.ts)
　`buildBundle: 有字幕视频出正文文件，无字幕视频 subtitle:null 不出文件`、
　`buildBundle: --track en 覆盖默认轨`、
　`buildBundle: payload 损坏 → errors[] 记录、subtitle:null、整包不中断`、
　`ANALYZE_MD: 含三类产物模板锚点 + analysis/<主题>/ 落盘路径 + 盲区两栏`

---

## 测试轮次记录表

| 轮次 | 日期 | 命令 | 结果 | 备注 |
|---|---|---|---|---|
|  |  | `pnpm qa` |  |  |
|  |  |  |  |  |
