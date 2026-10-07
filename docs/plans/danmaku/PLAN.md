# B 站弹幕(danmaku)采集 — 实施设计(PLAN)

> 落盘位置:`docs/plans/danmaku/PLAN.md`(本文档即其内容)。
> 措辞边界:本项目原有数据类型是**字幕(subtitle)**与**评论(comment)**;弹幕(danmaku)是 2026-10-07 新增的数据类型,三者措辞严禁混用——字幕=视频语音转写轨,评论=评论区两层树,弹幕=视频画面上滚动的时间轴弹幕。CLAUDE.md §4 红线语义更新为「三类数据措辞分离」,字幕≠弹幕的原红线维持有效。
> 政策属性:**弹幕采集是 2026-10-07 用户现场指令放行的新能力(/goal:支持把视频的弹幕也全部爬下来,server 同步实现),与 2026-10-03 评论解冻、2026-08-29 抖音解冻同类,属一次性解冻**——不改变 CLAUDE.md §6 采集侧冻结政策本身,除本文档明确范围外,其余采集侧能力维持冻结。
> 输入:调研 A(B 站弹幕 API 文档,含 2025-04 数值化改版公告)、调研 B(项目现状,comments 全链路模板)、**调研 C(真实 API 实测 spike,2026-10-07,附录 A)**。基线:main `c28b16b`。
> 时间口径:库内时间列一律毫秒 epoch(项目惯例);例外 `danmaku.ctime_s` 保存 B 站原值 **unix 秒**(列名显式 `_s` 后缀,与 comments.ctime_s 同款防混算)。

---

## 0. 决策摘要

| # | 决策 | 结论 | 一句话理由 |
|---|---|---|---|
| D1 | 采集接口 | `GET /x/v2/dm/web/seg.so?type=1&oid={cid}&pid={aid}&segment_index={n}`,n 从 **1** 到 `ceil(duration/360)`,越界段 HTTP 304 空体判停 | 实测(附录 A):6656s 视频 seg1–19 全 200、seg20/21 恒 304;213s 视频 seg1 有数据、seg6 恒 304;`x/v1/dm/list.so` 旧 XML 接口不接(弃用风险、单响应上限不可控) |
| D2 | protobuf 解码 | 手写 wire-format 最小解析器(varint + length-delimited,**零新增依赖**),字段号→列白名单映射,未知字段号跳过并计数 | 163KB/1408 条与 2100 条全样本零解析失败(附录 A);引 protobufjs 属外部依赖须走 §8 确认,手写 ~80 行纯函数可测性更好 |
| D3 | 唯一键 | `id_str`(field 12,字符串)作 UNIQUE 键;**禁止用 field 1 id(int64)当键** | 实测 field1 经 JS Number 往返尾数漂移(378284259331276**83** → …**80**),idStr 逐字节稳定;与评论「五 ID 一律取 *_str」同款防御 |
| D4 | 写库通路 | 宿主 CLI 直连 B 站采集 → server HTTP `POST /api/danmaku/ingest` 写库 | 评论 D4 同款;「CLI 永不写库」纪律([db.ts:1-2](apps/collector-server/src/cli/db.ts#L1)) |
| D5 | 定位来源 | cid/aid/duration 优先读库(`videos.extra.cid` / `extra.aid` / `extra.pages[]`,扩展采集时已入库,见 [ingest-payload.js:3-14](apps/subtitle-collector/ingest-payload.js#L3));缺失回查 `view?bvid=`/`view?aid=` 补齐(只读回查,不回写库) | 零上游改动;回查先例 comments D8(asr.ts view 回查同款) |
| D6 | 多 P 视频 | `--page all\|<n>`(默认 all):遍历 `extra.pages[]` 每 P 独立采(每 P 有独立 cid/duration);`extra.pages` 缺失时按单 P 处理 | 弹幕按 cid 隔离,多 P 是 B 站产品事实;表带 cid/page 列承载 |
| D7 | 增量语义 | **不做水位/missing 机制**;重采 = 全量重拉 + 幂等 upsert(请求数 = 段数,111 分钟视频仅 19 请求,2 分钟内完成);删除的弹幕不物理删,库内自然保留 | 评论那套复杂度源于翻页成本高(116 请求/轮);弹幕全量重拉成本 ≈ 一页评论,水位机制是负收益 |
| D8 | 总数哨兵 | `view?aid=` 的 `stat.danmaku` 对账(±容忍,仅 warn);`player/wbi/v2` 的 dm_seg/dm_count 不依赖(实测缺失,附录 A) | stat.danmaku 是历史累计计数,弹幕池会淘汰删除,只做软对账 |
| D9 | cookie | `--cookie-file` **可选**(缺省读 `$COLLECTOR_BILI_COOKIE_FILE`,有则带、无则匿名跑) | 实测 seg.so 匿名 200 可拿全量(附录 A 台账);与评论(wbi/main 签名必须 nav 取 key,匿名 -101)不同,弹幕接口无此硬依赖;带上降风控概率,故默认仍带 |

---

## 1. 目标与范围

### 1.1 目标

把单个 B 站视频(含多 P)的**当前弹幕池全量**采集成结构化时间轴入库:

1. **时间轴完整**:segment_index 1..N 全段翻齐,每条弹幕带 `progress_ms`(视频内显示时间),可还原「观众在哪个时间点反应强烈」;
2. **元数据完整**:mode(滚动/顶部/底部/高级)、color、fontsize、发送时间 ctime、weight(智能屏蔽权重)、mid_hash(发送者 CRC32 匿名哈希)、pool;
3. **可重采**:全量重拉 + `UNIQUE(id_str)` 幂等 upsert,重复采集安全;删除/淘汰弹幕自然沉淀在库不丢失;
4. **可校验**:入库后自检(段完整性 / 时间轴值域 / 总量哨兵对账 / 时间分布统计);
5. **可消费**:export bundle 增补弹幕原料(manifest 摘要 + `danmaku/<BV号>.md` 时间轴正文),分析会话可直接回答「观众在哪一分钟炸锅」类问题。

### 1.2 范围内

- B 站**视频稿件**(UGC,`type=1`)的弹幕池;单视频全 P 采集与幂等重采;
- 新表 `danmaku`(collector-server)+ 迁移 v22 + server ingest/count/verify 端点 + CLI `danmaku collect/verify`;
- export bundle 弹幕导出 + ANALYZE.md 模板增补;
- **扩展 popup 弹幕查看 + 一键复制**(2026-10-07 用户现场指令追加:「popup 也要同步支持复制」):popup 展示当前视频弹幕条数,一键复制为时间轴文本;采集仍走 CLI,popup 只消费;
- 文档同步(SKILL.md / help / README / CLAUDE.md §6,见 §9.3)。

### 1.3 范围外(显式排除,与评论条目边界写法对齐)

- 直播弹幕(直播另有独立协议,非 seg.so 通路)、番剧/课程等非 UGC 稿件弹幕;
- 弹幕**写操作**(发送/删除/举报)——采集链路只读;
- 历史弹幕按天回补(`/x/v2/dm/web/history`):seg.so 已返回当前池全量(实测 ctime 跨度 2020→2026,附录 A),历史接口无增量价值,若实测发现池淘汰缺口再登记;
- web 展示(collector-web VideoDetail 弹幕热力/列表渲染)——登记 [consumption-loop.md](docs/plans/consumption-loop.md) 推迟项,疼了再做(与评论 web 展示同款处置);**popup 展示 + 复制不在推迟范围**(2026-10-07 用户现场指令纳入,见 §1.2);
- `stats` 命令组的弹幕维度聚合(verify 统计已覆盖首轮需求);
- YouTube / 抖音弹幕(平台接口不同,不在本次解冻范围);
- 扩展侧改动:弹幕采集走宿主 CLI 直连,subtitle-collector 扩展**零改动、无需 bump manifest version**(评论先例同款)。

### 1.4 政策属性(必须随文档落盘保留)

弹幕采集属**消费端分析数据源增强**:评论是「观众怎么说」,弹幕是「观众在哪个时刻说什么」——时间轴维度是评论区结构给不了的(评论区只有发布时间,没有视频内时间)。2026-10-07 用户现场指令解冻(/goal 指令),与评论 2026-10-03、抖音 2026-08-29 解冻同性质:**一次性、不构成对冻结政策本身修改**;README 条目翻转时按先例格式注明授权出处(§9.3)。

---

## 2. B 站弹幕数据模型(以实测为准,附录 A)

### 2.1 接口选择论证

| 用途 | 选定 | 落选及原因 |
|---|---|---|
| 弹幕池全量 | `GET https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid={cid}&pid={aid}&segment_index={n}`(protobuf) | 旧 `/x/v1/dm/list.so`(XML):弃用风险高、单响应有历史上限截断传闻、无分段粒度不可续;grpc 通路需要 HTTP/2+证书,过重 |
| 定位(cid/aid/duration) | 库内 `videos.extra` 优先 → `GET /x/web-interface/view?bvid=|aid=` 回查 | view 匿名可用(实测);回查顺带拿 `stat.danmaku` 哨兵(D8) |
| 分段表 | **不依赖 dm_seg**:`N = ceil(duration/360)`,seg 1..N 顺序拉,304 即止 | 实测 dm_seg 匿名与带 cookie 均 null、分段仍 360s 均匀从 1 起(2025-04 数值化改版公告实测未生效于本通路);若未来改版破坏该假设,304 提前判停 + `[fetch]` 日志可观察,届时再评估 dm_seg 通路 |
| 总数哨兵 | `view` 响应 `stat.danmaku` | player/wbi/v2 实测无 dm_count 键(附录 A);stat.danmaku 与 videos 库内 extra.stat 同源 |

### 2.2 分段机制(实测)

- `segment_index` 从 **1** 开始,每段 **360s**,总段数 `N = ceil(duration/360)`;
- 有效段:HTTP 200 + protobuf(可为空 elems = 该段无弹幕);越界段:**HTTP 304 + 空体 + 响应头 `bili-status-code: -304`**(实测与 cookie/UA 无关,恒定)——304 是「无此分段」的正常业务响应,非缓存语义;
- 判停以 `N` 计算为主(定时哨兵),304 提前判停为辅(实测一致);若 200 空体段后仍能拉到非空段(变长分段形态出现),日志告警 `[fetch] seg 变长分段疑似改版`,采数不中断;
- POST 不支持(405);响应 content-type `application/octet-stream`。

### 2.3 字段字典(protobuf field → 入库映射,实测)

`seg.so` 响应 = `DmSegMobileReply { repeated DanmakuElem elems = 1 }`(顶层另见 field 4/5 各一,为分段配置类字段,不入库)。

| field | wire | 语义(实测+文档) | 入库列 | 处理规则 |
|---|---|---|---|---|
| 1 | varint | 弹幕 id(int64) | 不入库 | **JS Number 精度丢失实测**(37828425933127683→…80);唯一键一律用 field 12(D3) |
| 2 | varint | 显示时间 progress(毫秒) | `progress_ms` | 实测存在 `-1`(高级弹幕无时间点),原值保留不钳;verify 统计 |
| 3 | varint | mode:1-3 滚动 4 底部 5 顶部 6 逆向 7 高级 8 代码 9 BAS | `mode` | 值域统计;>9 视为未知形态照入库 |
| 4 | varint | 字体大小 | `fontsize` | 常见 25 |
| 5 | varint | 颜色(十进制 RGB,16777215=0xFFFFFF) | `color` | — |
| 6 | str | 发送者 mid 的 CRC32 hex(如 `d2b24dbe`) | `mid_hash` | B 站匿名化设计,无 mid 明文;不可逆,无隐私增量 |
| 7 | str | 弹幕正文 | `content` | 检索主列 |
| 8 | varint | 发送时间 ctime(unix 秒) | `ctime_s` | 列名 `_s` 后缀防与毫秒混算(全库惯例例外同 comments.ctime_s) |
| 9 | varint | 智能屏蔽权重 weight(0-10) | `weight` | 低权重会被云屏蔽;统计分布 |
| 10 | str | action(UP 醒目等动作标记) | `action` | 实测未出现(样本无 10 号),缺省 NULL |
| 11 | varint | pool:0 普通 1 字幕 2 特殊 | `pool` | — |
| 12 | str | **idStr(字符串唯一键)** | `id_str`(UNIQUE) | 幂等 upsert 键 |
| 13 | varint | 实测出现(数值,语义未解明) | 不入库 | 白名单外跳过 + 计数 |
| 15/18/20/21/24/25/26/27 | 混合 | 实测出现率低(26 疑似回显 cid),语义未解明 | 不入库 | 同上;`[parse]` 日志输出未识别字段号分布,出现率突变可观察 |

解析器规则:白名单字段号映射入库;白名单外一律**按 wire-type 正确跳过**(不报错),并累计「未识别字段号 → 出现次数」map 供日志输出。wire-type 3/4(deprecated group)遇错即抛(样本未见,触发即协议变化)。

### 2.4 弹幕语义边界

| 边界 | 规则 |
|---|---|
| 弹幕池淘汰 | B 站池有容量上限,极热视频早期弹幕可能被淘汰;seg.so 返回**当前池快照**(实测 ctime 跨 6 年说明常规视频全保留);verify 以 stat.danmaku 软对账(warn 不 error) |
| 删除/风控屏蔽 | 被删弹幕从池消失;库内行保留(不物理删、无 missing 机制,D7),verify 报「库内 vs 本轮池」差值计数 |
| weight 云屏蔽 | 低 weight 弹幕在部分客户端不可见,但池内存在;照常入库,消费端可按 weight 过滤 |
| 高级/代码弹幕 | mode 7/8 实测罕见;`progress_ms=-1` 形态存在,原值入库 |
| 关闭弹幕区 | seg.so 行为未实测到专门错误码(防御:非 2xx/304 按 §4.5 错误处置);弹幕区关闭通常表现为全段 200 空 elems |
| 多 P | 每 P 独立 cid → 独立段循环;表带 `cid`/`page` 列,D6 `--page` 语义 |

---

## 3. DB 设计

### 3.1 DDL(贴入 [schema.sql](apps/collector-server/src/db/schema.sql) 末尾,风格对齐现有表)

```sql
-- B 站弹幕(2026-10-07 用户现场指令一次性解冻,与 2026-10-03 评论解冻同类;措辞:弹幕 danmaku,与字幕 subtitle/评论 comment 三类分离)。
-- 数据形态:时间轴平铺列表(无树),seg.so 按段返回当前弹幕池快照;
-- 唯一键 id_str = protobuf field12 字符串(field1 int64 在 JS Number 下尾数漂移,实测 37828425933127683→…80,严禁作键);
-- mid_hash 是发送者 CRC32 hex(B 站侧匿名化,无 mid 明文)。
-- 幂等 upsert:UNIQUE(id_str);重采刷新观测列,保留首采列(first_seen_at/batch_id)。
-- 删除不物理删、无 missing 机制(全量重拉成本低,评论式水位是负收益,PLAN §0 D7)。
-- 时间口径:ctime_s 是 B 站原值 unix 秒(列名 _s 后缀防与毫秒 *_at 列混算);其余 *_at 列毫秒 epoch(全库惯例)。
CREATE TABLE IF NOT EXISTS danmaku (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  id_str         TEXT NOT NULL,               -- field12 字符串唯一键
  video_id       INTEGER NOT NULL REFERENCES videos(id),
  cid            INTEGER NOT NULL,            -- 分 P 的 cid(oid)
  page           INTEGER NOT NULL DEFAULT 1,  -- 分 P 页码(extra.pages[].page;单 P = 1)
  progress_ms    INTEGER,                     -- 显示时间毫秒;高级弹幕可 -1(无时间点,原值保留)
  mode           INTEGER,                     -- 1-3 滚动 4 底 5 顶 6 逆向 7 高级 8 代码 9 BAS
  fontsize       INTEGER,
  color          INTEGER,                     -- 十进制 RGB(16777215=白色)
  mid_hash       TEXT,                        -- 发送者 CRC32 hex(匿名)
  content        TEXT,                        -- 弹幕正文(检索列)
  ctime_s        INTEGER,                     -- 发送时间,B 站原值 unix 秒!(显式 _s 后缀)
  weight         INTEGER,                     -- 智能屏蔽权重 0-10(低权重被云屏蔽)
  pool           INTEGER,                     -- 0 普通 1 字幕 2 特殊
  action         TEXT,                        -- UP 醒目等动作标记(实测样本未见,缺省 NULL)
  first_seen_at  INTEGER NOT NULL,            -- 首采时刻(毫秒;upsert 保留)
  last_seen_at   INTEGER NOT NULL             -- 最近一次在响应中见到(毫秒;重采刷新)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_danmaku_id ON danmaku(id_str);
CREATE INDEX IF NOT EXISTS idx_danmaku_video ON danmaku(video_id, cid, progress_ms);
```

### 3.2 迁移(v22)

纯 `CREATE TABLE/INDEX IF NOT EXISTS`,学 v20/v13 幂等步骤模板([migrate.ts](apps/collector-server/src/db/migrate.ts))。**当前最新 v21(jobs;v20=comments)→ 弹幕取 v22**。`MIGRATIONS` 账本追加:

```ts
{
  version: 22,
  note: 'danmaku 表新建(2026-10-07 弹幕采集解冻):B 站视频弹幕池时间轴快照,seg.so protobuf 分段采集,UNIQUE(id_str) 幂等 upsert,无水位/missing 机制(全量重拉成本低)。双写 schema.sql;新库全量重放安全(CREATE IF NOT EXISTS)',
  statements: [ /* 与 §3.1 DDL 完全一致,双写防漂移 */ ],
},
```

双写纪律:schema.sql 与 v22 statements 逐字一致;migrate.test.ts「新库重放 + 旧行为」断言模式照跑;db/danmaku.test.ts 加 sqlite_master.sql 逐字比对守漂移(comments.test.ts 先例)。

### 3.3 幂等 upsert 语义

`db/danmaku.ts` 导出 `upsertDanmaku(db, videoId, rows, opts)`,单事务批量:

```
对每条 row(id_str 为键):
  存在 → UPDATE:last_seen_at = opts.fetched_at,
          观测列(progress_ms/mode/fontsize/color/mid_hash/content/ctime_s/weight/pool/action)以本轮值为准刷新
          (弹幕发送后不可编辑,内容理论不变;刷新是防御 B 站侧修正,幂等无害)
          保留:id, video_id, cid, page, first_seen_at, batch_id
  不存在 → INSERT 全列(first_seen_at = last_seen_at = fetched_at,batch_id = 本轮值)
返回 { inserted, updated }
```

与评论的差异:无 pins/无 missing/无 R0 三元组修正——弹幕无关联结构,upsert 就是纯键值幂等。

### 3.4 查询函数(供 verify/bundle/回执)

- `danmakuCount(db, videoId)` → `{ rows, pages: [{cid, page, rows}], max_ctime_s, min_progress_ms, max_progress_ms }`;
- `verifyDanmaku(db, videoId)`(详见 §5);
- `danmakuTimeline(db, videoId)` → 按 (cid, progress_ms) 升序全量行(供 bundle 正文)。

---

## 4. 采集设计

### 4.1 通路与写库决策

```
collector-cli danmaku collect(宿主 CLI 进程)
  ├─ 读:server HTTP  GET /api/videos/bilibili/<bvid>      → video_id + extra.{aid,cid,pages[]}
  │        extra 缺失 → 宿主直连 GET view?bvid=|aid= 回查 aid/cid/pages/duration + stat.danmaku(D5/D8)
  ├─ 采:B 站直连(宿主进程内,复用 asr-net.ts 网络层 + biliHeaders;cookie 可选 D9)
  └─ 写:server HTTP  POST /api/danmaku/ingest             → upsert 入生产库
```

「server 不直连平台」分工不变;写库必须走 server(生产库在 docker volume)。

**ingest 端点**(新建 [http/danmaku.ts](apps/collector-server/src/http/danmaku.ts),对齐 http/comments.ts 模式):

```
POST /api/danmaku/ingest   (Bearer 鉴权,同既有端点)
{
  "bvid": "BV1GJ411x7h7",
  "cid": 137649199,               // 本批所属分 P
  "page": 1,                      // 分 P 页码
  "fetched_at": 1728273600000,    // 毫秒
  "batch_id": "…",                // crypto.randomUUID()(node:crypto,零新增依赖)
  "danmakus": [ /* 解析归一后的条目:id_str/progress_ms/mode/fontsize/color/mid_hash/content/ctime_s/weight/pool/action */ ]
}
→ 200 { ok: true, video_id: 42, inserted: 1408, updated: 0 }
→ 404 { ok: false, error: "video not found: bilibili/BV1…" }   // 弹幕挂在 videos.id,先采视频
→ 400 { ok: false, error: "danmakus: [...] required" }

GET /api/danmaku/count?bvid=   (Bearer 鉴权;读 GET/写 POST 惯例)
→ 200 { ok: true, rows: 1408, pages: [{"cid":137649199,"page":1,"rows":1408}],
         max_ctime_s: 1791348874, min_progress_ms: 837, max_progress_ms: 210563 }
→ 200 { ok: true, rows: 0, pages: [], …: null }   // 视频在库但未采过弹幕(非 404)
→ 404 { ok: false, error: "video not found: …" }

GET /api/danmaku/verify?bvid=   (只读;collect 收尾自动调用,结果内嵌回执)
→ 200 { ok: true, … §5.3 结构 }
→ 404
```

### 4.2 CLI 参数表(`danmaku collect`)

| 参数 | 默认 | 说明 |
|---|---|---|
| `--bvid <BV>` | 与 `--aid` 至少其一 | BV 号定位;与 `--aid` 同给交叉校验,不一致退 2(comments 同款) |
| `--aid <n>` | — | av 号直给;单给时 view?aid= 回查 bvid 再走库定位 |
| `--page <all\|n>` | `all` | 多 P 选择:all=遍历库内/回查 pages 全采;n=只采第 n 个分 P |
| `--max-segments <n>` | `0`(不限) | 单 P 段数上限(小样本试跑;0=以 N=ceil(duration/360) 为准) |
| `--max-requests <n>` | `300` | 单轮请求预算(段请求数天然少,300 足够 5 小时视频);超预算 → partial + `partial_reason:"request_budget"` |
| `--segment-interval-ms <n>` | `1000` | 段间隔基数(实际 ±30% 抖动 700–1300ms);弹幕请求量小,间隔可比评论页间隔(2000ms)宽松一档 |
| `--batch-size <n>` | `2000` | 每次 ingest 携带条数上限(单段最多数千条) |
| `--dry-run` | off | 拉取与解析照跑、不调 ingest;回执 `dry_run:true`,store 段改 `would_requests/rows` |
| `--cookie-file <path>` | `$COLLECTOR_BILI_COOKIE_FILE` | **可选**(实测匿名可用,D9);有则带、无则匿名跑,日志注明 `cookie=anonymous` |
| `--format <table\|json>` | `table` | 回执形态(stdout 机器可读 JSON 建议显式 json) |

### 4.3 采集编排伪代码

```
collect(bvid|aid, page, ...):
  # 0. 定位
  video = serverGetVideo(bilibili, bvid)             # 无 → NOT_FOUND 退 5,提示先采视频
  extra = video.extra ?? view 回查                    # aid/cid/pages[]/duration + stat.danmaku 哨兵
  pages = extra.pages ?? [{cid: extra.cid, page: 1, duration: video.duration}]
  selected = 按 --page 过滤
  cookie = loadCookieOrAnonymous()                    # 可选(D9)
  cnt = GET /api/danmaku/count?bvid=                  # 回执用(重采 diff 展示)

  for p of selected:                                  # 多 P 串行
    N = ceil(p.duration / 360)
    for seg in 1..min(N, maxSegments 或 ∞):
      r = fetchSeg(aid, p.cid, seg)                   # [fetch] 日志 + segDiag
      if r.status == 304: segDiag; break              # 越界,正常终态(304 前置判停早于 N,双保险)
      if r.status != 200: 错误处置(§4.5)
      elems = parseSeg(r.body)                        # [parse] 命中计数 + 未识别字段号分布
      buffer.push(...elems)
      flush(buffer, batch_size)                       # [store] 分批 ingest(cid=p.cid, page=p.page)
      if seg < N: sleep(interval ± 30%)
    # P 内收尾
    verifyP = GET /api/danmaku/verify?bvid=(只读)      # 内嵌回执

  # 4. 收尾
  emitResult(回执 §4.6)
```

### 4.4 判停条件表

| 循环 | 正常判停 | 上限保护 | 异常判停 |
|---|---|---|---|
| 段循环 | `seg > N = ceil(duration/360)`(计算判停)或 **HTTP 304**(实测越界哨兵,提前判停) | `--max-segments`(显式设值触顶 → partial + `partial_reason:"segments_cap"`) | 风控三档退避后仍失败 → 终止 partial;单段连败 ≥3 → 终止 partial;200 空体段后出现非空段 → 日志告警不中断(变长分段疑似改版,§2.2) |
| 全局 | — | 请求预算 `--max-requests`(默认 300)→ partial + `"request_budget"` | fetch 网络异常复用 fetchBiliJson 归一 |

无防打转问题:段号单调递增,无游标概念。

### 4.5 限速 / 退避 / 错误码处置

| 项 | 处置 |
|---|---|
| 段间隔 | `--segment-interval-ms` 1000ms 基数 ×(1±30%) 抖动(700–1300ms);段请求数少,比评论页间隔宽松 |
| 风控退避 | 复用 `withRiskRetry`(30s/120s/300s),标签 `[danmaku]`;HTTP 412 / `bili_-412/-352/-799/-509` 判风控(comments 已扩展 isRiskCode,直接复用) |
| -403 | wbi 签名错误特有码——弹幕接口无 wbi 签名,出现即协议变化,不退避直接终止 + segDiag |
| -101 | 需登录(匿名实测可用,出现即异常)→ 若带 cookie 提示重取,未带 cookie 提示补 cookie 重跑 |
| HTTP 304 | 越界正常终态(§2.2),不是错误 |
| HTTP 非 2xx/304 / 畸形体 | fetchBiliJson 归一;protobuf 解析失败(解析器抛错)→ 终止 partial + 保留 body 样本 hex 头日志 `[parse] 前 32 字节` |

### 4.6 回执(stdout,机器可读)

```json
{
  "ok": true, "dry_run": false, "partial": false,
  "video": { "bvid": "BV1GJ411x7h7", "aid": 80433022, "title": "…" },
  "pages": [ { "cid": 137649199, "page": 1, "duration_s": 213, "segments_expected": 1,
               "segments_fetched": 1, "fetched": 1408 } ],
  "fetched_total": 1408,
  "store": { "inserted": 1408, "updated": 0, "requests": 1 },
  "before_rows": 0, "after_rows": 1408,
  "bili_requests": 1, "elapsed_ms": 1200,
  "stat_danmaku": { "view": 1408 },
  "verify": { "…": "§5.3 内嵌" }
}
```

`partial:true` 时附 `partial_reason`:`"request_budget"` / `"segments_cap"` / `"risk_abort"`。

### 4.7 观察性日志设计(CLAUDE.md §9 逐条落地)

全部 stderr(复用 logInfo,`-q` 抑制);`[danmaku]` 前缀;样例:

```
[danmaku] BV1GJ411x7h7 aid=80433022(来源=extra.aid)pages=1 cookie=~/Local/collector-secrets/bili-cookie.txt
[danmaku] P1 cid=137649199 dur=213s → segments=1
[fetch] seg cid=137649199 index=1 http=200 bytes=163802
[parse] seg cid=137649199 index=1 elems=1408 命中: id_str 1408/1408 progress 1407/1408 content 1408/1408 ctime 1408/1408 | 未识别字段 {13: 3, 15: 1408, 26: 1408}
[store] batch#1 → POST /api/danmaku/ingest inserted=1408 updated=0(累计 1408/0,请求数 1)
[danmaku] P1 完成: segs=1/1 弹幕 1408
[verify] rows=1408 timeline_range=0.8s..210.6s dup_id=0 seg_complete=1/1 stat_danmaku_gap=0
[danmaku] 完成: 总 1408 B 站请求 1 耗时 1.2s
```

`segDiag(r)`(对位 replyDiag/pageDiag,任何非 200/304 失败必带):`diag status=… bili_status=<响应头 bili-status-code> bytes=… headers=[键集] body_head_hex=<前 32 字节>`。
分步标签:`[fetch]`=HTTP 状态与体量;`[parse]`=结构命中计数(x/total)+ 未识别字段号分布;`[store]`=输入输出计数;`[verify]`=校验摘要。

---

## 5. 校验

### 5.1 校验规则(`db/danmaku-verify.ts` `verifyDanmaku(db, videoId)`,纯 SQL+JS 可测)

| # | 规则 | 判定 | 级别 |
|---|---|---|---|
| R1 | 时间轴值域 | `progress_ms IS NOT NULL AND progress_ms < 0 AND mode < 7` 计数(非高级弹幕出现负时间点) | warn(计 negative_progress) |
| R2 | 重复 id_str | COUNT(*) vs COUNT(DISTINCT id_str)(UNIQUE 下恒等,防御断言) | error(恒 0,触发即库损坏) |
| R3 | 值域统计 | mode/pool 各值分布;weight 分位数(p50/p90/max) | info |
| R4 | 时间分布 | 按 60s 桶直方图(消费端「哪分钟炸锅」的库内口径);peak 桶 | info |
| R5 | ctime 范围 | min/max ctime_s(信息性;与 first_seen_at 无关) | info |

### 5.2 段完整性(采集轮回执内,非库内规则)

段完整性是**采集时点**事实(「本轮抓了几段/预期几段」),不落库;collect 回执 `pages[].segments_expected/fetched` 承载。跨轮对账无意义(池内容随时间变化)。

### 5.3 校验回执(verify 端点与 `danmaku verify` 子命令共用)

```json
{
  "ok": true, "bvid": "BV1…",
  "counts": { "rows": 1408, "pages": 1, "by_page": [{"cid":137649199,"page":1,"rows":1408}] },
  "timeline": { "min_progress_ms": 837, "max_progress_ms": 210563,
                 "histogram_60s": [{"from_ms":0,"rows":210},…], "peak_minute": {"from_ms":120000,"rows":401} },
  "mode": {"1": 1300, "5": 88, "4": 20},
  "weight": { "p50": 9, "p90": 10, "max": 10 },
  "integrity": { "dup_id": 0, "negative_progress": 1 },
  "ctime": { "min_s": 1593092327, "max_s": 1791348874 }
}
```

---

## 6. 消费端

### 6.1 导出形态

弹幕是时间轴平铺数据,无树结构;导出物 = manifest 摘要 + `danmaku/<BV号>.md` 时间轴正文,两件(评论 D7 同哲学)。

md 正文设计:**按分钟分桶,桶内按 progress_ms 升序逐条列**(时间戳 + 内容);每分钟开头给桶计isson数行;重复刷屏内容不做去重(保真原池)。头部给统计行(总条数/时长跨度/峰值分钟)。

```markdown
# 弹幕 · BV1GJ411x7h7
> 采集 2026-10-07 · 共 1408 条 · P1(213s)· 峰值分钟 03:00-04:00(401 条)
> 按 progress 时间升序;`[M]`=mode(1 滚动 5 顶部 4 底部);时间轴为弹幕显示时间。

## 00:00-01:00(89 条)
[00:01] 前排
[00:03] 经典
…
```

多 P:每个分 P 一个 `## P<N> cid=<cid>` 二级分组。

### 6.2 manifest 新字段(bundle.ts `BundleVideoEntry` 增补,0 字段省略哲学同 comments)

```ts
export interface BundleDanmakuMeta {
  file: string;              // "danmaku/<BV号>.md"
  rows: number;              // 总条数
  pages: number;             // 分 P 数
  peak_minute_rows: number;  // 峰值分钟条数(分析一眼看热点)
  last_collected_at: number; // MAX(last_seen_at) 毫秒
}
// BundleVideoEntry 增: danmaku?: BundleDanmakuMeta   ← 库内 0 弹幕时省略字段,'danmaku' in v 判别
```

实现要点:批量 IN 聚合防 N+1(bundle-comments.ts 先例);存量 bundle 不回填。

### 6.3 ANALYZE.md 模板增补(analyze-template.ts,单一事实源)

- 盲区模型第五类:「弹幕盲区——manifest 无 `danmaku` 字段 = 该视频未采弹幕;弹幕与评论互补:评论=观点论述,弹幕=时间轴即时反应」;
- 观点汇总模板增可选段:「弹幕时间轴热点(如已导出弹幕):峰值分钟对应视频段落 = 观众情绪触发点;`danmaku/<BV>.md` 峰值分钟交叉引用视频章节」;
- 出处格式约定:`> 来源: <视频标题> 弹幕 @<progress 时间点>`。

---

## 7. 测试计划(collector-server 口径:c8 node --test --import tsx,全中文测试名 + 注释三档 + 覆盖率锁定)

### 7.1 测试文件与用例清单

| 文件 | 层 | 核心用例 |
|---|---|---|
| `src/cli/bili-danmaku.test.ts` | 解析纯函数 | wire-format 解析(varint 多字节/长字符串/未知字段白名单外跳过/未知字段计数/wire-type 5 固定 32 位/group 抛错/截断体抛错);encodeDanmakuElem 测试夹具构造器(测试用 protobuf 编码器,生产不用);parseSeg 顶层字段分布/空 elems/字段映射全列(含 progress=-1 保留、idStr 字符串);segDiag 形态 |
| `src/db/danmaku.test.ts` | db 层(:memory: 库 + migrate 种子) | v22 迁移(新库重放/旧行为/sqlite_master 逐字比对守双写漂移);upsert 幂等(同 id_str 二次:内容刷新、first_seen_at/batch_id 保留);多 P 共存(cid/page 列);danmakuCount 各形态;verifyDanmaku R1-R5 夹具(负 progress/重复断言/直方图/峰值);索引存在性 |
| `src/http/danmaku.test.ts` | HTTP 端点 | ingest 200(inserted/updated);body 校验 400(缺 danmakus/缺 cid/缺 bvid);video 不存在 404;批量事务原子性;count 200/404/0 行;verify GET 只读 |
| `src/cli/commands/danmaku.test.ts` | 编排纯函数(mock fetchImpl + mock ServerClient,comments 双注入先例) | 段数计算 ceil(duration/360);304 判停;200 空体段后非空段告警不中断;多 P 遍历/`--page n` 过滤;--max-segments 触顶 partial;请求预算 partial;分批 flush;风控退避后 partial;回执结构(before/after_rows diff);cookie 匿名回落 |
| `src/cli/commands/danmaku.cli.test.ts` | 子进程装配(execFile 真 CLI,comments.cli 同构) | `--help` 自描述;--bvid/--aid 双缺退 2;不一致退 2;--page 非法值退 2;dry-run 回执;mock B 站 seg.so;tree 无(弹幕无 tree 子命令) |
| `src/cli/bundle-danmaku.test.ts` | bundle | meta 聚合(GROUP BY 防漂移);md 渲染(分钟桶/多 P 分组/峰值标注/空弹幕不出文件);manifest 字段省略哲学 |

### 7.2 覆盖率影响评估

- 新增源文件(`db/danmaku*.ts`、`http/danmaku.ts`、`cli/bili-danmaku.ts`、`cli/commands/danmaku*.ts`、bundle 增量)全部纳入 c8 现有口径,无新豁免登记;
- 锁定线 98/93/99/98 只升不降;protobuf 解析器纯函数天然高覆盖;编排循环抽纯函数(`segmentsForDuration` / `shouldStopSeg`)控复杂度 ≤15 / 文件 ≤400 行(comments 四拆先例);
- web 侧弹幕展示不在本期,collector-web 零改动。

### 7.3 回归纪律用例示例

- 例:id_str 精度——「field1 与 field12 尾数不一致时(真实 B 站样本),入库键必须等于 field12 字符串」(回归大整型 id 误用);
- 例:304 判停——「duration=6656s 时 seg20 请求后必须停止且不记 partial」。

### 7.4 验收场景与测试轮次

Gherkin 验收文档:`docs/quality/acceptance/danmaku-collect.md`(格式对齐 main-pipeline.md 先例)。首批场景:

1. 单 P 全段采集入库(protobuf 解析→字段映射→upsert)→ 映射 `commands/danmaku.test.ts` + `db/danmaku.test.ts`;
2. 幂等重采(同 id_str 二次 upsert,first_seen_at/batch_id 保留)→ 映射 `db/danmaku.test.ts`;
3. 304 越界判停 + 段完整性对账 → 映射 `commands/danmaku.test.ts`;
4. 多 P 视频分 cid 采集 → 映射 `commands/danmaku.test.ts`;
5. verify 校验五项(负 progress/重复/直方图/峰值/ctime 范围)→ 映射 `db/danmaku.test.ts`;
6. bundle 弹幕原料(manifest 摘要 + md 时间轴)→ 映射 `bundle-danmaku.test.ts`。

测试轮次记录表(随验收文档内嵌,RULES §5):

| 轮次 | 命令 | 结果 |
|---|---|---|
| 待首次 pnpm qa | — | 结果回填 |

---

## 8. 风控与合规

### 8.1 频率参数

| 参数 | 值 | 依据 |
|---|---|---|
| 段间隔 | 1000ms ± 30% 抖动(700–1300ms) | 段请求数天然少(1 小时视频 10 请求);社区弹幕采集基线 ≥0.5s/请求 |
| 请求预算 | 单轮 `--max-requests` 默认 300(5 小时视频 = 50 段 × 多 P 余量) | 事前预算,防失控 |
| 单视频成本 | 111 分钟视频 = 19 请求 × 均值 1s ≈ 20s;10 小时长视频 ≈ 100 请求 ≈ 2 分钟 | 弹幕是全库采集成本最低的数据类型 |
| 失败熔断 | 单段连败 3 次 / 风控三档退避尽 → 终止本轮 partial | 同评论 |

### 8.2 cookie 通路(可选,复用零新增)

`--cookie-file` / `$COLLECTOR_BILI_COOKIE_FILE`,有则带无则匿名(实测匿名可用,附录 A 台账 r7);来源与刷新方式同评论(`scripts/bili-cookie-from-chrome.mjs --refresh`)。带 cookie 的动机:降低匿名风控概率 + 未来若 B 站收紧匿名访问无感切换。

### 8.3 失败路径可观察性逐条对照(CLAUDE.md §9)

| §9 要求 | 本设计落点 |
|---|---|
| HTTP 状态与响应特征 | `[fetch]` 每请求 status/bytes;`segDiag` 任何非 200/304 必带(bili-status-code 头/体 hex 头) |
| 解析命中计数 | `[parse]` 字段命中率 x/total + 未识别字段号分布(协议演化可观察) |
| 每步输入输出计数 | `[store]` inserted/updated/累计/请求数;P 完成小结 |
| 日志看不出先修日志 | segDiag 先于风控猜测;「变长分段疑似改版」「200 空段后非空段」显式命名 |
| 参考实现分步标签 | `[fetch]/[parse]/[store]/[verify]` 对位 youtube-collect-videos.mjs |

### 8.4 抓取行为合规边界

1. 只采公开数据:弹幕池未登录可读(实测);不碰登录墙内容;
2. 限速礼貌:段间隔抖动 + 请求预算;弹幕请求密度全库最低;
3. 不自动化验证码:v_voucher 类出现即如实失败;
4. 数据最小化:mid_hash 本身是 B 站侧匿名化产物;不建用户维度聚合;不存未解明字段。

---

## 9. 落地步骤

### 9.1 commit 序列(每步可独立 qa;涉代码提交跑 `pnpm qa` 引用结果;server 改动先 `npx tsc --noEmit`)

| # | commit | 内容 | 验证 |
|---|---|---|---|
| C0 | 无 commit(spike,已完成) | 弹幕接口连通性 + protobuf 解析 spike,实录附录 A | 已完成 2026-10-07 |
| C1 | `feat(db): danmaku 表 v22 + upsert/verify 查询` | schema.sql DDL + migrate.ts v22 + `db/danmaku.ts` + `db/danmaku-verify.ts` + 双测试 | pnpm build + turbo test;迁移双写漂移断言 |
| C2 | `feat(cli): 弹幕 protobuf wire-format 解析纯函数` | `cli/bili-danmaku.ts` + 测试(可与 C1 并行) | 解析全形态测试(真实 spike 样本回放) |
| C3 | `feat(http): danmaku ingest/count/verify 端点` | `http/danmaku.ts` + main.ts 路由注册 + `http/danmaku.test.ts` | 端点测试;部署需 docker rebuild |
| C4 | `feat(cli): danmaku collect 采集编排` | `cli/commands/danmaku*.ts`(collect,含多 P/预算/304 判停)+ main.ts 注册 + 双测试文件 | CLI 测试;真实视频手跑 dry-run → 全量 |
| C5 | `feat(cli): danmaku verify 子命令 + db.ts DB-only 警告组` | commands/danmaku.ts verify + cli/db.ts 组名单 + 测试 | verify 回执对照 §5.3 |
| C6 | `feat(bundle): manifest danmaku 摘要 + danmaku/*.md 导出 + ANALYZE 模板增补` | bundle.ts + bundle-danmaku.ts + analyze-template.ts + 测试 | 出一个含弹幕的实测 bundle |
| C7 | `docs: 弹幕采集文档同步(SKILL/help/README/CLAUDE/PLAN/验收)` | §9.3 全清单 + Gherkin 验收文档 + 本文档落盘 | verify-skill-sync 过(qa 门) |
| C8 | 端到端验收 | 真实视频全链路:collect → verify → bundle;验收实录回填附录 B | 实测数字 |

### 9.2 涉及文件清单

```
apps/collector-server/src/db/schema.sql                (+DDL,末尾追加)
apps/collector-server/src/db/migrate.ts                (+v22 步骤)
apps/collector-server/src/db/danmaku.ts                (新:upsert/count/timeline 查询)
apps/collector-server/src/db/danmaku-verify.ts         (新:verifyDanmaku R1-R5 + 直方图/峰值)
apps/collector-server/src/db/danmaku.test.ts           (新)
apps/collector-server/src/http/danmaku.ts              (新:POST ingest + GET count/verify)
apps/collector-server/src/http/danmaku.test.ts         (新)
apps/collector-server/src/cli/bili-danmaku.ts          (新:wire-format 解析/字段映射/segDiag)
apps/collector-server/src/cli/bili-danmaku.test.ts     (新)
apps/collector-server/src/cli/commands/danmaku.ts      (新:collect/verify 装配)
apps/collector-server/src/cli/commands/danmaku-net.ts  (新:I/O 适配,comments-net 同构)
apps/collector-server/src/cli/commands/danmaku-run.ts  (新:纯判定,comments-run 同构)
apps/collector-server/src/cli/commands/danmaku-collect.ts (新:编排循环,comments-collect 同构)
apps/collector-server/src/cli/commands/danmaku.test.ts / danmaku.cli.test.ts (新)
apps/collector-server/src/cli/main.ts                  (命令注册 +2 行)
apps/collector-server/src/cli/db.ts                    (DB-only 警告组加 danmaku)
apps/collector-server/src/cli/bundle.ts                (BundleDanmakuMeta + 导出挂点)
apps/collector-server/src/cli/bundle-danmaku.ts        (新:meta 聚合 + md 渲染)
apps/collector-server/src/cli/bundle-danmaku.test.ts   (新)
apps/collector-server/src/cli/analyze-template.ts      (盲区第五类 + 弹幕段)
apps/collector-server/src/cli/commands/export.ts       (danmaku/ 建目录分支)
apps/collector-server/src/main.ts                      (路由表 /api/danmaku 前缀行)
```

不涉 CLI 之外的采集链路改动;**popup 支持为 2026-10-07 现场指令追加,涉扩展改动**:manifest version 0.1.33 → **0.1.34** + permissions 增 `clipboardWrite`、popup 新增 `hooks-danmaku.ts` 与根模块 `popup-danmaku.mjs`(C9 步骤);collector-web 零改动(展示推迟 §1.3);server 走 docker rebuild 上生产。

**追加步骤 C9**(popup 支持,2026-10-07 现场指令):
- server:`GET /api/danmaku/list?bvid=`(轻量白名单字段 progress_ms/mode/content/ctime_s,popup 拉数用);
- 扩展:popup 弹幕行(条数 + 复制按钮,复制文本 `[MM:SS] 内容` 与 bundle 正文同形态;manifest bump 0.1.34);
- 测试:http/danmaku.test.ts 增补 + test/popup-danmaku.test.mjs 新建(popup-danmaku.mjs 在 c8 99/99/99/98 锁定口径内)。

### 9.3 文档同步清单

| 文档 | 改动 |
|---|---|
| `docs/plans/danmaku/PLAN.md` | 本文档落盘(+附录 A spike 实录 + 附录 B 验收实录) |
| [docs/skills/collector/SKILL.md](docs/skills/collector/SKILL.md) | 命令组速查表加 `danmaku collect | server HTTP + B 站直连 | 弹幕池时间轴采集(参数摘要)`、`danmaku verify | DB 只读 | 校验统计`;样例块加 `collector-cli danmaku collect --bvid <BV> --dry-run`;references/playbooks.md 加「弹幕采集→bundle 消费」工作流 |
| docs/help/`采集弹幕.md` | **新页**:前置(视频须在库)→ dry-run → 全量 → verify;cookie 可选说明;只写怎么用 |
| docs/help/INDEX.md | 采集组加新页行 |
| docs/help/`导出分析原料包.md` | 增 danmaku/ 目录与 manifest `danmaku` 字段说明 |
| docs/help/`采集模型.md` | 数据流总览增弹幕入口(宿主 CLI 直连型,与评论同款) |
| [README.md](README.md) | Feature 列表增条目(按评论条目格式):`- ✅ **B 站弹幕采集**(2026-10-07,用户现场指令一次性解冻):单视频多 P 弹幕池全量(seg.so protobuf 分段,手写 wire-format 解析零依赖)→ danmaku 表入库(幂等 upsert,无水位机制)→ CLI danmaku collect/verify → bundle 导出(manifest 摘要 + danmaku/*.md 时间轴正文);直播弹幕、历史按天回补、web 弹幕展示、其他平台不在本期范围` |
| CLAUDE.md(项目级) | §6 追加「2026-10-07 用户现场指令解冻(弹幕采集)」日期条目(格式仿评论条目);§4 措辞红线补「评论/弹幕为已登记数据类型,三类措辞分离」说明 |
| docs/quality/acceptance/danmaku-collect.md | 新增:Gherkin 验收场景(§7.4 六类)+ 测试轮次记录表 |
| docs/plans/consumption-loop.md | 推迟项登记:web 弹幕展示(时间轴热力图挂点 VideoDetail) |
| docs/plans/improvement-backlog-2026-10.md | 不登记(新功能非改善项;以 README Feature 锚点为准) |

### 9.4 部署与收尾注意

- server 改动合并后 docker rebuild 才到生产;先 `npx tsc --noEmit`(memory: server tsc 门只在 docker build 跑);
- 生产库迁移 v22 由 server 启动自动执行(幂等;v21 已在产,v22 顺次);
- 端到端验收(附录 B):挑已入库真实视频(长视频优先,段多)全链路 collect → verify → bundle;coverage/diff 数字回填;
- CLI 完整度反向登记:无绕过发生,不登记 docs/plans/cli-completeness.md。

---

## 附录 A:Spike 实录(2026-10-07)

环境:宿主 node/curl 直连 `api.bilibili.com`;UA Chrome/154;`Referer: https://www.bilibili.com/video/<bv>/`;请求间隔 ≥1.5s;cookie 按需带 `~/Local/collector-secrets/bili-cookie.txt`(**凭证值不落任何文档/日志**)。样本:BV1GJ411x7h7(Rick Astley 官方 MV,aid=80433022,cid=137649199,duration=213s,单 P)、BV1XGpF6CEwq(马祖列岛旅行,aid=117392831158223,cid=42504555111,duration=6656s,stat.danmaku=13429)。临时产物 `/tmp/dm-spike/`(不进仓库)。

### A.1 请求台账

| # | 请求 | 结果 |
|---|---|---|
| r1 | view?bvid=BV1GJ411x7h7(匿名) | code 0:aid=80433022,cid=137649199,duration=213,单页 |
| r2 | seg.so type=1&oid=137649199&pid=80433022&segment_index=6(匿名) | **HTTP 304 空体**,响应头 `bili-status-code: -304` |
| r3 | r2 带 Cache-Control: no-cache / --compressed | 仍 304(非缓存语义) |
| r4 | r2 带 cookie | 仍 304(213s 视频仅 1 段,seg6 越界 → 304=「无此分段」业务响应) |
| r5 | segment_index=1(匿名) | HTTP 200,**163802B protobuf**,解析 1408 elems **零失败** |
| r6 | POST seg.so | HTTP 405(仅 GET) |
| r7 | seg1 匿名 ↔ 带 cookie 对照 | 均 200;**匿名可用** |
| r8 | player/wbi/v2?cid&aid(匿名) | code 0,**dm_seg=null**;键集含 subtitle/options/view_points 等,无 dm_count |
| r9 | r8 带 cookie(login_mid=5543239) | code 0,**dm_seg 仍 null** |
| r10 | 长视频 oid 误传 aid=117392831158223 | seg1/2/6/18/19/20 全 200 **空体**(oid 必须=cid 的反面实证) |
| r11 | 长视频 oid=42504555111(cid),seg 1/2/3/6/18/19 | 全 200:63K/59K/40K/39K/18K/32K 字节 |
| r12 | 长视频 seg 20/21 | **304 空体**(ceil(6656/360)=19,越界判停哨兵) |
| r13 | 长视频 6 段全解析 | 2100 条零失败,UNIQUE idStr=2100;段分布 534/496/327/328/147/268 |

### A.2 实测结论

| 项 | 结论 |
|---|---|
| oid 语义 | **oid=cid(分 P 的 cid),不是 aid**;pid=aid(r10 反面实证) |
| 分段规律 | segment_index 从 **1** 开始、每段 **360s**、N=ceil(duration/360);双视频交叉验证(213s→1 段,6656s→19 段) |
| 越界段 | 恒 **HTTP 304 空体**(头 `bili-status-code: -304`),与 cookie/缓存头无关;是「无此分段」业务响应非 HTTP 缓存 |
| 匿名可用性 | seg.so 匿名 200 拿全量(r5/r7);player/wbi/v2 匿名 code 0 但 dm_seg=null(r8);view 匿名完整 |
| dm_seg | 匿名与登录态均 null → 2025-04「数值化分段」公告(2 分钟浮动段)实测未生效于本通路;360s 均匀假设维持,304 哨兵兜底 |
| protobuf 结构 | 顶层 `{"1": elems, "4": ?, "5": ?}`(field4/5 各一,分段配置类,不入库);DanmakuElem 字段号实测集 {1,2,3,4,5,6,7,8,9,11,12,13,15,18,20,21,24,25,26,27} 全部可按 wire-type 跳过 |
| id 精度 | field1 int64 经 JS Number 往返**尾数漂移**(37828425933127683→…80);field12 idStr 字符串逐字节稳定 → **唯一键必须 idStr**(D3) |
| 弹幕池语义 | rickastley ctime 跨度 2020-06→2026-10,长视频 2100 条 vs stat.danmaku=13429(差值为历史淘汰/关闭弹幕的累计计数口径)→ seg.so=当前池快照,stat.danmaku=历史累计,软对账 warn 不 error |
| 特殊形态 | progress_ms=-1 样本存在(高级弹幕无时间点);mode 以 1(滚动)为主;mid_hash 为 8 位 CRC32 hex |

### A.3 三点最终裁定

1. **分段总数判定**:`N = ceil(duration/360)` 为主判停,304 提前判停为哨兵;dm_seg 不依赖(null 实测)。若未来出现「200 空段后非空段」即变长分段改版信号,日志告警 `[fetch] seg 变长分段疑似改版`,采数不中断,届时再评估 dm_seg 通路。
2. **唯一键**:`id_str`(field12 字符串);field1 只作诊断日志,严禁入库作键(JS 大整型精度丢失实测)。
3. **cookie 可选**:匿名实测可用;CLI 默认带(文件存在时),缺失不报错降级匿名并日志注明。

---

## 附录 B:验收实录(2026-10-07)

| 环节 | 结果 |
|---|---|
| 部署 | collector-server 镜像 rebuild + 容器 recreate(named volume 数据不动);`user_version` 21→22 自动迁移,danmaku 表就位;四端点探活:ingest 无鉴权 401 / 空体 400 / count·verify·list 不在库 404,全部符合预期 |
| 本地全链路(临时库) | BV1GJ411x7h7(Rick Astley,213s 单段):`--dry-run` 1406 条全命中(未识别字段分布日志在位)→ 首采 `inserted=1408` → 幂等重采 `inserted=3 / updated=1405`(**2 分钟内真实新增 3 条被增量吸收**,1408→1411)→ verify 峰值分钟 421 条 → bundle `danmaku/<BV>.md` 57KB |
| 生产采集闭环 | BV1A5T76GEGG(907s,3 段):211+247+118=**576 条 inserted,2.5s 完成**;verify rows=576 / dup_id=0 / negative_progress=0 / 峰值分钟 09:00(44 条)/ weight p50=10 / ctime 2026-07-02→10-05;dm 哨兵口径实证:extra.stat.danmaku=8009 vs 池内 576(历史累计 vs 当前池,§2.4 软对账定性成立) |
| 消费端 | `/api/danmaku/list`(popup 通路)576 行白名单四字段;快照通道(容器内 VACUUM INTO + CLI `--db`)export bundle:manifest `danmaku` meta(file/rows/pages/peak_minute_rows/last_collected_at)+ `danmaku/BV1A5T76GEGG.md` 614 行——`[MM:SS]` 时间轴、`[M5]` 顶部弹幕标注、**progress=-1 条目归「无时间点」组**(§2.4 边界真实样本命中) |
| 质量门 | `pnpm qa` 全绿:server 1446 tests(c8 98/94.02/99/93+ 全过)、扩展 397 tests(c8 99/98.19/100/98,popup-danmaku.mjs 100%)、web vitest(100/93.68 门过);台账 34/34 PASS;depcruise 420 modules 0 违反;skill-sync 44 条;docs-sync 全过 |
| popup 真机 | 构建产物 dist 0.1.34 就绪(clipboardWrite 权限 + DanmakuCard);真机验证待用户 chrome://extensions 刷新后在 B 站视频页 popup 核对弹幕卡与复制(manifest version 对照 0.1.34) |
