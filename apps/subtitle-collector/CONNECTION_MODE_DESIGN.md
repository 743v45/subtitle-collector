# 连接模式（server / 纯扩展）设计

> 功能：扩展的「已连接」状态支持用户主动切换为「不连接」（纯扩展），此时上报相关功能灰掉，适用于无 server 的纯扩展场景；可随时切回。
>
> 对齐项目 [CLAUDE.md](../../CLAUDE.md) §3 测试政策（subtitle-collector：纯函数 node:test + vite build 冒烟 + verify-*.mjs）。

## 1. 背景与目标

当前扩展启动即连本地 `collector-server`（WebSocket `ws://127.0.0.1:21527/ext`），断线指数退避重连 + `keepalive` alarm 每 24s 唤醒重连——**无 server 时永连永败**，且 popup 一堆依赖 server 的功能（同步状态/UP 主卡/上报）在红点「未连接」下仍有噪音。

目标：新增用户可控的**连接模式**开关。

- `server`（默认，向后兼容）：连 server，可上报，现有行为不变
- `standalone`（纯扩展）：不连 server、不上报，灰掉/隐藏所有依赖 server 的 UI，只保留本地字幕捕获 + 复制

## 2. 现状定位

| 关注点 | 位置 |
|---|---|
| WS 连接 | [background.js:102](background.js#L102) `connect()`：`probeServer` → `new WebSocket` |
| 断线重连 | [background.js:96](background.js#L96) `scheduleReconnect`（2s→10s 退避）；[background.js:323](background.js#L323) `onclose` 触发 |
| 保活 | [background.js:65](background.js#L65) `keepalive` alarm 每 0.4min，未 OPEN 则 `connect()` |
| 启动 | [background.js:461](background.js#L461) `loadPersistedState().then(loadNavGapConfig).then(connect)` |
| 状态查询 | [background.js:360](background.js#L360) `WS_STATUS` → `{ connected: ws?.readyState === OPEN }` |
| popup 状态 | [hooks.ts:19](src/popup/hooks.ts#L19) `useConnectionStatus` 每 2s 拉；[Popup.tsx:275](src/popup/Popup.tsx#L275) `ConnDot` 绿/红 |
| 上报 | [background.js:441](background.js#L441) `sendIngest`（断线存 `pendingIngests` @445）；被动 [background.js:336](background.js#L336) |
| 上报开关 | [reporting.mjs:9](reporting.mjs#L9) `shouldReport`（自动/手动，独立维度） |

**连接状态不入 storage**，完全由 WS 实时 `readyState` 派生——本功能首次引入持久化的「模式」概念。

## 3. 设计

### 3.1 模式定义与持久化

新增纯逻辑 [connection-mode.mjs](connection-mode.mjs)（不依赖 `chrome.*`，可 node:test）：

- `CONNECTION_MODE_KEY = "connectionMode"`（camelCase 对齐 `reportingEnabled`/`clientId`）
- `MODE_SERVER = "server"` / `MODE_STANDALONE = "standalone"`
- `resolveConnectionMode(v)`：非 `'standalone'` 一律 `server`（fail-回 server，向后兼容）
- `isStandalone(mode)`：归一后判定

### 3.2 background.js 行为

| 点 | server（现状） | standalone（新） |
|---|---|---|
| 启动 `connect()` | 调 | **不调** |
| `keepalive` alarm | 未 OPEN→connect | **noop** |
| `scheduleReconnect` | 退避重连 | **不重连**（`connectionMode` 守卫） |
| `sendIngest` / 被动 INGEST | 发/存 pending | **短路丢弃** |
| `WS_STATUS` 回执 | `{connected}` | `{connected, mode}` |

新增消息 `SET_CONNECTION_MODE`：
- `server → standalone`：`ws?.close()`、置 `connectionMode=standalone`（阻止 `onclose`→`scheduleReconnect`）、清空 `pendingIngests`
- `standalone → server`：置 `connectionMode=server`、调 `connect()`

### 3.3 popup UI

- `useConnectionStatus`（[hooks.ts:19](src/popup/hooks.ts#L19)）改为返回 `{ mode, connected }`，`WS_STATUS` 回执取 `mode`
- `ConnDot`（[Popup.tsx:275](src/popup/Popup.tsx#L275)）三态可点击：

  | 状态 | 视觉 | 点击行为 |
  |---|---|---|
  | `mode=server` + WS OPEN | 🟢 已连接 | → 切 standalone |
  | `mode=server` + WS 断 | 🔴 未连接 | → 切 standalone |
  | `mode=standalone` | ⚪ 纯扩展 | → 切 server（触发 connect） |

- `mode=standalone` 时：[FooterActions:315](src/popup/Popup.tsx#L315)（上报开关+手动上报）置灰 disabled；[SyncStatusBadge:669](src/popup/Popup.tsx#L669) / [CreatorCard:597](src/popup/Popup.tsx#L597) / [UpperVideosList:644](src/popup/Popup.tsx#L644) / [ClientIdFoot:372](src/popup/Popup.tsx#L372) 不渲染

### 3.4 content.js 不改

本地字幕捕获照常（[content.js:130](content.js#L130) 发 INGEST 无 callback），background 在 standalone 丢弃 INGEST，content.js 零感知。本地字幕列表/复制（[SubtitleCopySection:724](src/popup/Popup.tsx#L724)）是纯扩展核心价值，保留。

## 4. 与「自动/手动上报」开关的关系

两个独立维度，并存：

- **连接模式**（本功能）：要不要连 server
- **上报开关**（[reporting.mjs](reporting.mjs)，现有）：连上 server 后，自动 vs 手动上报

standalone 下上报开关置灰（无 server 可上报）。

## 5. 边界与降级

- standalone 下 content.js 读 `reportingEnabled`（[content.js:23](content.js#L23)）仍决定浏览时是否自动点 AI 字幕——现有行为不变；默认 `reportingEnabled=true` 时纯扩展仍能本地拿到 AI 字幕体并复制
- 切回 server 后 WS 异步重连，期间显示「未连接」红点属正常（客观连通性）
- `pendingIngests`：切 standalone 时清空（永不补发）；切回 server 后新的断线才重新累积

## 6. 测试计划

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | [test/connection-mode.test.mjs](test/connection-mode.test.mjs) | `resolveConnectionMode`/`isStandalone` 各分支 + 常量稳定 |
| 构建冒烟 | `pnpm build`（vite + crxjs） | popup/background/content 打包通过 |
| 端到端 | [scripts/verify-connection-mode.mjs](../../scripts/verify-connection-mode.mjs) | standalone 不连 WS、INGEST 丢弃；切回 server 恢复连接+上报 |

## 7. 功能验收清单

| # | 项 | 验证手段 | 状态 |
|---|---|---|---|
| 1 | 默认 `server` 模式，扩展行为与改动前一致 | 代码审查 + build | ✅ |
| 2 | 切 standalone：WS 主动 close、不再重连 | verify 端到端 | ✅ |
| 3 | standalone 下被动 INGEST 被丢弃 | verify 端到端 | ✅ |
| 4 | standalone 下 popup 上报相关 UI 灰掉/隐藏 | 代码审查 + build | ✅ |
| 5 | standalone 下本地字幕捕获+复制仍可用 | 代码审查（content.js 未改） | ✅ |
| 6 | standalone 下 ConnDot 显示「纯扩展」(灰) | 代码审查 | ✅ |
| 7 | 切回 server：恢复 connect + 上报 | verify 端到端 | ✅ |
| 8 | 重启 SW（alarm 唤醒）后模式持久 | 代码审查（loadPersistedState 读 storage） | ✅ |
| 9 | 纯函数测试全绿 | `node --test` | ✅ 47/47 |
| 10 | vite build 冒烟通过 | `pnpm build` | ✅ |

> 全部 10 项通过。端到端 verify 见 R2（停 collector-server 释放 21527 后跑通）。

## 8. 测试轮次记录表

| 轮次 | 日期 | 范围 | 结果 | 备注 |
|---|---|---|---|---|
| R1 | 2026-07-07 | 纯函数（含 connection-mode，共 47 项）+ vite build 冒烟 | ✅ 通过 | `node --test` 47/47；`pnpm build` 无错 |
| R2 | 2026-07-07 | verify-connection-mode.mjs 端到端 | ✅ 通过 | 停 collector-server 释放 21527 后跑通：server 收 ingest(1) → standalone 丢 ingest(0) → server 恢复 ingest(1)+重连 hello(3) |
