# 上报开关 + 多客户端身份 设计

> 日期：2026-07-04
> 状态：设计中
> 关联：[2026-06-20-media-subtitle-collector-design.md](./2026-06-20-media-subtitle-collector-design.md)（主架构 §4/§6/§7）、[2026-06-23-active-collection-exploration.md](./2026-06-23-active-collection-exploration.md)（D 方案 gap #1/#3）

---

## 1. 概述

给 `subtitle-collector` 扩展加一个**上报闸门开关**，并为每个扩展实例分配**唯一身份（client_id）**，让本机 `collector-server` 能：

1. 认出每个连进来的扩展（按 client_id 区分，不再是一刀切同 token 的匿名连接）；
2. 分别远程控制每个扩展的"上报开关"——谁报、谁不报。

**动机**：多个扩展客户端（多台机器 / 多个浏览器）接同一个本机 server，**分别收集**——server 点名让某个客户端上报、另一个静默。

**MVP 触发方式**：server 侧走 HTTP 接口（curl / 脚本可调）。collector-web 可视化客户端列表 + 开关按钮作为**第二步**（本轮不做）。

**本轮不做（YAGNI）**：黑名单 / 白名单过滤、每视频即时开关、collector-web UI、inject.js 任何改动、改变现有 ingest 数据结构。

## 2. 背景与动机

现状（[主 spec](./2026-06-20-media-subtitle-collector-design.md) 已落地）是**纯被动、全自动上报**：

- [inject.js](apps/subtitle-collector/inject.js) hook fetch/XHR → [content.js](apps/subtitle-collector/content.js) 聚合 → [content.js:84](apps/subtitle-collector/content.js#L84) 发 `INGEST` → [background.js:74](apps/subtitle-collector/background.js#L74) 转 WS `ingest` → collector-server 入库。全程无用户干预，**无任何开关**。
- [background.js:36](apps/subtitle-collector/background.js#L36) 的 `hello` 只带 `ext_version` + `token`，**没有客户端标识**。多个扩展用同一个 token（[config.js:6](apps/subtitle-collector/config.js#L6)）连同一 server 时，server 端 [connections](apps/collector-server/src/ws/server.ts#L11) 分不清谁是谁，[broadcastCommand](apps/collector-server/src/ws/server.ts#L78) 也只能广播、且**全仓无调用方**。

用户诉求（原话）："不想要每个视频都收集""搞个开关不上报""多个客户端扩展可以接进来，分别收集"。

## 3. 需求（确认）

| 项 | 决定 |
|---|---|
| 关闭语义 | **只断上报**：连接不断、采集（inject/content）照跑、关闭期间**不新增**离线暂存 |
| 默认状态 | **开**（维持现状，用户随时可关） |
| 控制源 | ① popup 按钮；② server 通过 WS 定向下发命令（**开/关都支持**） |
| 多客户端 | 每个扩展首次生成持久 `client_id`，hello 报上；server 按 client_id 认人 |
| server 触发方式（MVP） | HTTP 接口（curl/脚本），UI 随后 |
| 状态可见性 | server 始终知道每个在线客户端当前开关状态（hello 初始同步 + 变化时主动同步） |

## 4. 架构

在主 spec 架构上叠加"开关判断 + client_id + 定向下发"三件事（🔀 标注新增）：

```
┌──────────────────────────────────────────────────────────────┐
│ Chrome 扩展 apps/subtitle-collector                            │
│   inject.js / content.js          ← 不动（采集照跑）           │
│   background.js (service worker)                               │
│     🔀 内存态 reportingEnabled（启动从 storage 载入，默认 true） │
│     🔀 INGEST 咽喉：若 !reportingEnabled → 丢弃（不发/不暂存）  │
│     🔀 hello 带 client_id + reporting_enabled                  │
│     🔀 收 set-reporting Command → 更新内存+storage + 回 result │
│     🔀 popup 改开关 → 发 reporting-state 给 server（同步状态） │
│   popup.html/js                                                 │
│     🔀 空壳"上报"行 → toggle 开关（读写 reportingEnabled）     │
└─────────────┬──────────────────────────────────▲────────────┘
   client_id +│  WebSocket（连接始终维持，开关只闸数据）│ 结果/状态
              ▼                                       │
┌──────────────────────────────────────────────────────────────┐
│ collector-server                                               │
│   WS 服务端                                                     │
│     🔀 ExtConn 加 { clientId, reportingEnabled }               │
│     🔀 connections 按 clientId 索引（Set → Map）                │
│     🔀 新增 sendToClient(clientId, cmd)（定向下发）             │
│     🔀 新增最小 result pending Map（按 id 等回执，超时 5s）①    │
│     🔀 处理 reporting-state → 更新该 conn 状态                  │
│   HTTP（loopback，沿用 httpOriginAllowed 守卫）                 │
│     🔀 GET  /api/clients          → 在线客户端列表              │
│     🔀 POST /api/clients/:id/reporting { enabled } → 定向下发  │
└──────────────────────────────────────────────────────────────┘
```

> ① result pending Map 正是 [D 方案笔记 gap #1](./2026-06-23-active-collection-exploration.md#L85) 缺的那块——本功能顺手补上，D 方案后续 MCP 工具直接复用。

## 5. 协议变更

沿用主 spec [§4.1](./2026-06-20-media-subtitle-collector-design.md#L93) 的三类消息（Command / Result / 主动消息）。命名风格：协议字段 snake_case（对齐 `ext_version`/`inserted_tracks`）；扩展内部 `chrome.storage.local` key 用 camelCase（对齐现有 `pendingIngests`），background 负责转换。

### 5.1 `hello` 扩展（扩展 → 服务端，主动消息）

```
{ type: "hello", ext_version, token, client_id, reporting_enabled }
```

- `client_id`（string，必填）：扩展首次启动生成 `crypto.randomUUID()`，持久存 `chrome.storage.local.clientId`；之后每次 hello 带上。
- `reporting_enabled`（bool，必填）：扩展当前开关状态。让 server 在握手时就拿到初值，无需额外轮询。

服务端 hello 握手（[server.ts:36](apps/collector-server/src/ws/server.ts#L36)）解析这两个新字段写入 `ExtConn`；token 校验逻辑不变。

### 5.2 新 Command `set-reporting`（服务端 → 扩展，带 id，需 result）

```
{ id, action: "set-reporting", enabled: <bool> }
```

扩展收到（[background.js](apps/subtitle-collector/background.js) 命令路由新增分支）：

1. 更新内存态 `reportingEnabled` + 写 `chrome.storage.local.reportingEnabled`；
2. 回 `{ type: "result", id, ok: true, data: { reporting_enabled: <new> } }`。

> server 是 `set-reporting` 的**发起方**，直接据 result 的 `data.reporting_enabled` 更新该 conn 状态——**此路径不发 `reporting-state`**（避免与 result 重复/乱序）。只有扩展本地 popup 触发的变化才走 `reporting-state`（§5.3）。

### 5.3 新主动消息 `reporting-state`（扩展 → 服务端，fire-and-forget）

```
{ type: "reporting-state", enabled: <bool> }
```

**仅当扩展本地触发变化（popup toggle）时**，background 发此消息；服务端收到 → 更新该 conn 的 `reportingEnabled`。`set-reporting` 命令路径的状态同步走 result（§5.2），不发此消息。

> 三条状态同步路径覆盖所有时机，server 状态始终准：`hello`（连接建立/重连全量初值）、`reporting-state`（popup 本地变化增量）、`result`（server 下发 `set-reporting` 的回执）。三者幂等，最终一致。

### 5.4 `INGEST` 咽喉加开关（扩展内部）

[background.js:74](apps/subtitle-collector/background.js#L74) 的 `INGEST` 处理入口改为先读内存态 `reportingEnabled`：

- `true` → 维持现状（WS 在线就发，否则入 `pendingIngests`）；
- `false` → **直接丢弃**（不发、不入 `pendingIngests`）。

`flushPendingIngests`（[background.js:113](apps/subtitle-collector/background.js#L113)）**不读开关**：重连补发的是历史暂存（开关开时攒下的"已承诺上报"数据），照常补发清空。语义边界——开关只闸"新的 INGEST 发不发"，不管历史 pending。

## 6. 组件改动清单

### 6.1 扩展侧 `apps/subtitle-collector`

| 文件 | 改动 |
|---|---|
| [background.js](apps/subtitle-collector/background.js) | 启动时从 storage 载入 `clientId`（无则生成）+ `reportingEnabled`（默认 true）到内存；hello 带两字段（[:36](apps/subtitle-collector/background.js#L36)）；`INGEST` 咽喉读内存开关（[:74](apps/subtitle-collector/background.js#L74)）；命令路由加 `set-reporting` 分支（[:59](apps/subtitle-collector/background.js#L59) 附近）；新增内部消息 `SET_REPORTING`（popup→bg 统一写路径：更新内存+storage+发 reporting-state）；开关变化发 `reporting-state` |
| [popup.html](apps/subtitle-collector/popup.html) | 空壳"上报"行（[:14](apps/subtitle-collector/popup.html#L14)）→ 带 checkbox toggle 的开关行；沿用现有手写 CSS 风格（CLAUDE.md 第 2 节豁免） |
| [popup.js](apps/subtitle-collector/popup.js) | 打开时读 `reportingEnabled` 渲染 toggle；onchange 发 `SET_REPORTING` 给 background |
| [manifest.json](apps/subtitle-collector/manifest.json) | **无改动**（`storage` 权限已有，[:6](apps/subtitle-collector/manifest.json#L6)） |
| [inject.js](apps/subtitle-collector/inject.js) / [content.js](apps/subtitle-collector/content.js) | **不动**（关闭语义=只断上报，采集链路保持） |

> scope 克制：popup 的"当前视频"空壳（[:13](apps/subtitle-collector/popup.html#L13)）**不顺手填**——那是 [D 方案笔记 L136](./2026-06-23-active-collection-exploration.md#L136) 列的另一项 UX 收尾，避免本轮 scope 蔓延。

### 6.2 服务端侧 `apps/collector-server`

| 文件 | 改动 |
|---|---|
| [ws/server.ts](apps/collector-server/src/ws/server.ts) | `ExtConn` 加 `clientId`/`reportingEnabled`（[:6](apps/collector-server/src/ws/server.ts#L6)）；`connections` 由 `Set` 改 `Map<clientId, ExtConn>`（同 clientId 重连替换旧的）；hello 解析 `client_id`/`reporting_enabled`（[:36](apps/collector-server/src/ws/server.ts#L36)）；新增 `sendToClient(clientId, cmd)`（定向，与现有 `broadcastCommand` 并存）；新增 `reporting-state` 处理分支（更新 conn 状态）；新增最小 result pending Map（`on('message')` 收 `result` 时按 id resolve，若是 `set-reporting` 回执则同步更新 conn 状态，5s 超时自动 reject） |
| `src/http/clients.ts`（新建）或 [http/queries.ts](apps/collector-server/src/http/queries.ts) | 新增 `GET /api/clients`、`POST /api/clients/:id/reporting` 处理 |
| [main.ts](apps/collector-server/src/main.ts) | HTTP 路由分发 `/api/clients*` 到新 handler（[:54](apps/collector-server/src/main.ts#L54) 附近，沿用 `httpOriginAllowed` 守卫） |

## 7. HTTP 接口契约（localhost:21527）

沿用主 spec [§6](./2026-06-20-media-subtitle-collector-design.md#L257) 的 loopback + `httpOriginAllowed`（[main.ts:17](apps/collector-server/src/main.ts#L17)）安全守卫——curl 无 Origin 放行。

```
GET /api/clients
  → 200 { ok:true, clients:[
       { client_id, ext_version, reporting_enabled, connected:true }
     ] }
```

仅返回当前在线（WS 已握手）的客户端。

```
POST /api/clients/:client_id/reporting
   body { enabled: <bool> }
  → 200 { ok:true, client_id, reporting_enabled: <bool> }   # 等 result 回执后
  → 404 { ok:false, error:"client not online" }             # 该 client_id 不在线
  → 504 { ok:false, error:"extension result timeout" }      # 5s 未回 result
```

服务端收到 POST → `sendToClient(client_id, { id: uuid(), action:"set-reporting", enabled })` → 把 `id` 挂到 pending Map 等 result；result 返回新状态后响应 HTTP。客户端不在线直接 404（不下发）。

## 8. 错误处理与边界

- **storage 读异常**（扩展）：`reportingEnabled` 读失败 → 视为 `true`（fail-open，不阻断上报，与"默认开"一致）。
- **client_id 缺失/损坏**：扩展每次 hello 前确保内存有 `clientId`；若 storage 读失败用临时 uuid 兜底（下次启动再生效）。
- **未知/离线 client_id**：HTTP POST 直接 404，不下发、不入队。
- **`set-reporting` 命令丢失**（WS 断线期间）：HTTP 接口等回执超时返回 504；扩展重连后状态以 hello 重新同步为准（server 不缓存"待发命令"）。
- **多扩展同 client_id**：视为同一客户端的重连/多开，`Map` 以最新连接替换旧连接（个人单机场景可接受；多机若复制了 storage 会撞 id，属部署误用，文档提示）。

## 9. 验收标准

| # | 验收项 |
|---|---|
| 1 | 扩展首次启动生成并持久化 `client_id`；hello 带上 `client_id` + `reporting_enabled` |
| 2 | popup "上报"行是可切换的开关；状态持久（关闭/重开 popup、刷新页面不丢） |
| 3 | 开关关时，新看的视频**不上报**、`pendingIngests` 不增长；WS 连接保持、`navigate`/`operate` 等命令照常 |
| 4 | 开关开时，行为与改动前完全一致（回归，零行为漂移） |
| 5 | `GET /api/clients` 返回所有在线客户端及其当前 `reporting_enabled` |
| 6 | `POST /api/clients/:id/reporting { enabled:false }` 后，该扩展停止上报；`enabled:true` 后恢复；HTTP 等到 result 回执返回新状态 |
| 7 | popup 本地改开关 → server `GET /api/clients` 能看到新状态（`reporting-state` 同步生效） |
| 8 | 两扩展同时连同一 server，能各自被独立开/关（A 关不影响 B） |
| 9 | 离线 client_id 的 POST 返回 404；断线期间命令超时返回 504 |
| 10 | collector-server / collector-web 的现有功能（ingest 入库、查询 API、网页）零回归 |

## 10. 测试方式

对齐项目 [CLAUDE.md 第 3 节](../../../CLAUDE.md)：无构建链扩展用 `scripts/verify-*.mjs`（puppeteer mock）+ `node:test` 纯函数；`collector-server`（TS）用 `node --test --import tsx`。

- **扩展侧纯函数**：把"读内存开关决定是否上报"提取为 `shouldReport(flag)`，`node:test` 测 true/false 两路。
- **扩展侧 puppeteer mock**（`scripts/verify-collector-report-toggle.mjs`，沿用现有 verify 脚本风格）：mock inject/content 产 INGEST；开关关时断言无 WS `ingest`、`pendingIngests` 不增长；开关开时断言行为同现状（回归）。
- **server 侧 node:test**：起 server，模拟两个扩展 WS 连接（带不同 client_id 的 hello）→ `GET /api/clients` 见两条 → POST 对其一关 → 断言该连接收到 `set-reporting` Command、回 result → 状态更新；另一连接不受影响。补 result pending Map 超时路径（不回 result → 504）。
- **HTTP 守卫回归**：`/api/clients*` 走 `httpOriginAllowed`（恶意 Origin/Host → 403）。

### 10.1 测试轮次记录表（实施时填写）

| 轮次 | 日期 | 测试内容 | 结果 | 发现的问题 / 修复 |
|---|---|---|---|---|
| 1 | | 扩展纯函数 shouldReport 两路 | | |
| 2 | | 扩展 puppeteer mock：开关关→不报、不暂存 | | |
| 3 | | 扩展 puppeteer mock：开关开→回归现状 | | |
| 4 | | server：双 client hello + GET /api/clients | | |
| 5 | | server：POST 定向 set-reporting + result 回执 | | |
| 6 | | server：离线 404 / 超时 504 / HTTP 守卫 403 | | |
| 7 | | 端到端：两扩展独立开/关互不影响 | | |

## 11. 风险

- **MV3 service worker 被杀**：内存态 `reportingEnabled` 随 SW 重启丢失。缓解：SW 每次唤醒从 `chrome.storage.local` 重新载入（启动 + alarm 回调）；storage 是持久源，状态不丢。
- **client_id 跨机器复制**：直接拷贝扩展 profile 会导致两机同 id，server 误判为同一客户端。缓解：文档提示 client_id 绑定本地 storage，分发/克隆 profile 需清 `clientId` 让其再生。
- **HTTP 接口等回执阻塞**：pending Map 超时设 5s，避免长挂；超时即 504，调用方可重试。
- **`set-reporting` 与本地 toggle 竞态**：server 下发关、用户同时在 popup 点开。取舍：以"最后写入者"为准（storage 最终值），并通过 `reporting-state` 让 server 对齐实际状态。不引入版本号/锁（YAGNI）。

## 12. 与 D 方案的协同 / 范围边界

本功能建立的"**client_id 身份 + 定向下发 + result pending Map**"是 [D 方案](./2026-06-23-active-collection-exploration.md) 的共用基础设施：

- **gap #1（result pending Map）**：本 spec §6.2 补齐，D 方案 MCP 工具等 `navigate` 回执直接复用。
- **定向下发**：`sendToClient` 让 D 方案的 `navigate`/`operate` 从 [broadcastCommand 广播](apps/collector-server/src/ws/server.ts#L78) 升级为"指定在某台客户端开页"——多客户端分别采集的前提。
- **`GET /api/clients`**：未来 collector-web 客户端列表页（本 spec §1 的"第二步"）和 D 方案的"选择采集终端"都消费它。

**明确不在本轮**：collector-web 客户端列表/开关 UI、D 方案的 MCP server 与 `open_bilibili_video` 工具、黑名单/白名单过滤。这些各有独立 spec / 后续增量。
