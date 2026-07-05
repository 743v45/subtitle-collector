# 字幕正文检索（`sub search` + `videos list --subtitle-q`）设计文档

> 字幕（subtitle）系统的**内容检索**入口。**不是弹幕（danmaku）**。
> 目标：让 AI 用最省 token 的方式，按「字幕里讲过什么」检索已采集的视频并定位到具体片段。
> 配套命令：`collector-cli videos list --subtitle-q <kw>`（视频级命中，对齐 HTTP）+ `collector-cli sub search <kw>`（片段级命中，核心新增）。

---

## 1. 背景与动机

### 1.1 痛点：内容检索「底层有、入口缺、片段无」

项目是字幕采集系统，最有价值的事是回答「哪些视频讲过 X」「某 UP 在哪一期、哪个时间点提过 Y」。但现状是三层错位：

| 层 | 字幕正文检索现状 | 证据 |
|---|---|---|
| DB 层 | ✅ **已实现**（视频级命中） | [VideoFilter.subtitle_q](apps/collector-server/src/db/advanced.ts#L16) + [buildVideoWhere](apps/collector-server/src/db/advanced.ts#L120) 的 `sv.payload LIKE '%kw%'` EXISTS 子查询 |
| HTTP 层 | ✅ **已暴露** | [parseVideoFilter](apps/collector-server/src/http/filter.ts#L39) 解析 `subtitle_q` query param → `GET /api/videos?subtitle_q=通胀` 已可用 |
| CLI 层 | ❌ **漏暴露** | [VideosListOpts](apps/collector-server/src/cli/commands/videos.ts#L43) 与 commander options 均无 `--subtitle-q`，AI 走 CLI 用不了 |
| 片段级返回 | ❌ **三层全无** | 上述 SQL 只能判断「该视频字幕里出现过 kw」，**不返回出现的时间点/上下文**——AI 拿不到「在第几分钟提到」 |

### 1.2 为什么「片段级」是省 token 的关键

字幕 payload 极长：一条 [subtitle_versions.payload](apps/collector-server/src/db/schema.sql#L68) 是整个视频的字幕 JSON（`body:[{from,to,content}, …]`，结构见 [subtitleFormat.ts:9](apps/collector-server/src/cli/subtitleFormat.ts#L9)）。把全文塞给 AI 必爆 token。

「省 token」的全部杠杆在**不回全文、只回命中片段**：

- 视频级命中（`videos list --subtitle-q`）：只回命中视频的**元信息清单**（不带 payload）——AI 先知道「有哪些视频提到 X」。
- 片段级命中（`sub search`）：在视频级之上，再回**每个命中点的时间戳 + ±N 秒上下文片段**——AI 直接拿到「X 在第几分钟、前后讲了啥」，按需再用 [versions get](apps/collector-server/src/cli/commands/versions.ts#L42) 下钻整条。

数据规模也印证：当前仅 108 视频 / 460 字幕版本 / 17MB（见探索结论），SQL 性能不是瓶颈，**省 token 的杠杆全在「字段裁剪 + 分层 + 片段」**。

### 1.3 两条命令的分工（避免 AI 用错）

| 命令 | 回答的问题 | 输出 | 适用 |
|---|---|---|---|
| `videos list --subtitle-q X` | 「哪些视频的字幕提到 X？」 | 命中视频元信息清单（无片段、无 payload） | 只要清单、不关心具体时间点 |
| `sub search X` | 「X 在哪个视频的哪一分提到？前后讲了啥？」 | 命中视频 + 每个命中点的时间戳 + 上下文片段 | 要定位、要上下文（AI 主力场景） |

两者互补：先 `sub search` 定位片段，必要时 `versions get <id>` 取整条字幕（[convertSubtitle](apps/collector-server/src/cli/subtitleFormat.ts#L111) 转 `txt` 最省）。

---

## 2. CLI 接口

### 2.1 第一层：`videos list` 补 `--subtitle-q`（对齐 HTTP，极小改动）

在 [buildVideosCommand](apps/collector-server/src/cli/commands/videos.ts#L170) 的 `list` 子命令上新增一个 option，透传到 [ListFilter.subtitle_q](apps/collector-server/src/db/advanced.ts#L16)：

```
collector-cli videos list [--q ...] --subtitle-q <text> [--creator/--tname/--tag/...]
```

- 新 option：`--subtitle-q <text>`（字幕正文关键词模糊匹配，命中 `subtitle_versions.payload`）。
- [VideosListOpts](apps/collector-server/src/cli/commands/videos.ts#L43) 加 `subtitleQ?: string`，[videosList](apps/collector-server/src/cli/commands/videos.ts#L64) 映射时 `subtitle_q: opts.subtitleQ`。
- 输出不变：仍是 `{total,page,size,items}`，复用全局 `--format ndjson|csv|table`（[emitResult](apps/collector-server/src/cli/output.ts#L106) 已自动剥外壳逐条输出）。
- 与其他过滤项可叠加（如 `--subtitle-q 通胀 --tname 财经商业 --min-view 10000`）。

### 2.2 第二层：新命令 `sub search`（片段级，核心新增）

新顶层命令组 `sub`（subtitle 内容层操作，与 `videos` 元信息层、`versions` 单条版本层并列），注册在 [main.ts](apps/collector-server/src/cli/main.ts#L82) 的 `main()` 内 `program.addCommand(buildSubCommand())`。

```
collector-cli sub search <keyword> [options]
```

#### Options

| Option | 默认 | 语义 |
|---|---|---|
| `<keyword>`（必填位置参数） | — | 字幕正文检索词。默认大小写不敏感子串匹配（对齐 SQL `LIKE` 语义） |
| `--regex` | 关闭 | 把 `<keyword>` 当 JavaScript 正则源串匹配（如 `--regex "通胀\|CPI"`）。关闭时是纯子串 |
| `--case-sensitive` | 关闭 | 区分大小写（默认不区分，对齐 LIKE） |
| `--ctx <秒>` | `10` | 每个命中点的上下文时间窗：命中段 ±N 秒内的相邻字幕段拼成 context |
| `--max-snippets-per-video <n>` | `3` | 单个视频最多回几个命中片段（按命中顺序取前 N） |
| `--max-snippets <n>` | `30` | 全局命中片段总数上限（跨视频累计，防爆 token） |
| `--max-videos <n>` | `100` | 最多扫描多少个候选视频（先经视频级过滤后的候选池上限） |
| `--all-tracks` | 关闭（只搜默认轨） | 搜该视频所有轨；默认只搜默认轨（CC 中文 > AI 中文 > 英文 > 其他，见 [trackPriority](apps/collector-server/src/db/queries.ts#L38)） |
| `--full` | 关闭 | 回整条字幕（复用 [convertSubtitle](apps/collector-server/src/cli/subtitleFormat.ts#L111)，默认 `txt`）。默认只回片段 |
| `--plain` | 关闭 | 去掉 context 内每段的时间戳前缀只留纯文本；`from/to` 字段始终保留（结构化定位，token 开销极小） |
| 视频预筛（复用） | — | `--creator / --tid / --tname / --tag / --lang / --track-type / --has-subtitle / --since / --until / --min-view / --max-view / --min-duration / --max-duration`，语义同 `videos list`，作候选池预筛 |

> 全局 `--format json|ndjson|csv|table`、`--db`、`-q` 自动可用（[main.ts](apps/collector-server/src/cli/main.ts#L43) 全局选项）。

#### 典型用法

```bash
# 例 1：「通胀」在财经区视频里出现在哪几分
collector-cli sub search "通胀" --tname 财经商业 --format ndjson

# 例 2：正则匹配「通胀 或 CPI」，只要文本片段（去时间戳，最省）
collector-cli sub search "通胀|CPI" --regex --plain --max-snippets 20 --format ndjson

# 例 3：某 UP 的视频里提过「A股」的片段，每视频最多 2 条
collector-cli sub search "A股" --creator "李大霄" --max-snippets-per-video 2

# 例 4：定位到片段后，要整条字幕再下钻（二段式）
collector-cli sub search "美联储" --max-snippets 5        # 先拿命中 version id
collector-cli versions get <versionId> --format txt        # 再取整条
```

---

## 3. 检索流程（`sub search`）

```
            collector-cli sub search <keyword>  [opts]
                          │
                          ▼
        ┌────────────────────────────────────────────┐
        │  ① 候选池：listVideosFiltered(视频预筛)      │  复用 advanced.ts:174
        │     · 子串模式(默认)：+ subtitle_q=keyword  │  仅子串模式做 LIKE 预筛加速
        │       LIKE 预筛（⊇ JS 精确，不漏召回）        │  （安全论证见步骤①下方）
        │     · 正则模式(--regex)：不加 subtitle_q     │  元字符会破坏 LIKE 召回
        │       （元字符致 LIKE 失配 → 漏召回）        │
        │     截断到 maxVideos                        │
        └────────────────────────────────────────────┘
                          │  candidateVideoIds[]
                          ▼
        ┌────────────────────────────────────────────┐
        │  ② 取默认轨默认版本 payload：               │  复用 getVideoByDbId
        │     getVideoByDbId(id) → tracks[]           │  (advanced.ts:219) 的 is_default
        │     取 is_default track 的 is_default ver   │  标记；--all-tracks 则遍历全部
        │     getVersionPayload(versionId)            │  queries.ts:77
        └────────────────────────────────────────────┘
                          │  payload{body[]}
                          ▼
        ┌────────────────────────────────────────────┐
        │  ③ 精确匹配 matchBody(body, keyword, opts)  │  纯函数（本设计 §4）
        │     子串(默认)/正则(--regex)；大小写按 opt  │  返回命中段索引数组
        │     ⇒ 消除 SQL LIKE 的 JSON 噪声            │
        └────────────────────────────────────────────┘
                          │  hitIndices[]
                          ▼
        ┌────────────────────────────────────────────┐
        │  ④ 片段提取 extractSnippets(body, hits,     │  纯函数（本设计 §4）
        │     ctxSec, maxPerVideo)                    │  每命中点 ±ctxSec 贪心拼邻段
        │     ⇒ {from,to,content,context}            │  按 maxPerVideo 截断
        └────────────────────────────────────────────┘
                          │  snippets[]
                          ▼
        ┌────────────────────────────────────────────┐
        │  ⑤ 汇总 searchSubtitles（编排纯函数）       │  跨视频累计 maxSnippets 截断
        │     返回 SubtitleSearchResult               │  默认紧凑；--full 回整条
        └────────────────────────────────────────────┘
                          │
                          ▼
                   emitResult（output.ts:106）
```

> **为何子串模式下 LIKE 预筛安全**：子串模式下 `keyword` 若是某段 `content` 的子串，则必是整条 `payload` JSON 字符串的子串 ⇒ `LIKE '%keyword%'` 必命中，**不会漏召回**。反之 LIKE 命中不一定是 content 命中（可能命中 JSON 的数字/键名）——这种噪声由步骤 ③ JS 精确匹配兜底滤掉。
>
> **为何正则模式必须跳过 LIKE 预筛**：`--regex` 时 `keyword` 是正则源串（如 `通胀|CPI`），其元字符 `|` 在 SQL `LIKE` 里是字面量，`LIKE '%通胀|CPI%'` 几乎命中不了任何 payload → 会把候选池过滤空 → **漏召回**。故正则模式只用视频层预筛，候选池内全量扫 payload + JS 正则匹配（当前规模无压力；这是必须遵守的实现约束，见验收 F9 的反例）。

---

## 4. 纯函数设计（`sub search` 业务逻辑）

照抄 [collect.ts:245](apps/collector-server/src/cli/commands/collect.ts#L245) 起 `find` 的拆分原则：**可测、可注入 mock**（db / payloadSource 都从外部注入，不打全局副作用）。commander action 只做参数解析 + 依赖装配 + `emitResult`。新建文件 `apps/collector-server/src/cli/commands/sub.ts`。

| 函数 | 职责 | 为何独立 |
|---|---|---|
| `matchBody(body, keyword, opts)` | 在 `body[].content` 上做大小写不敏感子串（默认）/ 正则（`opts.regex`）匹配，返回命中段索引数组 | 纯函数，无 IO；正则编译错误在此抛，action 层转 ARGS |
| `extractSnippets(body, hitIndices, ctxSec)` | 对每个命中索引，按时间窗 ±ctxSec 贪心向前后吞并相邻段，产出 `{from,to,content,context}`（context = 窗口内邻段文本拼接，带各段起止秒） | 纯函数；上下文窗口语义独立可单测 |
| `searchSubtitles(db, opts)` | 编排：① 候选池（注入 db）→ ② 取默认轨 payload（注入 `payloadSource` 可 mock）→ ③ matchBody → ④ extractSnippets → ⑤ 跨视频累计截断 → 返回 `SubtitleSearchResult` | 顶层编排纯函数；注入 db + payloadSource 即可端到端断言结果形状 |

**关键接口形状**（都在 `sub.ts`，对齐现有 [FindItem/FindResult](apps/collector-server/src/cli/commands/collect.ts#L263) 命名风格）：

```ts
// 单个命中片段
interface SubtitleSnippet {
  from: number;          // 命中段起始秒（payload body 的 from）
  to: number;            // 命中段结束秒
  content: string;       // 命中段原文
  context: string;       // ±ctxSec 邻段拼接文本（默认带时间戳前缀；--plain 去前缀）
}

// 单个命中视频
interface SubtitleSearchItem {
  // video 元信息：刻意不含 pic / 封面 / 视频链接等媒体字段（AI 看不了且占 token —— 用户明确要求剔除）
  video: { id: number; source: string; source_vid: string; title: string;
           creator_name: string | null; duration: number | null; published_at: number | null };
  track: { id: number; lan: string | null; track_type: number | null };
  version: { id: number; origin: string };   // version id 供 versions get 下钻
  snippets: SubtitleSnippet[];
  full?: string;                             // 仅 --full：整条字幕文本
}

// 顶层结果
interface SubtitleSearchResult {
  keyword: string;
  regex: boolean;
  matched_videos: number;     // 命中视频数
  total_snippets: number;     // 片段总数（截断后）
  truncated: boolean;         // 是否因 maxSnippets 截断
  items: SubtitleSearchItem[];
}
```

**可注入依赖**：

```ts
// payload 来源抽象（生产实现走 getVersionPayload，测试注入 mock）
interface PayloadSource {
  // 给定视频 id，返回其默认轨（或所有轨，按 allTracks）的 {track, version, payload} 列表
  getPayloads(videoId: number, allTracks: boolean): Array<{ track: TrackInfo; version: VersionInfo; payload: unknown }>;
}
```

生产实现 `getPayloads`：`getVideoByDbId(db, id)` → 取 `is_default` track（或全部）→ 各取 `is_default` version id → `getVersionPayload(db, versionId)`。测试注入 mock `PayloadSource` 即可覆盖「无字幕」「无默认轨」「payload 结构异常」等分支，不碰真 DB。

---

## 5. 省 token 策略（核心目标）

| 杠杆 | 实现 | 默认 |
|---|---|---|
| **不回全文 payload** | `sub search` 默认只回片段；`--full` 才回整条（且复用 [convertSubtitle](apps/collector-server/src/cli/subtitleFormat.ts#L111) 转 `txt`，丢时间轴） | 默认片段 |
| **片段上限** | `--max-snippets`（全局）+ `--max-snippets-per-video`（单视频）双截断 | 30 / 3 |
| **上下文可控** | `--ctx <秒>` 控制每个片段带多少邻段 | 10s |
| **去时间戳** | `--plain` 去掉 context 内时间戳前缀（`from/to` 始终保留） | 默认 context 带前缀 |
| **默认轨只搜一条** | 默认不 `--all-tracks`，避免同视频多轨重复命中 | 默认轨 |
| **复用 ndjson/csv/table** | [emitResult](apps/collector-server/src/cli/output.ts#L106) 对含 `items[]` 的结果自动剥外壳逐条输出 | 推荐配 `--format ndjson` |
| **候选预筛** | LIKE 预筛 + 视频层过滤，缩小要扫 payload 的视频数 | 自动 |
| **剔除媒体字段** | `sub search` 输出强制不含 `pic`/封面/视频链接等媒体 URL（只留定位 key `id`/`source_vid` + 文本元信息）—— 用户明确要求 | 强制 |

> 给 AI 的推荐姿势（写进 [bili-collect skill](.claude/skills/bili-collect/SKILL.md) 或新 skill）：`sub search "<kw>" --plain --max-snippets 20 --format ndjson` —— 单行一片段、纯文本、无外壳，token 最省。需要时间定位时去掉 `--plain`；需要整条再 `versions get`。

---

## 6. 已知局限

1. **SQL `LIKE` 的 JSON 噪声**（[buildVideoWhere](apps/collector-server/src/db/advanced.ts#L120)）：`sv.payload LIKE '%kw%'` 是对整条 JSON 字符串匹配，纯英文短词（如 `content`/`from`/数字）可能命中 JSON 键名或时间戳数字而误判。
   - **`sub search` 规避**：步骤 ③ JS 对 `body[].content` 精确匹配，消除噪声。
   - **`videos list --subtitle-q` 不规避**：它直接用 LIKE，英文短词场景可能有假阳性；中文关键词无此问题（content 之外的 JSON 结构不含中文）。文档与 help 文案需提示。
2. **LIKE 通配符未转义**：关键词含 `%` / `_` / `"` 时行为未定义。`sub search` 的 JS 匹配不受影响（子串模式用 `String.includes`，正则模式用户自担责）。
3. **规模上限**：当前 108 视频，全扫 payload 无压力。正则模式（`--regex`）不做 LIKE 预筛，候选池更大，但当前规模仍可忽略。涨到几千条且高频检索时，LIKE 全扫 + JSON.parse 成本上升 → 届时升级 FTS5 虚拟表（预写方向，不在本期）。
4. **默认轨选择**：依赖 [trackPriority/versionPriority](apps/collector-server/src/db/queries.ts#L38)（CC 中文 > AI 中文 > 英文 > 其他；external > manual > asr）。`--all-tracks` 关闭时只搜默认轨，可能漏掉「默认轨是英文、但 AI 中文轨里提到了关键词」的情况。需要全面时用 `--all-tracks`（牺牲 token）。
5. **`stat.view` 缺值**：部分视频 `extra.stat` 为空（被动采集），`--min-view/--max-view` 对它们不命中（NULL 不参与比较），与 [videos list](apps/collector-server/src/cli/commands/videos.ts#L170) 行为一致。

---

## 7. 验收清单 + 测试轮次记录

> 对齐全局 CLAUDE.md（审查落到文档）+ 项目 CLAUDE.md §3（collector-server 用 `node --test --import tsx`，每 spec 必含「测试轮次记录表」）。
> 单元测试文件 `apps/collector-server/src/cli/commands/sub.test.ts`（对齐现有 [collect.test.ts](apps/collector-server/src/cli/commands/collect.test.ts) / [videos.test.ts](apps/collector-server/src/cli/commands/videos.test.ts) 命名约定）。

### 7.1 功能验收清单

| # | 验收点 | 对应测试 / 命令 | 状态 |
|---|---|---|---|
| F1 | `videos list --subtitle-q` 透传到 `ListFilter.subtitle_q` | 单测 + `videos list --subtitle-q --help` | ✅ `f4e4112` |
| F2 | `videos list --subtitle-q` 命中视频清单（不含 payload/pic） | 单测；E2E 实测 CLI 输出字段无 pic（CLI 走 listVideosFiltered 不经 HTTP enrichItems） | ✅ |
| F3 | `sub` 命令组注册；`sub search <keyword>` 可解析 | `buildSubCommand()` + `sub search --help`（24 options） | ✅ `232655c` |
| F4 | `matchBody`：子串默认大小写不敏感 | 单测 | ✅ `f25b2f2` |
| F5 | `matchBody`：`--regex` + 非法正则抛错 | 单测 | ✅ |
| F6 | `matchBody`：`--case-sensitive` | 单测 | ✅ |
| F7 | `extractSnippets`：±ctxSec 上下文窗口 + 边界 | 单测 | ✅ `59e1f11` |
| F8 | `extractSnippets`：`--max-snippets-per-video` 截断 | 单测 | ✅ |
| F9 | `searchSubtitles` 召回正确性：(a) 子串 LIKE 预筛 ⊇ JS 精确；(b) 正则模式**不加** LIKE 预筛 | 单测 F9a/F9b；spec review 独立推理确认 F9b 能抓住「正则误加预筛」bug | ✅ `cbfa852` |
| F10 | `--max-snippets` 全局截断 + `truncated:true` | 单测 | ✅ |
| F11 | 默认轨 vs `--all-tracks` | makeDbPayloadSource 的 allTracks 分支逻辑直接；setupSub 视频均单轨，**未专门断言 allTracks=true**；F12 间接覆盖 getPayloads 调用 | ⏳ 未专门覆盖 |
| F12 | 无字幕 / payload 异常 → 跳过不崩 | 单测 mock 异常 payloadSource | ✅ |
| F13 | `--full` 回整条（convertSubtitle 默认 txt） | 单测 | ✅ |
| F14 | `--plain` 片段去时间戳 | 单测 | ✅ |
| F15 | 参数校验：空 keyword / ctx<=0 / max-*<=0 / full-format / 非法正则 → ARGS | 手测 6 项退码 2 | ✅ `232655c` |
| F16 | 输出复用 emitResult：ndjson/csv/table 逐条 | E2E 实测三种格式均不报错（ndjson 最适合 AI，csv/table 把嵌套对象 JSON 串化） | ✅ |
| F17 | 真实数据 E2E：`sub search` 返回非空片段 | 真实库（17.8MB / 108 视频）：`videos list --subtitle-q 的` + `sub search 的/spec/AI` 均命中（如 video 1「AI 编程工程化」） | ✅ |
| F18 | 省 token 对照：片段 vs 整条 | 实测：`sub search spec --plain --max-snippets 3` = **1723 字符** vs `versions get 1`（整条）= **78399 字符**，片段约 **2.2%**（省 ~98% token） | ✅ |

### 7.2 测试轮次记录表

| 轮次 | 日期 | 范围 | 结果 |
|---|---|---|---|
| R1 | 2026-07-05 | 设计文档落盘 + F1-F18 制定 | ✅ |
| R2 | 2026-07-05 | `videos list --subtitle-q` 单测（F1-F2） | ✅ PASS（Task 1，commit `f4e4112`，12/12） |
| R3 | 2026-07-05 | matchBody / extractSnippets 纯函数（F4-F8） | ✅ PASS（Task 2/3，commit `f25b2f2` + `59e1f11`，11 用例） |
| R4 | 2026-07-05 | searchSubtitles 编排 + mock PayloadSource（F9-F14） | ✅ PASS（Task 4，commit `cbfa852` + `9a81495` 清理，20 用例含 F9b 关键回归） |
| R5 | 2026-07-05 | 回归 | ⚠️ 部分：`sub.test.ts` 20 + `videos.test.ts` 12 局部 PASS；全量 `pnpm test` 未跑（main 有并发在制品干扰，与本次无关） |
| R6 | 2026-07-05 | E2E 真实检索（F17）+ 省 token 对照（F18） | ✅ PASS（真实库命中；省 token 1723 vs 78399 ≈ 2.2%） |

> 实现 commits（`feat/subtitle-search` 分支废弃，按用户裁定留 main 并发）：`f4e4112`(T1) → `f25b2f2`(T2) → `59e1f11`(T3) → `cbfa852`(T4) → `9a81495`(T4 清理) → `232655c`(T5)。T6 = E2E + 文档同步（本节）。F11（allTracks）未专门覆盖，标记 ⏳。

> 回归纪律（对齐项目 CLAUDE.md §3）：bug 修复 commit 必须含对应「失败→通过」测试用例；验收清单每项都要有测试覆盖，未覆盖项标记 ⏳。

---

## 8. 实现拆分（供 writing-plans 拆任务 / agent teams 并发）

按可独立交付的粒度切分，便于并发：

1. **第一层 `--subtitle-q`**（独立，最小）：改 [videos.ts](apps/collector-server/src/cli/commands/videos.ts#L170)（option + opts 字段 + 映射）+ 补 [videos.test.ts](apps/collector-server/src/cli/commands/videos.test.ts) 用例。不依赖第二层。
2. **纯函数 `matchBody` + `extractSnippets`**（独立，无 IO）：新建 `sub.ts` 内的纯函数 + 单测。可先行。
3. **编排 `searchSubtitles` + `PayloadSource`**（依赖 2）：含生产 `getPayloads`（复用 getVideoByDbId + getVersionPayload）+ mock 测试。
4. **CLI 装配 `buildSubCommand`**（依赖 3）：commander options + 参数校验 + 注册到 [main.ts](apps/collector-server/src/cli/main.ts#L103)。
5. **输出适配**（依赖 4）：`--full/--plain` 分支 + emitResult 联调。
6. **E2E + 省 token 对照**（依赖 4）：真实库跑通，记录 R6。
7. **（可选）skill 封装**：把 `sub search` 推荐姿势写进 bili-collect skill 或新 skill，让 AI 知道检索节奏。

二期（不在本期，规模上来再做）：FTS5 虚拟表 + ingest 同步 + 回填脚本（替换 LIKE 全扫）。
