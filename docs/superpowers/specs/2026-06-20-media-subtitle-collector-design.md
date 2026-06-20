# 媒体字幕采集库（Media Subtitle Collector）设计

> 日期：2026-06-20
> 状态：设计中
> 关联：`apps/subtitle-extractor`（现有，不动）、`apps/subtitle-collector`、`apps/collector-server`、`apps/collector-web`（均新建）
> 参考：`.claude/references/opencli-通信设计-映射.md`、`.claude/references/opencli-数据采集-映射.md`（本地，不入库）

---

## 1. 概述

本地化、多渠道的媒体字幕采集与查阅系统。一侧是浏览器扩展（采集），一侧是本地服务端（接收、SQLite 落库、提供查询），再加一个网页 app（查阅）。

MVP 聚焦 **B 站字幕**采集入库 + 查阅；数据模型按**多渠道**（bilibili/youtube/…）、**多来源版本**（外挂/音频ASR转/人工修正）设计，兼容后续扩展。

**本轮不做**：音频下载（yt-dlp 路线，独立后续 spec）；YouTube 采集（仅数据模型预留，不实现）。

## 2. 背景

现有 `subtitle-extractor` 扩展能从 B 站视频页拦到字幕轨 JSON（`inject.js` hook fetch/XHR）。但它只在 popup 内展示，不落库、不跨视频、不积累。

本设计把"展示型扩展"升级为"采集型系统"：扩展把字幕上报给本地服务端，服务端 SQLite 持久化，网页 app 提供列表/搜索/详情查阅。

## 3. 需求（确认）

| 项 | 决定 |
|---|---|
| 触发方式 | 浏览时自动入库 + 手动补采（两者结合） |
| 多轨入库 | 全部轨都存（视频↔轨 一对多） |
| 服务端 | TS 本地常驻进程，loopback HTTP + SQLite |
| 存储粒度 | 整轨 JSON 原样存（payload） |
| 去重 | 存在即跳过（幂等），强制更新留口子（后续） |
| 视频元信息 | 扩展拦截 player API 时顺带抽 |
| 服务启动 | 手动启动（开发期） |
| 上报失败 | 失败即丢（MVP） |
| 消费 UI | 独立网页 app（localhost），列表 + 详情 + 搜索 |
| 默认轨优先级 | CC中文 > AI中文 > 英文 > 其他（服务端算） |
| 跨渠道关联 | 不关联，各渠道独立 |
| 作者建模 | 独立 creators 表 |
| 版本语义 | 来源类型版本（外挂/ASR转/人工修正） |
| 元信息刷新 | 做变更日志 |
| 音频下载 | 拆出，后续独立 spec |

## 4. 架构

```
┌──────────────────────────────────────────────────────────────┐
│ Chrome 浏览器                                                  │
│  apps/subtitle-collector 扩展                                  │
│   inject.js (MAIN, document_start)                             │
│     hook fetch/XHR → 拦 player API + 字幕 URL                  │
│     抽元信息 + 字幕轨列表 + 字幕 body                           │
│     postMessage → content.js                                   │
│   content.js (ISOLATED)                                        │
│     按 bvid 聚合 → 组装完整"视频记录" → 转发 background         │
│   background.js (service worker)                               │
│     /ping 探活 → POST /ingest 上报（失败即丢）                  │
│   popup.html/js                                                │
│     状态 + 手动补采按钮                                         │
└──────────────────────────┬───────────────────────────────────┘
                           │ loopback HTTP (localhost:21527)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ apps/collector-server (TS 常驻进程, 手动启动)                   │
│   POST /ingest      ← 扩展上报，幂等去重，写 SQLite + 变更日志  │
│   GET  /ping        ← 探活                                     │
│   GET  /api/videos  ← 列表(搜索/分页)                           │
│   GET  /api/videos/:bvid ← 详情(含全部轨/版本)                  │
│   静态托管 collector-web 产物                                  │
│   SQLite: bilibili-collector.db                                │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTP（同源）
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ apps/collector-web (React + Vite)                              │
│   列表 + 搜索 / 详情(轨切换 + 版本切换 + 时间轴逐行)             │
└──────────────────────────────────────────────────────────────┘
```

**三个 `apps/*` 新包**，顺现有 monorepo（`pnpm-workspace.yaml` 已含 `apps/*`）。

**学自 opencli 的技术点（不引入依赖，详见本地映射文档）：**
- 扩展上报前 `/ping` 探活，避免 fetch 连接失败控制台噪声
- body 大小诚实标记，防异常大响应
- 字幕数据结构确认（player API → `subtitle.subtitles[]` → `subtitle_url` → body），与 `info/body.json` 样本一致
- 定向 hook 而非 CDP（零 `debugger` 权限，无感知）
- **绕过 opencli 踩的 Wbi 签名坑**：扩展拦的是页面已发的请求（页面自签），不重新发

**明确不做（学 opencli 但砍掉）：** WS 双向通道、CDP debugger、多 profile、CSRF 四道防御（用 Origin 校验 + 固定 token 替代）。

## 5. 数据模型（SQLite：bilibili-collector.db）

多渠道、多来源版本。四层：创作者 → 视频 → 字幕轨 → 字幕版本。全部时间戳 UTC 毫秒。

### 5.1 creators —— 创作者（按渠道独立）

```sql
CREATE TABLE creators (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,              -- 'bilibili' / 'youtube' / ...
  source_uid    TEXT NOT NULL,              -- 渠道内唯一ID（B站mid / YouTube channelId）
  name          TEXT,                       -- 当前显示名
  avatar        TEXT,                       -- 头像URL
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(source, source_uid)
);
```

作者改名时刷新 `name` + 记 change_log。

### 5.2 videos —— 视频（按渠道独立，关联创作者）

```sql
CREATE TABLE videos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,              -- 'bilibili' / 'youtube'
  source_vid    TEXT NOT NULL,              -- 渠道内视频ID（B站bvid / YouTube videoId）
  creator_id    INTEGER REFERENCES creators(id),
  title         TEXT NOT NULL,
  extra         TEXT,                       -- JSON: 渠道专属元信息（B站aid/cid/tid/desc/cover等）
  duration      INTEGER,                    -- 时长(秒)，通用
  status        TEXT DEFAULT 'online',      -- 'online'/'removed'/'private'
  published_at  INTEGER,                    -- 视频发布时间（平台提供）
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(source, source_vid)
);
```

`extra` JSON 存渠道专属字段，避免每加渠道改表。查询 extra 内字段用 SQLite JSON 函数。

### 5.3 subtitle_tracks —— 字幕轨（视频内某语言的字幕位置）

```sql
CREATE TABLE subtitle_tracks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id    INTEGER NOT NULL REFERENCES videos(id),
  lan         TEXT,                         -- 语言码（ai-zh/zh-Hans/en-US...）
  lan_doc     TEXT,                         -- 显示名（"AI简体中文"）
  track_type  INTEGER,                      -- 平台轨类型（1=AI/2=CC...），渠道定义
  UNIQUE(video_id, lan, track_type)
);
CREATE INDEX idx_tracks_video ON subtitle_tracks(video_id);
```

这一层是"位置"，不含内容。同视频同语言同类型 = 同一轨（去重锚点）。

### 5.4 subtitle_versions —— 字幕版本（核心：多来源 payload）

```sql
CREATE TABLE subtitle_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id      INTEGER NOT NULL REFERENCES subtitle_tracks(id),
  origin        TEXT NOT NULL,              -- 'external'(平台外挂)/'asr'(音频转)/'manual'(人工修正)
  payload       TEXT NOT NULL,              -- 整轨 JSON 原样
  body_size     INTEGER,                    -- payload字节大小（诚实标记）
  source_url    TEXT,                       -- 外挂字幕URL（asr/manual为空）
  asr_engine    TEXT,                       -- origin=asr时记引擎（whisper/...），否则空
  captured_at   INTEGER NOT NULL,
  UNIQUE(track_id, origin, coalesce(asr_engine,''), coalesce(source_url,''))
);
CREATE INDEX idx_versions_track ON subtitle_versions(track_id);
```

**这是"几个版本"的落点**：同一 track 下按 `origin`（+ asr_engine/source_url）去重。外挂、ASR转、人工修正是不同 version，都保留。详情页可切换版本。

### 5.5 change_log —— 变更日志（通用）

```sql
CREATE TABLE change_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,                -- 'video'/'creator'/'track'
  entity_id   INTEGER NOT NULL,             -- 对应表的id
  field       TEXT NOT NULL,                -- 变更字段
  old_value   TEXT,
  new_value   TEXT,
  changed_at  INTEGER NOT NULL
);
CREATE INDEX idx_changelog_entity ON change_log(entity, entity_id);
```

通用化：视频标题变、作者改名、轨类型变，都记一条。

### 5.6 默认轨/版本优先级（查询时算，不入库）

详情页默认展示规则，服务端查询时计算 `is_default`：

轨优先级：`CC中文(track_type=2 且 lan 含 zh) > AI中文(track_type=1 且 lan 含 zh) > 英文(lan 含 en) > 其他`

版本优先级（同轨内默认展示）：`external > manual > asr`

## 6. HTTP API 契约（localhost:21527）

### 6.1 探活

```
GET /ping → 200 { ok: true }
```

无鉴权，loopback only。扩展上报前探活。

### 6.2 扩展上报（写入路径）

```
POST /ingest
Headers:
  Origin: chrome-extension://<id>
  X-Collector-Token: <固定 token>
Body (JSON):
{
  "source": "bilibili",
  "video": {
    "source_vid": "BV1mhjg6SEJy",
    "creator": { "source_uid": "123", "name": "up名", "avatar": "..." },
    "title": "...",
    "extra": { "aid": 123, "cid": 456, "tid": 17, "desc": "...", "pic": "..." },
    "duration": 1083,
    "published_at": 1700000000000
  },
  "tracks": [
    {
      "lan": "ai-zh", "lan_doc": "AI（简体中文）", "track_type": 1,
      "versions": [
        { "origin": "external", "payload": { ... }, "source_url": "https://..." }
      ]
    }
  ]
}

Response:
  200 { ok:true, source:"bilibili", source_vid:"...", inserted_tracks:2, skipped_tracks:0 }
  400 { ok:false, error:"..." }
  403 { ok:false, error:"bad token" }
```

**幂等去重 + 变更日志逻辑（服务端，单事务）：**
1. creator：按 `UNIQUE(source, source_uid)` upsert；name 变 → 记 change_log
2. video：不存在 → INSERT；存在 → 逐字段比对，**有变化**字段记 change_log + UPDATE + 刷新 updated_at
3. track：按 `UNIQUE(video_id, lan, track_type)` upsert
4. version：按 `UNIQUE(track_id, origin, ...)` `INSERT OR IGNORE`，存在即跳过
5. 统计 `inserted_tracks` / `skipped_tracks` 返回

**防御：** Origin 校验（只接 `chrome-extension://`）；固定 token（配置）；body 上限 10MB。

### 6.3 网页消费（查询路径，只读，无鉴权）

```
GET /api/videos?q=<词>&page=1&size=20
  → 200 { ok:true, total:42, items:[
       { id, source, source_vid, title, creator_name, duration, track_count, first_seen_at }
     ]}
```
搜索匹配 `title` / creator `name`（LIKE），按 `first_seen_at` 倒序。

```
GET /api/videos/:source/:source_vid
  → 200 { ok:true, video:{...}, tracks:[
       { id, lan, lan_doc, track_type, is_default, versions:[
         { id, origin, source_url, asr_engine, captured_at, is_default, body_size }
       ]}
     ]}
  404 { ok:false, error:"not found" }
```
`is_default` 由服务端按 §5.6 优先级算。versions 不带 payload（详情页选定版本后再取）。

```
GET /api/versions/:id
  → 200 { ok:true, version:{ id, origin, payload, captured_at } }
```
详情页选中某版本后取 payload 渲染。

### 6.4 静态托管

```
GET /         → collector-web 构建产物（index.html）
GET /assets/* → 静态资源
```
同源，无 CORS。

## 7. 扩展（apps/subtitle-collector）

新包，不改 `subtitle-extractor`。

```
apps/subtitle-collector/
  manifest.json      MV3，权限 activeTab + bilibili host
  inject.js          MAIN world, document_start（改自 extractor，抽元信息）
  content.js         ISOLATED world（组装视频记录 + 转发 background）
  background.js      service worker（探活 + 上报）
  popup.html/js      状态显示 + 手动补采按钮
  config.js          服务端地址 + token
  package.json       @bilibili-ext/subtitle-collector
```

### 7.1 inject.js（采集源）

沿用 hook fetch/XHR。从同一个 player API 响应里抽元信息（bvid/aid/cid/title/up_mid/up_name/pic/duration）+ 字幕轨列表；拦字幕 URL 读 body。

**subtitle_url 为空的三种独立情况（分开处理，不混为一谈）：**
- 响应 code≠0 或被风控 → `RISK_CONTROL` 信号
- `need_login_subtitle === true` → `NEED_LOGIN` 信号
- subtitles 数组空/无 → 无字幕（正常，不上报轨，可只上报元信息）
- 有 subtitles[] 但某条 url 缺失 → 该单轨标 url_missing，不混入风控/登录

postMessage 消息类型：`PLAYER_META`（元信息+轨列表）、`SUBTITLE_BODY`（url+body+body_size）、`RISK_CONTROL`、`NEED_LOGIN`。

### 7.2 content.js（组装 + 转发）

按 source_vid 聚合 { 元信息, 轨列表[每轨: lan/track_type/url+body] }。当元信息 + 至少一条轨有 body → 组装成完整视频记录 → `chrome.runtime.sendMessage` 转发 background。

### 7.3 background.js（探活 + 上报）

收到 content 的视频记录：`/ping` 探活（不通静默丢）；通则 `POST /ingest`（带 Origin + X-Collector-Token）；收到统计 → 通知 popup。

### 7.4 popup

```
[状态] 已连接 localhost:21527 ✓ / 未连接 ✗
[当前视频] BV1xxx — 标题
[上报统计] 本次新增 2 轨，跳过 0 轨
[手动补采] 按钮
```

## 8. 网页（apps/collector-web）

```
apps/collector-web/
  package.json       @bilibili-ext/collector-web, vite + react
  vite.config.ts     build → ../collector-server/public
  src/
    main.tsx, App.tsx (路由)
    api.ts (fetch 封装，同源)
    pages/ VideoList.tsx, VideoDetail.tsx
    components/ TrackSwitcher.tsx, VersionSwitcher.tsx, SubtitleView.tsx
    types.ts (对齐 API 契约)
```

**列表页 `/`**：搜索框 + 列表项（标题/创作者/轨数/入库时间），点进详情。

**详情页 `/video/:source/:source_vid`**：视频头（标题/创作者/封面/时长）→ **轨切换器**（服务端标 is_default 高亮）→ **版本切换器**（同轨多版本：外挂/ASR/人工，标 is_default）→ **时间轴逐行**（选中版本 payload.body[]，from→to + content）+ 复制按钮。

TrackSwitcher / SubtitleView 的交互思路复用 subtitle-extractor 的"字幕轨切换器"（已有 spec/plan）。

## 9. 不做（YAGNI / 后续 spec）

- **音频下载**：yt-dlp 路线，独立后续 spec（`docs/superpowers/specs/<日期>-audio-download-design.md`）。技术栈已确认：本地服务端 shell out `yt-dlp --extract-audio`，复用 opencli bilibili/download.js 的付费预检逻辑。
- **YouTube 采集**：数据模型已预留（source='youtube'），不实现。
- **跨渠道关联**：不做，各渠道独立。
- **强制更新字幕轨内容**：留口子，后续。
- **上报失败重试队列**：失败即丢（MVP）。
- **多用户/鉴权**：个人本地用，固定 token 足够。

## 10. 验收标准

| # | 验收项 |
|---|---|
| 1 | 扩展在 B 站视频页拦截 player API，抽到元信息 + 字幕轨列表 |
| 2 | 拦到字幕 URL，读出 body，组装成完整视频记录上报 |
| 3 | 本地服务端 `/ingest` 接收，幂等去重，写入 SQLite 四层表 + 变更日志 |
| 4 | 同视频再上报：元信息变了记 change_log 并更新；轨/版本已存在则跳过 |
| 5 | subtitle_url 为空时正确区分 风控/未登录/无字幕/单轨缺失 四种情况 |
| 6 | 网页列表：搜索（标题/创作者）、分页、按入库时间倒序 |
| 7 | 网页详情：轨切换器 + 版本切换器，默认轨/版本按优先级高亮 |
| 8 | 详情选中版本后展示时间轴逐行 + 复制
| 9 | 真实登录态端到端：B 站视频页 → 扩展采集 → 服务端入库 → 网页查阅 |
| 10 | `/ping` 探活：服务未启动时扩展静默丢弃上报，无控制台噪声 |

## 11. 测试方式

沿用项目现有 puppeteer mock 验证模式（`scripts/verify-extension.mjs`）+ Node 内置 test：

- **服务端四层写入/去重/变更日志**：Node test，mock ingest 请求，断言 SQLite 状态
- **API 契约**：Node test，起服务发请求断言响应
- **扩展采集链路**：puppeteer mock player API + 字幕 URL，验证 inject→content→background→/ingest
- **真实端到端**：登录态浏览器开有字幕的 B 站视频，确认 SQLite 入库 + 网页查阅（人工，参考 `MANUAL.md` 模式）

> 本项目无构建链（扩展侧），服务端/web 用 TS+Vite 但测试沿用 Node test + puppeteer mock，不强引 Playwright。

## 12. 风险

- **player API 响应结构**：元信息字段（up/pic/published_at 等）需用真实响应校验。设计假设 player API 返回这些，实现时验证；缺字段则落 extra 为空，不阻塞。
- **去重键 `lan + track_type`**：依赖 B 站轨类型稳定。若同语言出现两个 type 相同的轨，会撞 UNIQUE。实现时观察真实数据，必要时去重键加入更多维度。
- **扩展上报失败即丢**：服务没常开则丢数据。手动补采兜底；后续可加重试队列。
- **真实字幕需登录态 + 点字幕按钮才触发**：端到端验证需手动触发（`MANUAL.md` 已有先例）。
- **多版本 payload 体积**：同轨多版本都存整轨 JSON，存储翻倍。MVP 数据量小可接受；将来按需清理旧版本。

## 13. 本地映射参考（不入库）

- `.claude/references/opencli-通信设计-映射.md`
- `.claude/references/opencli-数据采集-映射.md`

含：通信层（单向 HTTP 上报骨架，砍 WS/握手/多profile/CSRF四道）、采集层（定向 hook vs CDP、字幕数据结构、签名坑绕过、body 截断诚实标记、yt-dlp 音频后续路线）的对照。
