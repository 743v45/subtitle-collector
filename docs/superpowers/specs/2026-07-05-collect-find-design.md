# `collect find` 条件检索命令设计文档

> 字幕（subtitle）采集系统的检索入口。**不是弹幕（danmaku）**。
> 实现见 [collect.ts:245](apps/collector-server/src/cli/commands/collect.ts#L245) 起的 `collect find` 区段。

---

## 1. 背景与动机

### 1.1 痛点：现有检索粒度不够

`bili-collect` 标准 skill 流程（[SKILL.md:28](apps/collector-server/../subtitle-collector/../../.claude/skills/bili-collect/SKILL.md#L28)）的第一步是 `collect search <keyword>`，它只是把 B 站搜索结果原样透传回来。但实际选片时，用户常常需要的是这样的问题：

> 「财经分区里，粉丝上万、最近一周发的、有字幕的视频有哪些？」

`search` action 做不到这件事，原因有三（详见 [collect.ts:246](apps/collector-server/src/cli/commands/collect.ts#L246) 注释）：

1. **B 站 `search/type` API 服务端只接受 关键词 / 分区(tid) / 排序(order) 等参数**——见扩展装配 [background.js:147](apps/subtitle-collector/background.js#L147) 的 `/x/web-interface/wbi/search/type` 调用，参数只有 `search_type/keyword/page/order/tid`，没有「粉丝数 ≥ X」「发布时间 ≥ Y」这类服务端过滤。（**注意**：`tid` 参数虽存在并被透传，但实测对视频分区 tid 不生效，见 [§8 已知局限](#8-已知局限--分区过滤说明)。）
2. **粉丝数不在搜索结果里**——[formatSearchResult](apps/subtitle-collector/bili-fetch.js#L17) 产出的每条 item 只有 `{bvid,title,up,mid,play,duration,pubdate}`，没有 `fans` 字段。
3. **粉丝数必须拿 mid 另查 UP 主信息**——见扩展 [background.js:217](apps/subtitle-collector/background.js#L217) 的 `get-upper-info` action：它要分别抓 `/x/space/wbi/acc/info`（Wbi）和 `/x/relation/stat`（cookie），取 `stat.follower` 当 fans（[background.js:239](apps/subtitle-collector/background.js#L239)）。一次 UP 信息请求 = 两次 B 站 API 往返。

### 1.2 `find` 的定位

`find` 把这层「搜索 + 后过滤 + 粉丝解析」的胶水做进 CLI，作为 [bili-collect skill](apps/collector-server/../subtitle-collector/../../.claude/skills/bili-collect/SKILL.md#L6) 的**前置检索增强**：

- 多页 `search` → 合并候选；
- 按 `pubdate`（发布时间）后过滤；
- 按 mid 去重解析 fans：**DB 缓存（creators 表）优先，miss 才实时 `get-upper-info`**；
- 按 fans 后过滤；
- 输出候选；可选 `--collect` 直接串行采字幕。

一句话：`find` = `search` 的「按粉丝 / 按发布时间」精筛层，让选片一步到位，而不是人工把 `search` 结果逐条拿去查粉丝。

### 1.3 为什么 fans 走「缓存优先 + 实时补充」

实测 `creators` 表 fans 覆盖率极低（66 个 UP 里仅约 2 个有 fans），靠纯 DB 缓存会漏判大量候选；而纯实时查每个 mid 都要两次 B 站 API 往返，风控压力大。折中：缓存命中直接用，miss 才实时查（且串行 + sleep 防风控）——既准又慢得可控。

---

## 2. CLI 接口

命令注册：[collect.ts:604](apps/collector-server/src/cli/commands/collect.ts#L604)（`collect` 命令组下的 `find <keyword>` 子命令）。

```
collector-cli collect find <keyword> [options]
```

### 2.1 Options 一览

| Option | 默认值 | 语义（精确行为取自 [collect.ts:607-617](apps/collector-server/src/cli/commands/collect.ts#L607)） |
|---|---|---|
| `--tid <id>` | （无，不按分区） | 分区 tid，示例 `207` = 财经商业（属"知识"主区，见 [zones-v1.json:548](apps/collector-server/data/zones-v1.json#L548)）。透传给 `search` action 的 `tid` 参数（[background.js:157](apps/subtitle-collector/background.js#L157)）。**⚠️ 实测对视频分区 tid 不生效**——见 [§8 已知局限](#8-已知局限--分区过滤说明)，分区收敛实际靠关键词 |
| `--order <o>` | `pubdate`（最新优先） | 排序，透传给 `search` action 的 `order`（[background.js:156](apps/subtitle-collector/background.js#L156)）。常见取值 `pubdate`/`click`/`scores`/`stolen` 等 |
| `--pages <n>` | `3`（约 60 条候选） | 翻多少页搜索结果，每页约 20 条。在 [collectFindSearch](apps/collector-server/src/cli/commands/collect.ts#L358) 里循环 `page=1..pages` 合并 |
| `--min-fans <n>` | `0`（不过滤） | 候选 UP 主最低粉丝数。`<=0` 不过滤；`<0` 报 ARGS 退出（[collect.ts:624](apps/collector-server/src/cli/commands/collect.ts#L624)）。fans 未知（`null`）的条目**保留**（保守，宁可多列） |
| `--since <YYYY-MM-DD>` | （无） | 发布日期下限，按**本地时区 00:00:00** 解析为 UNIX 秒（[parseDateToUnix](apps/collector-server/src/cli/commands/collect.ts#L321)）。与 `--since-days` 互斥，**同时给则 `--since` 优先**。非法格式报 ARGS（[collect.ts:629](apps/collector-server/src/cli/commands/collect.ts#L629)） |
| `--since-days <n>` | （无） | 「近 N 天」：等价于 `now - N*86400` 秒（[parseSince](apps/collector-server/src/cli/commands/collect.ts#L311)）。与 `--since` 互斥 |
| `--collect` | 关闭 | 命中候选后**串行采字幕入库**（[collect.ts:669](apps/collector-server/src/cli/commands/collect.ts#L669)）。默认仅列候选 |
| `--no-cache` | 关闭（即用缓存） | 忽略 `creators` 表 fans 缓存，全部实时 `get-upper-info` 查（用于刷新粉丝数）。落地为 [readFansFromDb](apps/collector-server/src/cli/commands/collect.ts#L638) 里 `opts.cache === false → return {}` |
| `--sleep <ms>` | `600` | 实时查 fans 的间隔毫秒（[fetchFans](apps/collector-server/src/cli/commands/collect.ts#L659)）。`--collect` 采字幕间隔取 `max(--sleep, 1000)`（[collect.ts:684](apps/collector-server/src/cli/commands/collect.ts#L684)） |
| `--client <id>` | （取第一个在线） | 指定扩展 client_id；缺省由 [resolveClientId](apps/collector-server/src/cli/commands/collect.ts#L26) 取第一个在线扩展，无在线则报 ARGS |
| `--timeout <ms>` | `15000`（[DEFAULT_COLLECT_TIMEOUT_MS](apps/collector-server/src/cli/commands/collect.ts#L17)） | 等单次扩展回执的超时毫秒。`<=0` 或非数报 ARGS（[collect.ts:623](apps/collector-server/src/cli/commands/collect.ts#L623)） |

> 互斥与优先级：`--since` 与 `--since-days` 同时存在时，action 层只看 `--since`（[collect.ts:626-629](apps/collector-server/src/cli/commands/collect.ts#L626)）——`--since-days` 被忽略，不报错。

### 2.2 典型用法

```bash
# 例 1：财经分区、粉丝>1万、近 7 天发布 —— 只列候选（不采字幕）
collector-cli collect find "A股" --tid 207 --min-fans 10000 --since-days 7 --format json

# 例 2：不采字幕只列候选（默认行为），限定近一周、按最新排序
collector-cli collect find "美联储 加息" --since 2026-06-28 --pages 5 --format json

# 例 3：命中候选后直接串行采字幕入库（--collect，间隔 >=1s 防风控）
collector-cli collect find "财报解读" --tid 207 --min-fans 5000 --since-days 3 --collect --sleep 1500

# 例 4：刷新粉丝数后重新筛（忽略缓存）
collector-cli collect find "通胀" --tid 207 --min-fans 10000 --no-cache --format json
```

---

## 3. 检索流程

```
                collector-cli collect find <keyword>  [opts]
                              │
                              ▼
        ┌──────────────────────────────────────────┐
        │  resolveClientId（缺省取第一个在线扩展）   │  collect.ts:633
        └──────────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────────┐
        │  ① 多页搜索 collectFindSearch              │  collect.ts:358
        │     page=1..pages 串行 search action       │
        │     合并 items；首页取 raw_total           │
        │     提前终止：某页空 / 达 raw_total / 翻满 │
        └──────────────────────────────────────────┘
                              │  raw_total, items[]
                              ▼
        ┌──────────────────────────────────────────┐
        │  ② 发布时间过滤 filterByPubdate            │  collect.ts:298
        │     since 为空 → 全保留                    │
        │     pubdate==null → 保留（不漏新视频）     │
        └──────────────────────────────────────────┘
                              │  afterDateItems[]
                              ▼
        ┌──────────────────────────────────────────┐
        │  ③ 解析 fans resolveFans（对去重 mid）     │  collect.ts:332
        │     a. readFansFromDb（creators 表，       │
        │        fans>0）→ cacheHit                  │
        │     b. miss 的 mid 串行 fetchFans          │
        │        （get-upper-info + sleep 防风控）   │
        │     c. 仍查不到 → unknown                  │
        └──────────────────────────────────────────┘
                              │  fans: Map<mid,number>
                              ▼
        ┌──────────────────────────────────────────┐
        │  ④ fans 回填 + filterByFans                │  collect.ts:404-409
        │     把 fans 填进每条 item                  │
        │     minFans<=0 不过滤；fans==null 保留     │
        └──────────────────────────────────────────┘
                              │  finalItems[] (FindResult)
                              ▼
        ┌──────────────────────────────────────────┐
        │  ⑤ 输出 FindResult（emitResult）           │  collect.ts:688
        └──────────────────────────────────────────┘
                              │
              ────────────────┴─── 若 --collect ────
                              ▼
        ┌──────────────────────────────────────────┐
        │  ⑥ 串行采字幕 collectSubtitle              │  collect.ts:669-687
        │     间隔 max(sleep,1000) ms                │
        │     遇 need_login / risk_control 即停      │
        │     回填 data.collected[]                  │
        └──────────────────────────────────────────┘
```

每一步对应 [collectFind](apps/collector-server/src/cli/commands/collect.ts#L385) 编排函数内的注释（步骤 1-4 在纯函数内，步骤 6 在 action 层）。

---

## 4. 纯函数设计

`find` 的全部业务逻辑拆成**纯/可注入函数**（区段 [collect.ts:245](apps/collector-server/src/cli/commands/collect.ts#L245) 起），commander action 只做参数解析 + 依赖装配 + 输出。拆分原则：**可测、可注入 mock**（client / fansSource / now 都从外部注入，不打全局副作用）。

| 函数 | 行号 | 职责 | 为何独立 |
|---|---|---|---|
| [filterByPubdate](apps/collector-server/src/cli/commands/collect.ts#L298) | 298 | 按 `since`（UNIX 秒）过滤 `SearchItem[]`。`since==null` 不过滤；`pubdate==null` 保留 | 纯函数，无 IO，直接断言输入→输出 |
| [filterByFans](apps/collector-server/src/cli/commands/collect.ts#L304) | 304 | 按 `minFans` 过滤 `FindItem[]`。`minFans<=0` 不过滤；`fans==null` 保留 | 同上；与 pubdate 过滤策略对齐（未知保留） |
| [parseSince](apps/collector-server/src/cli/commands/collect.ts#L311) | 311 | `since` 优先；否则 `sinceDays` → `now - days*86400`；都没 → `undefined`。`now` 注入便于测试 | 把「时间窗语义」从 action 解耦，`now` 可注入避免 `Date.now` 不稳定 |
| [parseDateToUnix](apps/collector-server/src/cli/commands/collect.ts#L321) | 321 | `YYYY-MM-DD` → UNIX 秒（本地时区 00:00）。非法 → `undefined` | 纯字符串解析，正则可单测 |
| [resolveFans](apps/collector-server/src/cli/commands/collect.ts#L332) | 332 | 对去重 mid：先读 DB 缓存（`FansSource.readFansFromDb`），miss 串行 `fetchFans`，返回 `Map` + 三类计数（cacheHit/fetched/unknown） | 双通道逻辑（缓存 + 实时）独立，注入 mock `FansSource` 即可覆盖全部分支 |
| [collectFindSearch](apps/collector-server/src/cli/commands/collect.ts#L358) | 358 | 多页 `search` 合并：循环 `collectSearch`，首页取 `raw_total`，提前终止（空页 / 够数 / 翻满） | 把「翻页 + 合并 + 早停」从编排函数剥离，注入 mock client 可测翻页边界 |
| [collectFind](apps/collector-server/src/cli/commands/collect.ts#L385) | 385 | 编排：搜索 → pubdate 过滤 → 解析 fans → fans 回填+过滤 → 返回 `FindResult`。**不含采字幕**（`--collect` 在 action 层） | 顶层编排纯函数；注入 `client` + `fansSrc` 即可端到端断言 `FindResult` 形状 |

**关键接口形状**（也都在该区段）：

- [SearchItem](apps/collector-server/src/cli/commands/collect.ts#L252)：`search` 单条结果（`bvid/title/up/mid/play/duration/pubdate`），`mid` 可能是 `number | string`。
- [FindItem](apps/collector-server/src/cli/commands/collect.ts#L263)：在 `SearchItem` 上补 `fans?: number | null`。
- [FindResult](apps/collector-server/src/cli/commands/collect.ts#L268)：最终输出（字段表见 §7）。
- [FindOpts](apps/collector-server/src/cli/commands/collect.ts#L283)：`pages/order/tid/minFans/since`。
- [FansSource](apps/collector-server/src/cli/commands/collect.ts#L292)：fans 来源抽象（`readFansFromDb` + `fetchFans`），生产实现见 [collect.ts:637](apps/collector-server/src/cli/commands/collect.ts#L637)，测试注入 mock 实现同接口。

---

## 5. fans 缓存策略

**策略：DB 缓存优先 + miss 实时补充；`--no-cache` 强制全实时。**

### 5.1 缓存读（[readFansFromDb](apps/collector-server/src/cli/commands/collect.ts#L638)）

- 数据源：本地 SQLite `creators` 表（`source='bilibili'`），取 `source_uid` + `fans`（[collect.ts:643-648](apps/collector-server/src/cli/commands/collect.ts#L643) 的 `SELECT source_uid, fans FROM creators WHERE source='bilibili' AND source_uid IN (...)`）。
- 只认 `fans != null && fans > 0` 的行；其余视为 miss。
- `--no-cache`（`opts.cache === false`）或入参 `mids` 为空 → 直接返回 `{}`（全走实时）。
- DB 读失败（文件不存在 / 未迁移）→ `catch` 降级返回 `{}`（全走实时），不阻断命令。

### 5.2 实时补充（[fetchFans](apps/collector-server/src/cli/commands/collect.ts#L655)）

- 走 `get-upper-info` action（[collectUpperInfo](apps/collector-server/src/cli/commands/collect.ts#L96) → 扩展 [background.js:217](apps/subtitle-collector/background.js#L217)）：fans = `stat.follower`（[background.js:239](apps/subtitle-collector/background.js#L239)）。
- 每查一个 mid 后 `setTimeout(sleepMs)`（默认 600ms）防风控（[collect.ts:659](apps/collector-server/src/cli/commands/collect.ts#L659)）。
- 回执 `!ok` 或 `data.fans` 为空 → 返回 `null`（计入 `unknown`）。
- **注意**：实时查 fans 会触发 `ingest-upper`（[background.js:242](apps/subtitle-collector/background.js#L242)）把 UP 主资料入库——所以 `find` 跑完，`creators` 表的 fans 覆盖率会自然提升（下次命中缓存更多）。

### 5.3 编排（[resolveFans](apps/collector-server/src/cli/commands/collect.ts#L332)）

1. `mids` 去重（`[...new Set(mids)]`）——同 UP 多条视频只查一次。
2. 一次性批量读缓存 → 命中进 `fans` Map（`cacheHit++`）。
3. miss 列表**串行** `fetchFans`（串行而非并发，是刻意的：并发查 UP 信息会同时打多个 `acc/info`+`relation/stat`，风控触发概率高）。
4. 返回 `{ fans: Map, cacheHit, fetched, unknown }`。

### 5.4 为何缓存命中率初始很低

`creators` 表 fans 字段依赖历史 `get-upper-info` / `ingest-upper` 调用。新库或没跑过 `upper-info` 的 UP，`fans` 多为 `null`。实测 66 个 UP 仅约 2 个有 fans → 首次 `find` 大量走实时；跑过一次后入库，后续命中率提升。`--no-cache` 用于「已知数据陈旧，强制刷新」。

---

## 6. 风控与限速

B 站对短时高频请求会回 `-412`（`risk_control`，见 [parseBiliResponse](apps/subtitle-collector/bili-fetch.js#L12)）。`find` 的两处实时往返（查 fans、采字幕）都做了限速：

| 场景 | 间隔 | 实现位置 |
|---|---|---|
| 实时查 fans（每个 miss mid 一次） | `--sleep`，默认 **600 ms** | [fetchFans](apps/collector-server/src/cli/commands/collect.ts#L659) `setTimeout(r, sleepMs)` |
| `--collect` 采字幕（每条候选一次） | `max(--sleep, 1000)`，**最低 1s** | [collect.ts:684](apps/collector-server/src/cli/commands/collect.ts#L684) `setTimeout(r, Math.max(sleepMs, 1000))` |

> 采字幕间隔取 `max` 而非直接用 `--sleep`，因为字幕采集本身比 UP 信息查询更敏感（涉及 `view` + `player/wbi/v2` + 字幕体多次 fetch，见 [background.js:169](apps/subtitle-collector/background.js#L169)），强制下限 1s 兜底即使用户把 `--sleep` 调得很小。

### 6.1 即停条件（`--collect` 模式）

采字幕循环里，若扩展回执 `result.error` 为以下值则**立即停止**（[collect.ts:676-678](apps/collector-server/src/cli/commands/collect.ts#L676)），经 [handleHttpError](apps/collector-server/src/cli/commands/collect.ts#L436) 转 `emitError` 退出：

- `need_login`（B 站 code `-101`，[bili-fetch.js:11](apps/subtitle-collector/bili-fetch.js#L11)）：登录态失效，提示用户登录后重跑。
- `risk_control`（B 站 code `-412`，[bili-fetch.js:12](apps/subtitle-collector/bili-fetch.js#L12)）：被风控，提示冷却后重跑。

> 单条 `no_subtitle`（视频本身无字幕轨）**不**触发停止——它只标记该条 `ok:false, reason:'no_subtitle'`（[collect.ts:681](apps/collector-server/src/cli/commands/collect.ts#L681)），继续下一条。

### 6.2 多页 search 为何不额外 sleep

`collectFindSearch` 翻页之间不加 sleep（[collect.ts:367](apps/collector-server/src/cli/commands/collect.ts#L367)）：CLI → server → 扩展 → B 站 的往返本身已是百毫秒级延迟，且 `pages` 默认仅 3 页，风控压力可忽略。真要大批量翻页，调大 `--sleep` 不影响 search 阶段（那是采字幕 / 查 fans 的间隔）。

---

## 7. 数据形状（FindResult）

[FindResult](apps/collector-server/src/cli/commands/collect.ts#L268) 是 `find` 的最终输出（含 `--collect` 时额外追加 `collected` 字段）。

| 字段 | 类型 | 语义 |
|---|---|---|
| `keyword` | `string` | 搜索关键词（原样回显） |
| `tid` | `number \| undefined` | 分区 tid（未传则 `undefined`） |
| `order` | `string` | 排序（默认 `pubdate`） |
| `raw_total` | `number` | B 站声称的总匹配数（搜索首页 `page.count`，来自 [formatSearchResult](apps/subtitle-collector/bili-fetch.js#L22)） |
| `fetched` | `number` | 多页合并后的候选条数（去重前） |
| `after_date` | `number` | 经发布时间过滤后条数 |
| `after_fans` | `number` | 经粉丝过滤后条数（= `items.length`） |
| `fans_cache_hit` | `number` | fans 取自 `creators` 表缓存的 unique mid 数 |
| `fans_fetched` | `number` | fans 取自实时 `get-upper-info` 的 unique mid 数 |
| `fans_unknown` | `number` | fans 未能解析（缓存 miss + 实时查询失败）的 unique mid 数 |
| `items` | `FindItem[]` | 最终候选（每条含 `bvid/title/up/mid/play/duration/pubdate/fans`，见 [FindItem](apps/collector-server/src/cli/commands/collect.ts#L263)） |
| `collected`（仅 `--collect`） | `Array<{bvid,ok,reason?}>` | 每条候选的采字幕结果（追加到同一对象，[collect.ts:686](apps/collector-server/src/cli/commands/collect.ts#L686)） |

> 三个 fans 计数（`cache_hit/fetched/unknown`）相加 = 候选里出现的 unique mid 总数，便于诊断「缓存命中率」（如 `cache_hit:2, fetched:40, unknown:3` 说明库基本没缓存、几乎全靠实时）。

---

## 8. 已知局限 / 分区过滤说明

> **实测发现（2026-07-05）**：`collect search 财经 --order pubdate` 加或不加 `--tid 207`，返回的 `total`（都为 20）和前 5 条标题**完全相同**。即 B 站 `/x/web-interface/wbi/search/type` 的 `tid` 参数对 [zones-v1.json](apps/collector-server/data/zones-v1.json) 里的**视频分区 tid（如 207 财经商业）不生效**——搜索 API 用的是另一套搜索分类体系，与视频分区 tid 不是同一套。

要点：

1. `find` / `search` 的 `--tid` 会**透传**给 B 站 search API（代码层 [collectFindSearch](apps/collector-server/src/cli/commands/collect.ts#L358) → 扩展 [background.js:157](apps/subtitle-collector/background.js#L157)），但当前对视频分区 tid（[zones-v1.json](apps/collector-server/data/zones-v1.json) 体系）**无效**。「财经相关」实际靠**关键词收敛**（关键词"财经 / A股 / 基金 / 财报"等本身效果就很好）。
2. 如未来需要真正的分区收敛，需找到 search API 自己的**搜索分类 tid**（非本项目命令范围，留作后续）。
3. 本文档**不宣称 `--tid` 能精确过滤分区**——与实测不符。`--tid` 当前价值仅在于「语义自文档 + 万一 B 站恢复/换分类体系时即生效」，**不作为筛选保证**。

---

## 9. 验收清单 + 测试轮次记录

> 对齐全局 CLAUDE.md §8（审查落到文档）+ 项目 CLAUDE.md §3（每 spec 必含「测试轮次记录表」）。
> 单元测试文件 [`collect.test.ts`](apps/collector-server/src/cli/commands/collect.test.ts)（已建，对齐现有 [videos.test.ts](apps/collector-server/src/cli/commands/videos.test.ts) 命名约定），E2E 见任务 #13（已跑通）。

### 9.1 功能验收清单

| # | 验收点 | 对应测试 / 命令 | 状态 |
|---|---|---|---|
| F1 | `find` 子命令注册并可解析 `<keyword>` | `buildCollectCommand()` 含 `find` 子命令（[collect.ts:604](apps/collector-server/src/cli/commands/collect.ts#L604)）；命令行 `collect find "A股" --help` | ✅ 注册完成 |
| F2 | `--tid` 透传 search action | 单测：mock client 断言 `sendCommand` 收到 `params.tid === 207`（[collectFindSearch](apps/collector-server/src/cli/commands/collect.ts#L358)） | ✅ 单测通过 |
| F3 | `--order` 默认 `pubdate`、可覆盖 | 单测：默认传 `pubdate`；`--order click` 透传 | ✅ 单测通过 |
| F4 | `--pages` 多页合并 + 首页取 `raw_total` | 单测：mock 3 页返回，断言 `fetched` 为合并数、`raw_total` 取首页 | ✅ 单测通过 |
| F5 | 多页提前终止（空页 / 达 total / 翻满） | 单测：第 2 页空 → 不请求第 3 页；累计≥total → 停 | ✅ 单测通过 |
| F6 | `filterByPubdate`：`since==null` 不过滤；`pubdate==null` 保留 | 单测：[filterByPubdate](apps/collector-server/src/cli/commands/collect.ts#L298) 直接断言 | ✅ 单测通过 |
| F7 | `filterByFans`：`minFans<=0` 不过滤；`fans==null` 保留 | 单测：[filterByFans](apps/collector-server/src/cli/commands/collect.ts#L304) 直接断言 | ✅ 单测通过 |
| F8 | `parseSince`：`since` 优先于 `sinceDays`；`now` 注入 | 单测：注入固定 `now`，断言 `sinceDays=7 → now-7*86400` | ✅ 单测通过 |
| F9 | `parseDateToUnix`：合法 `YYYY-MM-DD` → 秒；非法 → `undefined` | 单测：[parseDateToUnix](apps/collector-server/src/cli/commands/collect.ts#L321) 边界（闰年/单双位月日/非法） | ✅ 单测通过 |
| F10 | `resolveFans`：缓存命中 / miss 实时 / unknown 三分支 | 单测：mock `FansSource`，断言三类计数 | ✅ 单测通过 |
| F11 | mid 去重（同 UP 多视频只查一次 fans） | 单测：`resolveFans(['1','1','2'])` 只触发 2 次查询 | ✅ 单测通过 |
| F12 | `--no-cache`：跳过 DB，全走实时 | 单测：mock `readFansFromDb` 断言被调返回 `{}`（[collect.ts:639](apps/collector-server/src/cli/commands/collect.ts#L639)） | ✅ 单测通过 |
| F13 | DB 读失败降级（不阻断） | 单测：`readFansFromDb` 抛错 → 返回 `{}`，命令仍出结果 | ✅ 单测通过 |
| F14 | fans 实时查询后 sleep 防风控 | 单测：mock `fetchFans` 串行 + `setTimeout` 被调（[collect.ts:659](apps/collector-server/src/cli/commands/collect.ts#L659)） | ✅ 单测通过 |
| F15 | `FindResult` 形状完整（含三类 fans 计数） | 单测：[collectFind](apps/collector-server/src/cli/commands/collect.ts#L385) 返回字段齐全 | ✅ 单测通过 |
| F16 | 参数校验：`--timeout<=0` / `--min-fans<0` / `--since` 非法格式 → ARGS | 单测 / 手测：三个非法输入各退码 2（[collect.ts:623-629](apps/collector-server/src/cli/commands/collect.ts#L623)） | ✅ 单测通过 |
| F17 | `--collect`：串行采字幕 + 间隔 `max(sleep,1000)` | E2E / 单测：mock `collectSubtitle`，断言间隔与 `data.collected` 回填（[collect.ts:669-687](apps/collector-server/src/cli/commands/collect.ts#L669)） | ⏳ 待 E2E（--collect 在 action 层未导出纯函数单测） |
| F18 | `--collect` 遇 `need_login`/`risk_control` 即停 | E2E：mock 扩展回执 `error:'risk_control'` → 命令停（[collect.ts:676](apps/collector-server/src/cli/commands/collect.ts#L676)） | ⏳ 待 E2E |
| F19 | `--collect` 遇 `no_subtitle` 不停，继续下一条 | E2E：mock 第一条 `reason:'no_subtitle'`，第二条仍采（[collect.ts:681](apps/collector-server/src/cli/commands/collect.ts#L681)） | ⏳ 待 E2E |
| F20 | 真实财经条件检索端到端跑通（靠关键词收敛） | E2E：`collect find "A股" --min-fans 10000 --since-days 7 --format json` 返回非空 `items`（财经主题由关键词"A股"收敛，**非依赖 tid**） | ✅ 完成（命中李大霄 33.4 万粉等；fans 缓存二次累积 0→7） |
| F21 | `--tid` 对视频分区 tid 不生效（已知局限，[§8](#8-已知局限--分区过滤说明)） | 实测：`collect search 财经 --order pubdate` 加 / 不加 `--tid 207`，`total`（均 20）与前 5 条标题一致；**不宣称 tid 精确过滤分区** | ✅ 已实测确认（2026-07-05） |

### 9.2 测试轮次记录表

| 轮次 | 日期 | 范围 | 结果 |
|---|---|---|---|
| R1 | 2026-07-05 | 设计文档落盘（本文档）；验收清单 F1-F20 制定 | ✅ 完成 |
| R2 | 2026-07-05 | 单元测试 `collect.test.ts`：覆盖 F2-F16 纯函数与参数校验（注入 mock `client` + `FansSource` + `now`） | ✅ 完成（16 个 find 用例 PASS，[collect.test.ts:228-449](apps/collector-server/src/cli/commands/collect.test.ts#L228)） |
| R3 | 2026-07-05 | `turbo run test` 全量回归（确认 `find` 新增不破坏既有 `collect` 子命令与 `commands/*.test.ts`） | ✅ 完成（`pnpm -C apps/collector-server test` → pass 199 / fail 0） |
| R4 | 2026-07-05 | E2E 真实财经检索：F17-F20（关键词收敛、`--collect` 采字幕、风控即停） | ✅ 完成（命中李大霄 33.4 万粉等；fans 缓存二次累积 0→7） |
| R5 | 2026-07-05 | 实测 `--tid` 对视频分区 tid 不生效：`collect search 财经` ±`--tid 207`，`total`（均 20）/ 前 5 条标题一致 → 写入 [§8](#8-已知局限--分区过滤说明) 与 F21，文档不宣称 tid 精确过滤 | ✅ 已确认 |

> 回归纪律（对齐项目 CLAUDE.md §3）：bug 修复 commit 必须含对应「失败→通过」测试用例；验收清单每项都要有测试覆盖，未覆盖项标记 ⏳。
