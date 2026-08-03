# YouTube 字幕采集 — 设计文档

> 状态：设计中 → 实现中 | 日期：2026-07-19 | 关联：[media-subtitle-collector-design.md](../2026-06-20-media-subtitle-collector-design.md)、[SUBTITLE_EXTRACTOR_DESIGN.md](../../../apps/subtitle-extractor/SUBTITLE_EXTRACTOR_DESIGN.md)

## 1. 概述与目标

让 `apps/subtitle-collector` 扩展从「YouTube 仅 logo 占位」升级为**真正采集 YouTube 视频官方字幕**（人工字幕 + asr 自动生成字幕 + 可选翻译轨），与 B 站采集**同构同体验**：全部语言轨、popup 复用 `platforms` 数据驱动展示、数据归一化后进**同一套** collector-server / collector-web。

**非目标（YAGNI，留后续）**：Whisper 转写（YouTube 绝大多数视频有官方字幕，且音轨有 signature decipher 大坑）、播放列表/频道批量订阅（属 server/web 调度层）、vtt 导出（维持 collector 现有 text/timestamp/srt）。

## 2. 技术调研结论（2025-2026 现状，已核实）

| 问题 | 结论 | 证据 |
|---|---|---|
| 字幕轨发现 | 读页面 HTML 全局 `window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[]` 最可靠（MAIN world 直读，零请求/零 CORS） | yt-dlp, Grokipedia |
| signature decipher | **不需要**——baseUrl 的 signature/key/expire/c=WEB 是 YouTube 预签好内嵌的，直接用 | yt-dlp #13075 |
| PO Token (pot) | **唯一真坑**：约 4% 灰度命中视频（baseUrl 含 `exp=xpe`）需 `pot` query param，缺它返回 HTTP 200 + 空 body；pot 是 URL param 不是 cookie，**登录态救不了**，只有播放器 JS 运行时生成 | yt-dlp #17125, #592 |
| 响应格式 | `&fmt=json3` → `{events:[{tStartMs,dDurationMs,segs:[{utf8,tOffsetMs}]}]}`，最适合程序解析 | Grokipedia |
| asr vs 人工 | 同一 timedtext 端点、同匿名可达性；区别仅在 `kind='asr'` / `vssId='a.'` 前缀 | ScrapeCreators |
| 翻译轨 | 在可翻译源轨 baseUrl 后追加 `&tlang=<code>`（YouTube 服务端机翻） | Grokipedia |

**pot 解法（主）**：MAIN world hook `window.fetch`/`XMLHttpRequest`，**拦截播放器自己发的 `/api/timedtext` 请求**——该 URL 已被播放器拼好 `&pot=&c=WEB&signature=`，直接复用响应体。与现有 B 站 AI 字幕采集（自动点字幕按钮拦播放器明文）完全同构。

## 3. 架构（方案 B：平台适配层）

YouTube 与 B 站各自独立 inject/content，**共享** background 骨架、ingest payload 形状、WS→server 链路、standalone 模式、popup、subtitleFormat、verify 基建。复用最大化、平台互不污染。

```
YouTube 视频页 (www.youtube.com/watch?v=...)
 ├─ inject-yt.js (MAIN world, document_start)
 │    ├─ 轮询读 window.ytInitialPlayerResponse.captions.captionTracks[] → postMessage CAPTION_TRACKS
 │    └─ hook fetch/XHR 拦 /api/timedtext（含播放器拼好的 pot）→ postMessage TIMEDTEXT_BODY
 ├─ content-yt.js (ISOLATED, document_start)
 │    ├─ collected: Map<vid, {meta, bodies: Map<baseUrl, normalizedBody>}>
 │    ├─ 收 CAPTION_TRACKS：存 meta；对每轨发 FETCH_SUBTITLE 给 background 兜底抓 baseUrl+&fmt=json3
 │    ├─ 收 TIMEDTEXT_BODY：归一化（youtube-format.mjs）存 body；flush
 │    ├─ flushIfReady：youtube-payload.js 组装 → chrome.runtime.sendMessage INGEST
 │    └─ onMessage: GET_LOCAL_STATE（popup 查已收集）
 └─ background.js (SW)
      ├─ INGEST handler（source 无关，已有）：转发 WS ingest；加 source==='bilibili' 守卫护 ensureUpperInfo/Videos
      ├─ FETCH_SUBTITLE handler（已有）：按 url 域名选 Referer（youtube 不加），供 content-yt 复用
      └─ navigate action（通用，已有）：chrome.tabs.create 开 youtube URL
```

## 4. 组件清单（新增 ✨ / 改动 ✏️）

| 文件 | 动作 | 职责 |
|---|---|---|
| ✨ `apps/subtitle-collector/inject-yt.js` | ✨ | MAIN world：读 captionTracks + hook timedtext |
| ✨ `apps/subtitle-collector/content-yt.js` | ✨ | ISOLATED：聚合 + 归一化 + FETCH_SUBTITLE 兜底 + INGEST + GET_LOCAL_STATE |
| ✨ `apps/subtitle-collector/youtube-format.mjs` | ✨ | **纯函数**：JSON3/XML → `{body:[{from,to,content}]}`（复用 [subtitleFormat.mjs:12](../../../apps/subtitle-collector/subtitleFormat.mjs#L12) extractCues 契约） |
| ✨ `apps/subtitle-collector/youtube-payload.js` | ✨ | 组装 `source:'youtube'` ingest payload（与 [buildIngestPayload](../../../apps/subtitle-collector/ingest-payload.js#L43) **同形状**） |
| ✏️ `apps/subtitle-collector/manifest.json` | ✏️ | host_permissions 加 `*://*.youtube.com/*`；content_scripts 加 youtube.com/watch 两条（inject-yt MAIN + content-yt ISOLATED） |
| ✏️ `apps/subtitle-collector/background.js` | ✏️ | 2 处保护性小改（不破坏 B 站）：FETCH_SUBTITLE 按域名选 Referer；INGEST 的 ensureUpperInfo/Videos 加 source 守卫 |
| ✏️ `apps/subtitle-collector/src/popup/platforms.ts` | ✏️ | PLATFORMS push youtube（urlPattern `youtube\.com/watch\?v=([A-Za-z0-9_-]{11})`、YouTube statFields、`bg-[#FF0000]`、logo 已就绪 [:27](../../../apps/subtitle-collector/src/popup/platforms.ts#L27)） |
| ✏️ `apps/subtitle-collector/content.js` | ✏️ | GET_LOCAL_STATE 兼容 `msg.vid ?? msg.bvid`（一行，让 popup 统一发 vid） |
| ✨ `apps/subtitle-collector/test/youtube-format.test.mjs` | ✨ | JSON3/XML 归一化纯函数测试（自动进 `node --test`） |
| ✨ `apps/subtitle-collector/test/youtube-payload.test.mjs` | ✨ | payload 组装形状测试 |
| ✨ `scripts/verify-youtube-collector.mjs` | ✨ | 抄 [verify-collector.mjs](../../../scripts/verify-collector.mjs)，mock youtube 页面 + timedtext 响应，断言 WS ingest |
| ✏️ `package.json` | ✏️ | 加 `"test:youtube"` 脚本 |
| **不动** | — | collector-server（schema 已 source-generic）、collector-web（按 source 天然多渠道）、subtitle-extractor |

## 5. 接口契约（并发实现唯一依据，各 agent 严格遵守）

### 5.1 inject-yt.js → content-yt.js（window.postMessage）

所有消息带 `source: 'yt-sub-ext'` 标记，content-yt.js 仅处理带此标记且 `event.source === window` 的消息。复用 content.js 的 `{type, data}` 信封（[content.js:8](../../../apps/subtitle-collector/content.js#L8)）。

```js
// 1. 字幕轨发现（轮询读到 ytInitialPlayerResponse.captions 后发，最多 ~20s）
{
  source: 'yt-sub-ext', type: 'CAPTION_TRACKS', data: {
    videoId: string,            // 11 位，从 URL ?v= 抽
    title: string|null,
    channelId: string|null,     // ytInitialPlayerResponse.videoDetails.channelId
    channelName: string|null,   // videoDetails.author
    duration: number|null,      // 秒，videoDetails.lengthSeconds
    captionTracks: Array<{
      baseUrl: string,          // 完整签名 URL（含 signature/key/expire/c=WEB，可能含 pot）；& 还原为 &
      languageCode: string,     // 'en', 'zh-Hans', 'zh'
      kind: string|null,        // 'asr'=自动生成；人工轨为 null
      name: string,             // name.simpleText，如 'English'
      vssId: string,            // '.en' 人工 / 'a.en' asr
      isTranslatable: boolean,
    }>,
  }
}

// 2. 拦截到播放器自己发的 /api/timedtext 响应（含 pot）
{
  source: 'yt-sub-ext', type: 'TIMEDTEXT_BODY', data: {
    videoId: string,
    url: string,                // 完整请求 URL（含 pot，作缓存/匹配 key）
    fmt: 'json3'|'xml'|null,    // 从 url 的 fmt= 参数判；null 时归一化函数自嗅探
    body: string,               // 响应正文（json3 文本或 xml 文本）
  }
}
```

### 5.2 content-yt.js → background.js（chrome.runtime.sendMessage）

```js
// 复用现有 INGEST（[background.js:350] source 无关）
{ type: 'INGEST', payload: <buildYoutubePayload 产物> }

// 复用现有 FETCH_SUBTITLE（[background.js:382]，background 改按域名选 Referer 后通用）
{ type: 'FETCH_SUBTITLE', url: <baseUrl 追加 &fmt=json3 后> }
// 回调 resp: { ok: boolean, body?: object, error?: string }

// popup → content-yt（onMessage）
{ type: 'GET_LOCAL_STATE', vid: string }
// 回复 { ok, state: 'has-subtitle'|'no-subtitle'|'not-loaded', tracks: [{lan, lan_doc, track_type, has_body, source_url}], ... }
```

### 5.3 youtube-format.mjs 函数签名

```js
// JSON3 对象/JSON 字符串 → {body:[{from,to,content}]}
export function parseYoutubeJson3(json3)
// XML/srv3 字符串 → {body:[{from,to,content}]}
export function parseYoutubeXml(xml)
// 按 fmt 分发；fmt 为 null 时按内容嗅探（首字符 '{'→json3，'<'→xml）；容错 null/空 → {body:[]}
export function normalizeYoutubeTimedtext(rawBody, fmt)
```

**cue 换算**：`from = tStartMs/1000`；`to = (tStartMs + dDurationMs)/1000`（dDurationMs 缺失用 0 → to=from）；`content = segs.filter(s => s.utf8).map(s => s.utf8).join(' ').trim()`。忽略 `tOffsetMs`（词级时间，cue 级聚合即可）。空 events / 缺字段容错返回 `[]`。产物 `{body: cues}` 可**直接喂** [subtitleFormat.mjs](../../../apps/subtitle-collector/subtitleFormat.mjs) 的 extractCues/subtitleToSRT/subtitleToPlainText。

### 5.4 youtube-payload.js 函数签名

```js
export function buildYoutubePayload({
  videoId, title, channelId, channelName, avatar, duration, publishedAt, // 视频元信息
  captionTracks,   // inject 抽的轨元数据（5.1 的 captionTracks[]）
  bodies,          // { [baseUrl]: {body:[{from,to,content}]} } 已归一化（FETCH_SUBTITLE 兜底 + TIMEDTEXT_BODY 拦截合并）
}) →
{
  source: 'youtube',
  video: {
    source_vid: videoId,
    creator: { source_uid: String(channelId ?? 'unknown'), name: channelName, avatar: avatar ?? null },
    title,
    extra: {},                            // YouTube 专属 extra 预留（duration 已在 video.duration；后续扩 viewCount/likeCount）
    duration: duration ?? null,
    published_at: publishedAt ?? null,   // ms
  },
  tracks: captionTracks.map(t => ({
    lan: t.languageCode,
    lan_doc: t.name,
    track_type: t.kind ?? null,          // 'asr'(自动生成) / null(人工)。⚠ B 站此处为数字：需核对 collector-server track_type 列类型，若 INTEGER 则映射 asr→1 / null→0
    versions: [{
      origin: 'external',
      payload: bodies[t.baseUrl] ?? null,   // 保留 {body:[...]} 外层，与 B 站 buildIngestPayload 的 subtitleBodies 一致（下游零特殊处理）
      source_url: t.baseUrl,
    }],
  })),
}
```

### 5.5 manifest.json 改动

```jsonc
"host_permissions": [
  "*://*.bilibili.com/*",
  "*://*.youtube.com/*",      // ← 新增
  "http://127.0.0.1/*", "*://localhost/*"
],
"content_scripts": [
  /* …现有 B 站两条不动… */
  {
    "matches": ["*://www.youtube.com/watch*"],
    "js": ["inject-yt.js"],
    "world": "MAIN",
    "run_at": "document_start"
  },
  {
    "matches": ["*://www.youtube.com/watch*"],
    "js": ["content-yt.js"],
    "run_at": "document_start"
  }
]
```

### 5.6 background.js 改动（保护性，2 处）

1. **FETCH_SUBTITLE handler（[background.js:385](../../../apps/subtitle-collector/background.js#L385)）**：按 `msg.url` 域名选 Referer——`youtube.com`/`googlevideo.com` **不加 Referer**；`bilibili.com` 保留现有 Referer。
2. **INGEST handler（[background.js:374-378](../../../apps/subtitle-collector/background.js#L374)）**：`ensureUpperInfo(mid)` / `ensureUpperVideos(mid)` 外包一层 `if (payload.source === 'bilibili')`，避免对 YouTube channelId 误调 B 站 API。

### 5.7 platforms.ts 改动

```ts
export const youtube: Platform = {
  id: 'youtube',
  name: 'YouTube',
  logo: LOGOS.youtube,
  brandBgClass: 'bg-[#FF0000]',
  urlPattern: /youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/,
  statFields: [
    { key: 'view', label: '播放', icon: 'play' },
    { key: 'like', label: '点赞', icon: 'like' },
  ],
};
export const PLATFORMS: Platform[] = [bili, youtube];
```

### 5.8 content.js 兼容改动

GET_LOCAL_STATE（[content.js:183](../../../apps/subtitle-collector/content.js#L183)）的 `const bvid = msg.bvid;` 改 `const bvid = msg.vid ?? msg.bvid;`，让 popup 统一发 `{type:'GET_LOCAL_STATE', vid}`。

## 6. 数据流（双路径，与 B 站同构）

**路径 A · 被动拦截（主，复用 pot，覆盖含 pot 视频）**：inject-yt hook 拦播放器自己发的 `/api/timedtext` → 拿到已签名+pot 的 URL 与 json3 响应体 → content-yt 按 vid 聚合 → 归一化 → INGEST → background WS。若播放器默认不发字幕请求，必要时点 CC 按钮触发（同 B 站 [triggerAiSubtitle](../../../apps/subtitle-collector/content.js#L139) 模式；第一版先观察默认行为，Phase 0 验证）。

**路径 B · 主动 fetch（兜底，覆盖 ~96% 不需 pot 视频）**：content-yt 收 CAPTION_TRACKS 后，对每轨发 `FETCH_SUBTITLE`（url=baseUrl+`&fmt=json3`）让 background 免 CORS 抓 → 归一化 → 入 bodies → flush。命中 pot 返空/非法 JSON → 该轨 body 为空 → 识别为 pot_restricted 不上报脏数据。

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| 无 captionTracks（纯音乐/直播/无字幕） | 不上报，记 empty（同 B 站 CASE_EMPTY） |
| pot 命中空 200 | 路径 B 该轨 body 空 → 路径 A 拦截补；两路径都空 → 该轨跳过不上报 |
| 年龄/会员/区域限制 | 登录态 cookie 自动附，通常可拿 captionTracks；拿不到则跳过 |
| inject 时机（document_start 时 ytInitialPlayerResponse 未就绪） | 轮询读取，每 500ms 一次，最多 40 次 ~20s（同 [inject.js:49-65](../../../apps/subtitle-collector/inject.js#L49) B 站 __playinfo__ 模式） |
| `&` 转义 | baseUrl fetch 前还原 `&` |
| 空 events / 缺字段 | normalizeYoutubeTimedtext 容错返回 `{body:[]}` |

## 8. Phase 切片（先证伪最大风险）

- **Phase 0 · 证伪**：YouTube 视频页能否读到 captionTracks、timedtext 匿名/登录可否拿到、pot 实测命中率、播放器默认是否请求字幕。产物：verify 脚本骨架 + 风险表实测回填。
- **Phase 1 · 归一化纯函数**：youtube-format.mjs + youtube-payload.mjs + node:test（无浏览器依赖，先全绿）。
- **Phase 2 · 采集链路**：inject-yt.js + content-yt.js + background 2 处改动 + manifest + WS ingest。
- **Phase 3 · UI + 端到端**：platforms 注册 + content.js 兼容 + verify-youtube-collector.mjs 全绿。

## 9. 验收标准

### 9.1 功能验收清单

| ID | 项 | Phase | 覆盖测试 |
|---|---|---|---|
| Y1 | JSON3 → `{from,to,content}` 归一化正确（含空 events/词级 segs/&） | 1 | test/youtube-format.test.mjs |
| Y2 | XML/srv3 → cue 归一化正确 | 1 | test/youtube-format.test.mjs |
| Y3 | `buildYoutubePayload` 产出 `source:'youtube'` 同构形状 | 1 | test/youtube-payload.test.mjs |
| Y4 | inject-yt 轮询读到 captionTracks + hook 拦 timedtext | 2 | verify-youtube-collector.mjs |
| Y5 | content-yt 聚合 + 归一化 + INGEST，WS 收到 source='youtube' payload | 2 | verify-youtube-collector.mjs |
| Y6 | background FETCH_SUBTITLE 按 youtube 域名免 Referer 抓 json3 | 2 | verify-youtube-collector.mjs |
| Y7 | pot 空响应识别为受限、不上报脏数据 | 2 | verify-youtube-collector.mjs（mock 空 body） |
| Y8 | platforms.ts 注册 youtube，popup 识别 youtube URL | 3 | verify-youtube-collector.mjs + vite build |
| Y9 | 端到端：mock youtube 页 → 扩展采集 → WS ingest tracks 非空 | 3 | verify-youtube-collector.mjs |
| Y10 | turbo test / vite build 全绿，不破坏 B 站现有测试 | 3 | turbo run test |

**验收结果（2026-07-19）**：Y1-Y10 全部 ✅ 通过。纯函数 83/83（youtube-format 29 + youtube-payload 7 + B 站 47）；vite build 83 modules 含 inject-yt/content-yt（crxjs 正确处理新 content_scripts 入口）；verify-youtube-collector.mjs 端到端通过（source=youtube / source_vid / tracks / cue 全断言过）。

### 9.2 测试轮次记录

| 轮次 | 日期 | 范围 | 结果 | 备注 |
|---|---|---|---|---|
| T1 | 2026-07-19 | Y1-Y3 纯函数 | PASS | 83/83；R6 track_type 映射 asr→1/null→2（非 spec 草拟的 null→0，按 B 站语义）；payload 形状修正为保留 `{body:}` 外层与 B 站 buildIngestPayload 一致 |
| T2 | 2026-07-19 | Y4-Y7 采集链路 | PASS | vite build 83 modules 含 inject-yt/content-yt；background 2 处守卫（FETCH_SUBTITLE 按域名免 Referer / INGEST source 守卫）B 站零回归 |
| T3 | 2026-07-19 | Y8-Y10 端到端 | PASS | verify-youtube-collector.mjs 端到端通过；修 3 处 mock 缺陷：① VIDEO_ID 须 11 位（12 位被 inject-yt 正则截断致 SPA 守卫误判 CAPTION_TRACKS 不发）② timedtext fetch 须在 CAPTION_TRACKS 之后触发（否则被 content-yt 丢弃）③ hasCue 断言访问 payload.body |

## 10. 风险表

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | pot 灰度命中导致 ~4% 视频字幕空 | 部分视频采不到 | 路径 A 拦截播放器请求复用 pot；两路径空则记受限不上报 |
| R2 | YouTube 改 ytInitialPlayerResponse 结构 | inject 读不到 captionTracks | 轮询 + 多路径兜底（youtubei/v1/player）；spec 风险表回填 |
| R3 | 播放器默认不请求 timedtext | 路径 A 抓不到 | Phase 0 观察；必要时点 CC 触发（同 B 站模式） |
| R4 | crxjs 对新 content_scripts 入口处理 | 构建产物缺 inject-yt/content-yt | vite build 冒烟 + verify 脚本加载 dist 验证 |
| R5 | popup GET_LOCAL_STATE 在 yt tab 的 content-yt 响应 | popup 展示空 | content-yt 实现 GET_LOCAL_STATE，content.js 兼容 vid |
| R6 | track_type 字段类型（B 站数字 vs YouTube 'asr' 字符串） | server 列类型不兼容报错 | payload agent 核对 [ingest.ts](../../../apps/collector-server/src/db/ingest.ts) schema；若 INTEGER 则 asr→1/null→0 映射 |
