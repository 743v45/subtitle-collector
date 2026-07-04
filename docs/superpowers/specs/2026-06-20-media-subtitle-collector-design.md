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
| 服务端↔扩展通信 | **WebSocket 双向 RPC**（对齐 opencli），支持服务端驱动扩展采集 |
| 扩展身份 | **双重**：浏览时被动上报 + 接受服务端命令主动采集 |
| 操作页面手段 | **tabs + hook + content script**（②+3），不用 CDP/debugger |
| 音频下载 | 拆出，后续独立 spec |
| 批量/自动/AI命令采集 | **架构预留，功能后续实现** |

## 4. 架构

通信核心：**扩展 ↔ 服务端走 WebSocket 双向 RPC**（对齐 opencli 的 daemon/extension 模型）。扩展有**双重身份**：① 用户浏览时被动采集上报；② 接受服务端下发的命令，主动打开页面/操作页面/抓数据（为批量/自动采集预留）。

```
┌──────────────────────────────────────────────────────────────┐
│ Chrome 浏览器                                                  │
│  apps/subtitle-collector 扩展（双重身份）                       │
│   inject.js (MAIN, document_start)                             │
│     hook fetch/XHR → 拦 player API + 字幕 URL                  │
│     抽元信息 + 字幕轨列表 + 字幕 body → postMessage            │
│   content.js (ISOLATED)                                        │
│     聚合视频记录 / 执行页面操作（如点字幕开关）→ 转发 background │
│   background.js (service worker)                               │
│     WS 客户端，连服务端：                                        │
│       ① 被动：把浏览采集到的数据上报（ingest 类命令）            │
│       ② 主动：接收并执行服务端命令（打开页/操作页/抓数据）        │
│   popup.html/js                                                │
│     连接状态 + 手动补采 + 任务入口（固定按钮，后续接 AI 命令）    │
└─────────────┬────────────────────────────────────▲──────────┘
     命令下发  │  WebSocket 双向 RPC (ws://localhost:21527)  │ 结果/数据上报
              ▼                                    │
┌──────────────────────────────────────────────────────────────┐
│ apps/collector-server (TS 常驻进程, 手动启动)                   │
│   WS 服务端 (loopback)：                                        │
│     - 接收扩展上报 → 幂等去重 → 写 SQLite + 变更日志            │
│     - 任务调度层（预留）：批量/定时/UP主任务 → 下发命令给扩展    │
│   HTTP (loopback)：                                            │
│     - GET /ping 探活                                            │
│     - GET /api/videos 列表(搜索/分页)                           │
│     - GET /api/videos/:source/:source_vid 详情                  │
│     - GET /api/versions/:id 取版本 payload                      │
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

### 4.1 RPC 协议（对齐 opencli，取其骨架）

学 opencli 的 `Command`/`Result` 信封 + 握手 + 探活 + 重连（详见 `.claude/references/opencli-通信设计-映射.md`）。**消息分三类：**

- **Command**（服务端 → 扩展，需 result 回执）：`{ id, action, ... }`。MVP action 含：
  - `navigate`（打开某视频页，让字幕 API 触发）
  - `operate`（页面操作，如点字幕开关）—— content script 执行
  - `fetch-subtitle`（触发某视频字幕抓取）
  - 其余批量/定时/UP主/AI 命令 action：**协议预留，功能后续实现**
- **Result**（扩展 → 服务端，对 Command 的回执）：`{ id, ok, data/error, errorCode? }`，按 `id` 匹配回 pending Map
- **主动消息（fire-and-forget / fire-and-ack，无 id，不进 pending Map）：**
  - 扩展 → 服务端：`hello`（握手，带扩展版本 + token，见下）、`log`（日志转发）、`ingest`（被动采集的数据上报）
  - 服务端 → 扩展：`ingest-ack`（确认上报，`{ type:'ingest-ack', ok, inserted_tracks, skipped_tracks }`）

> **ingest / ingest-ack 是无 id 的 fire-and-ack 消息对**：扩展主动推 `ingest`，服务端处理完回 `ingest-ack`。两者都不带 `id`、不进 pending Map，**不**作为 Command/Result 走回执流程。

- **连接管理**：扩展 WS 客户端连 `ws://localhost:21527`；连前先 `GET /ping` 探活（避免 `new WebSocket()` 失败打 ERR 噪声，学 opencli）；指数退避重连 + **keepalive alarm 兜底（MV3 SW 保活）**——manifest 需声明 `alarms` 权限；background 启动时 `chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })`，`chrome.alarms.onAlarm` 回调里若 ws 未 OPEN 则 `connect()`；content.js 侧在 WS 未连时把待上报记录暂存 `chrome.storage.local`，重连后补发（防 SW 被杀导致丢数据）
- **安全**：loopback only；**HTTP 端点（`/api/*` 必须校验；`/ping` 可放宽）服务端校验 Origin 白名单**——仅放行 `chrome-extension://<本扩展ID>` 与同源 `http://localhost:21527`，**并校验 Host 头 ∈ {localhost, 127.0.0.1} 防 DNS rebinding**（loopback ≠ 浏览器不可达）；WS upgrade 时 `verifyClient` 拒非扩展 origin + 比对握手 token（防 WS CSRF，学 opencli）；**WS 握手 token 校验**：`hello` 消息带 token，服务端比对 `config.js` 预置 token，不匹配关闭连接。砍掉 opencli 的 X-自定义头那道后，由「token + Origin 白名单 + verifyClient」补回等价防御。

### 4.2 操作页面手段：tabs + hook + content script（②+3，不用 CDP）

**不用 `chrome.debugger`/CDP**。理由：
- CDP 会让 Chrome 顶栏常驻黄色"正在被调试"提示，日常浏览体验差
- 本系统的"操作页面"需求有限：打开视频页、必要时点字幕开关触发加载、抓字幕。这些 ②+3 能覆盖

手段分工：
- **打开页面**：`chrome.tabs.create`（②）
- **抓字幕**：MAIN world hook 拦 player API + 字幕 URL（②，沿用现有 inject）
- **必要页面操作**（如点字幕开关）：content script 注入 + DOM 操作（③）

**Task 5（operate 命令）实现前必须先做 click 可行性 spike**（不直接假设 `element.click()` 点得动 B 站字幕按钮）：

1. puppeteer（登录态 profile）打开真实 B 站视频页，`element.click()` 后监听 5s 内是否出现 `aisubtitle`/`bfs/subtitle` 请求
2. 若 (1) 不行，试 `pointerdown + pointerup + click` 事件序列
3. 若 (1)(2) 都不行，才在该步引入 CDP 降级（独立 spec，不在 MVP 实现）

`operate` 的 `result` 必须带回「点击后是否观察到字幕请求」的**真实触发结果**，而非仅「找到并点击」。当前判定 B 站字幕按钮为常规控件，spike 预期 (1) 即可覆盖；spike 结果落实现记录备查。

### 4.3 典型场景验证（"打开某 UP 主某时间段视频，查字幕"）

证明 ②+3 + WS RPC 可覆盖批量采集（功能后续实现，此处证架构可行）：

1. 拿 UP 主视频列表：调 B 站 API `/x/space/wbi/arc/search`（带 `bvid` + `created` 发布时间）—— 数据获取，不碰页面
2. 服务端按时间段筛 `created` —— 纯过滤
3. 对每个 bvid，服务端下发 `navigate` 命令，扩展 `chrome.tabs.create` 打开视频页 —— ②
4. 必要时下发 `operate` 命令，content script 点字幕开关 —— ③
5. hook 拦到字幕数据，扩展上报 ingest —— ②

全程无 CDP。证据：opencli `clis/bilibili/user-videos.js` 已验证该 API 可用。

### 4.4 其他学自 opencli 的点（不引入依赖）

- 字幕数据结构确认（player API → `subtitle.subtitles[]` → `subtitle_url` → body），与 `info/body.json` 样本一致
- body 大小诚实标记，防异常大响应
- **绕过 Wbi 签名坑**：被动采集时扩展拦的是页面已发请求（页面自签）；主动采集调 API 时需自行签名（后续实现注意）
- subtitle_url 为空的语义区分（见 §7.1）

**明确不做（学 opencli 但砍掉）：** CDP debugger、多 profile/contextId 路由（个人单浏览器）、opencli 的 X-自定义头 CSRF 那道（loopback + Origin 校验够）。

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
  captured_at   INTEGER NOT NULL
);
CREATE INDEX idx_versions_track ON subtitle_versions(track_id);
-- C6: 去重只对 external/asr 生效；manual 不参与去重（partial unique index，manual 行不受约束）
CREATE UNIQUE INDEX idx_versions_dedup ON subtitle_versions(track_id, origin, coalesce(asr_engine,''), coalesce(source_url,'')) WHERE origin != 'manual';
```

**去重键规则**：partial unique index（`idx_versions_dedup`，`WHERE origin != 'manual'`）仅对 `external`/`asr` 生效——走 `INSERT OR IGNORE`，存在即跳过（实现也可改为应用层 SELECT 去重，见 plan，语义等价）。**`manual` 版本不参与去重键**：人工修正版本始终 INSERT 新行（多次修正靠 `captured_at` 区分版本演进，不互相覆盖），保证每次人工修正都留痕、可在详情页回看历次 manual 版本。

**这是"几个版本"的落点**：同一 track 下，`external`/`asr` 按 origin（+ asr_engine/source_url）去重各留一份；`manual` 每次修正独立成行。外挂、ASR转、人工修正是不同 version，都保留。详情页可切换版本（manual 可有多行，按 `captured_at` 倒序）。

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

## 6. 接口契约（localhost:21527）

服务端开两类端点：**WS**（与扩展双向 RPC）+ **HTTP**（探活 + 网页查询 + 静态托管）。

### 6.1 探活（HTTP）

```
GET /ping → 200 { ok: true }
```

无鉴权，loopback only。扩展 WS 连接前探活（避免 `new WebSocket()` 失败打 ERR 噪声）。

### 6.2 扩展 ↔ 服务端（WebSocket，ws://localhost:21527）

详见 §4.1 RPC 协议。消息分两类：

**扩展 → 服务端（主动消息，无 id，不进 pending Map）：**
- `hello`：握手，`{ type:'hello', ext_version, token }`（token 取自 `config.js`，用于握手鉴权，服务端比对预置 token，不匹配关闭连接）
- `log`：日志转发，`{ type:'log', level, msg, ts }`
- `ingest`：被动/主动采集的数据上报，payload 结构同下"ingest 数据结构"
- `result`：对服务端下发 Command 的执行结果，`{ id, ok, data/error }`（**此条带 id**，属 Result 回执，按 id 匹配 pending Map）

**服务端 → 扩展：**
- Command（带 id，需 result 回执）：`{ id, action:'navigate', url }` / `{ id, action:'operate', tab_hint, op }` / `{ id, action:'fetch-subtitle', bvid }`；其余 action（批量/定时/UP主/AI）：协议预留
- `ingest-ack`：对扩展 `ingest` 的确认（**主动消息，无 id**），`{ type:'ingest-ack', ok, inserted_tracks, skipped_tracks }`——与 `ingest` 构成 fire-and-ack 消息对，不走 Command/Result 回执流程

**ingest 数据结构（ingest 消息的 payload）：**
```
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
```

**服务端处理 ingest 的幂等去重 + 变更日志逻辑（单事务）：**
1. creator：按 `UNIQUE(source, source_uid)` upsert；name 变 → 记 change_log
2. video：不存在 → INSERT；存在 → 逐字段比对，**有变化**字段记 change_log + UPDATE + 刷新 updated_at
3. track：按 `UNIQUE(video_id, lan, track_type)` upsert
4. version：`external`/`asr` 按 `UNIQUE(track_id, origin, ...)` `INSERT OR IGNORE`（存在即跳过）；`manual` 不参与去重键，始终 INSERT 新行（靠 `captured_at` 区分）
5. 回 `ingest-ack` 带 `inserted_tracks` / `skipped_tracks`

**安全：** loopback only；WS upgrade `verifyClient` 拒非 `chrome-extension://` origin（防 WS CSRF，学 opencli）；**握手 token 校验**——服务端收到 `hello` 消息后比对 `config.js` 预置 token，不匹配关闭连接。

**连接生命周期与心跳（防半开连接残留）：** 扩展的 WS 跑在 MV3 service worker（`background.js`）内，SW 被挂起/回收、睡眠、断网、kill 进程等场景下对端不发 TCP FIN，服务端 `ws.on('close')` 不会触发 —— 连接变"半开"，会永久残留在 `connections` Map，导致 `listClients()` 假在线、`sendToClient` 对着死连接下发。服务端对策（ws 库官方 isAlive 模式）：

- 连接建立时 `ws.isAlive = true`，收到 pong 翻回 `true`
- 每 `heartbeatMs`（默认 30s；`attachWsServer` 第 4 参可注入，测试用 ~40ms）扫频：`isAlive === false` → `ws.terminate()`（触发 close → 删 Map）；否则置 `false` 并 `ws.ping()`
- 浏览器原生 WS 协议层自动回 pong，**客户端无需配合**（`background.js` 的 keepalive alarm 是断线重连触发器，与本机制正交）
- `setInterval` 句柄 `unref()` 且 `httpServer.on('close')` 时 `clearInterval`，不阻止进程退出、不泄漏

**连接日志：** `[ws] connect（等待 hello 握手）` / `[ws] hello 握手成功` / `[ws] close client_id=...` / `[ws] 心跳超时，terminate 半开连接` —— 连接建立与断开均有日志，关浏览器/挂起后可在 dev 终端观察到断开。

### 6.3 网页消费（HTTP，查询路径，只读）

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

**安全：** 只读；服务端校验 **Origin 白名单**（仅放行扩展 `chrome-extension://<本扩展ID>` 与同源 `http://localhost:21527`）+ **Host 头 ∈ {localhost, 127.0.0.1}** 防 DNS rebinding（loopback ≠ 浏览器不可达）。

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
  manifest.json      MV3，权限 activeTab + bilibili host + alarms（用于 SW 保活）
  inject.js          MAIN world, document_start（改自 extractor，抽元信息）
  content.js         ISOLATED world（组装视频记录 + 转发 background）
  background.js      service worker（探活 + 上报）
  popup.html/js      状态显示 + 手动补采按钮
  config.js          服务端地址 + token（token 用于 WS 握手鉴权）
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

### 7.3 background.js（WS 客户端 + 双重身份协调）

background.js 是扩展的 WS 客户端，连 `ws://localhost:21527`，承担双重身份的协调：

**WS 连接管理：**
- `/ping` 探活 → 不通静默等下次重试，不打 ERR 噪声
- 连上 → 发 `hello`（扩展版本 + token）
- 指数退避重连 + **keepalive alarm 兜底（MV3 SW 保活）**：`chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })`，`chrome.alarms.onAlarm` 回调里若 ws 未 OPEN 则 `connect()`
- WS upgrade 时 verifyClient 防非扩展 origin 接入（学 opencli 防 WS CSRF）

**被动身份（浏览采集）：**
- 收 content 的视频记录 → WS 发 `ingest` 消息 → 收 `ingest-ack` → 转发 popup 更新统计
- **WS 未连时**：content.js 把待上报记录暂存 `chrome.storage.local`，background 重连后补发（防 SW 被杀丢数据）

**主动身份（接受服务端命令）：**
- 收服务端 Command → 按 action 分发：
  - `navigate` → `chrome.tabs.create` 打开 url（②）
  - `operate` → 通过 `chrome.tabs.sendMessage` 让 content script 执行 DOM 操作（如点字幕开关，③）
  - `fetch-subtitle` → 触发某视频页面的 hook 抓取并 ingest
  - 其余 action：协议预留（MVP 可不实现具体逻辑）
- 执行完通过 WS 发 `result`（带 `id` 匹配 Command）

### 7.4 popup

布局自上而下（实现在 [Popup.tsx](apps/subtitle-collector/src/popup/Popup.tsx)）：

```
[连接]      已连接 / 未连接
[B站登录]   已登录(uname) / 未登录
[当前视频]  BV1xxx / 非视频页
┌ 视频信息 ───────────────────────────────┐
│ 上次上报 xxx / 未上报到服务端（副标题）   │
│ ▾复制字幕（N/M 轨已获取）                 │
│   [纯文本 ▸]   ← 横向抽屉：点开→三格式横排 │
│   简体中文 zh-Hans           [复制]       │
│   AI                         [复制]       │ ← url 含 aisubtitle
│   en  English                [复制]       │
│ 播放/点赞/投币/收藏/转发/弹幕数 统计网格   │
└──────────────────────────────────────────┘
[自动上报]  关/开 [开关] [手动补采]
```

关键交互：

- **格式横向抽屉**（`SubtitleCopySection`）：替换原 Radix Select——后者在扩展 popup 里 popper+Portal 触发"打开即关"已知不兼容。收缩态只渲染当前格式 1 个按钮（`▸` 提示），点击横向展开全部 3 个（纯文本/带时间戳/SRT），点选其一即折叠回单个并写回 `chrome.storage.local` 记忆。纯 button + Tailwind，不走 Portal，规避 popup 视口 bug。
- **每轨右复制按钮**：点即复制「该轨 × 当前格式」，按钮内联反馈"已复制/失败"1.5s。`subtitle_url` 含 `aisubtitle.hdslb.com` 的轨左侧标 "AI"（B 站 AI 字幕 URL 特征），否则显示 `lan_doc`（+ `lan` 副标）。无 body 的轨按钮置灰"未获取"。
- **「视频信息」**（原"已收集"）：主数据来自本地 content.js（未上报），副标题才提示服务端上报时间——纠正"已收集"暗示已上报的歧义。
- **手动补采**：缩小（`h-7 text-xs`）并入"自动上报"行右侧，不再 `w-full` 独占整行。

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

**样式约束（无豁免）：** collector-web 为有构建链（vite + react）的前端项目，样式**强制使用 Tailwind CSS 工具类 + shadcn/ui 组件**，禁止 `style={{}}` 内联样式、禁止手写 `.css` 自定义样式（遵守全局样式规则，无豁免）。

## 9. 不做（YAGNI / 后续 spec）

- **音频下载**：yt-dlp 路线，独立后续 spec（`docs/superpowers/specs/<日期>-audio-download-design.md`）。技术栈已确认：本地服务端 shell out `yt-dlp --extract-audio`，复用 opencli bilibili/download.js 的付费预检逻辑。
- **YouTube 采集**：数据模型已预留（source='youtube'），不实现。
- **跨渠道关联**：不做，各渠道独立。
- **强制更新字幕轨内容**：留口子，后续。
- **WS 上报失败重试队列**：失败即丢（MVP）；连接断时指数退避重连（学 opencli）
- **多用户/鉴权**：个人本地用，loopback + Origin/verifyClient 校验足够
- **批量/定时/UP主/AI 命令采集**：RPC 协议预留 action，**功能后续实现**（服务端任务调度层、扩展对应处理逻辑都是后续 spec）
- **CDP/debugger**：当前 ②+3（tabs + hook + content script）覆盖需求；若实测发现必须真实鼠标事件才响应的组件，再单独 spec 引入

## 10. 验收标准

| # | 验收项 |
|---|---|
| 1 | 扩展在 B 站视频页拦截 player API，抽到元信息 + 字幕轨列表 |
| 2 | 拦到字幕 URL，读出 body，组装成完整视频记录通过 WS 上报 |
| 3 | 服务端 WS 收 `ingest` 消息，幂等去重，写入 SQLite 四层表 + 变更日志，回 `ingest-ack` |
| 4 | 同视频再上报：元信息变了记 change_log 并更新；轨/版本已存在则跳过 |
| 5 | subtitle_url 为空时正确区分 风控/未登录/无字幕/单轨缺失 四种情况 |
| 6 | 服务端能通过 WS 下发 `navigate` 命令，扩展 `chrome.tabs.create` 打开页面并 hook 触发采集上报 |
| 7 | 服务端能通过 WS 下发 `operate` 命令，content script 执行页面操作（点字幕开关）回 result |
| 8 | 网页列表：搜索（标题/创作者）、分页、按入库时间倒序 |
| 9 | 网页详情：轨切换器 + 版本切换器，默认轨/版本按优先级高亮 |
| 10 | 详情选中版本后展示时间轴逐行 + 复制
| 11 | 真实登录态端到端：B 站视频页 → 扩展采集 → 服务端入库 → 网页查阅 |
| 12 | `/ping` 探活：服务未启动时扩展静默丢弃上报，无控制台噪声 |
| 13 | WS 断线后扩展指数退避重连，重连后能继续上报和接收命令 |
| 14 | collector-web 无 `style={{}}` 内联样式 / 无手写 `.css` 自定义样式 / 使用 shadcn 组件 |
| 15 | 服务端 WS 心跳：半开连接（不回 pong）在 2 个 sweep 周期内被 terminate 并从 `listClients` 剔除；正常连接保留 |
| 16 | WS 连接建立/握手/断开/心跳超时均有服务端日志，关浏览器后可观察到断开日志 |

## 11. 测试方式

沿用项目现有 puppeteer mock 验证模式（`scripts/verify-extension.mjs`）+ Node 内置 test：

- **服务端四层写入/去重/变更日志**：Node test，mock WS ingest 消息，断言 SQLite 状态
- **WS RPC 协议**：Node test，起服务端，模拟扩展发 hello/log/ingest + 收 Command 回 result
- **HTTP 查询 API**：Node test，起服务发请求断言响应
- **扩展采集链路（被动）**：puppeteer mock player API + 字幕 URL，验证 inject→content→background→WS ingest
- **扩展命令执行（主动）**：puppeteer 验证 navigate/operate 命令触发 tabs + content script 操作
- **扩展主动身份回归脚本**：验收 #5（subtitle_url 四情况）、#6（navigate）、#7（operate）由 `scripts/verify-collector.mjs` puppeteer 脚本覆盖（可重复执行）
- **真实端到端**：登录态浏览器开有字幕的 B 站视频，确认 SQLite 入库 + 网页查阅（人工，参考 `MANUAL.md` 模式）
- **WS 心跳/半开清理**：Node test，raw socket 造"发 hello 后静默（不回 pong/不发 close）"的半开客户端，注入短 `heartbeatMs`，断言 2 个 sweep 周期后从 `listClients` 消失、正常连接保留（`apps/collector-server/src/ws/server.test.ts`）

> 本项目无构建链（扩展侧），服务端/web 用 TS+Vite 但测试沿用 Node test + puppeteer mock，不强引 Playwright。

### 11.1 测试轮次记录（对齐全局 8.2）

| 轮次 | 时间 | 范围 | 结果 | 备注 |
|---|---|---|---|---|
| R1 | 2026-07-05 | ws 心跳单测 RED→GREEN（`server.test.ts`） | 失败 → 16/16 通过 | RED：无心跳逻辑致半开残留；GREEN：isAlive sweep + terminate |
| R1 | 2026-07-05 | collector-server 全量 `pnpm test` | 141 pass / 0 fail | 含新增心跳清理用例（`setup(heartbeatMs?)` 注入） |
| R1 | 2026-07-05 | `tsc --noEmit`（collector-server） | exit 0 | `isAlive` 经 `as WebSocket & { isAlive }` cast，类型干净 |
| R2 | 2026-07-05 | popup 复制区重构（横向抽屉+每轨复制）/「视频信息」/手动补采布局 | `vite build` 通过 | Radix Select 在 popup 打不开→换纯 button 横向抽屉；复制改每轨一键；76 模块 700ms。复制交互（clipboard+真实字幕）难自动化，由 build 冒烟 + 人工覆盖 |

## 12. 风险

- **player API 响应结构**：元信息字段（up/pic/published_at 等）需用真实响应校验。设计假设 player API 返回这些，实现时验证；缺字段则落 extra 为空，不阻塞。
- **去重键 `lan + track_type`**：依赖 B 站轨类型稳定。若同语言出现两个 type 相同的轨，会撞 UNIQUE。实现时观察真实数据，必要时去重键加入更多维度。
- **扩展上报失败即丢**：服务没常开则丢数据。手动补采兜底；后续可加重试队列。
- **真实字幕需登录态 + 点字幕按钮才触发**：端到端验证需手动触发（`MANUAL.md` 已有先例）。
- **多版本 payload 体积**：同轨多版本都存整轨 JSON，存储翻倍。MVP 数据量小可接受；将来按需清理旧版本。

## 13. 本地映射参考（不入库）

- `.claude/references/opencli-通信设计-映射.md`
- `.claude/references/opencli-数据采集-映射.md`

含：通信层（**WS 双向 RPC 骨架，对齐 opencli**，包含握手/探活/重连/verifyClient；砍掉多profile和X-自定义头CSRF那两道）、采集层（定向 hook vs CDP、字幕数据结构、签名坑绕过、body 截断诚实标记、yt-dlp 音频后续路线）的对照。
