# UP 主全部视频列表 + 批量采集 — 设计

日期：2026-08-19
状态：已确认（用户拍板直接实施）

## 背景

popup 此前仅在视频页展示 UP 最新 5 条视频（被动缓存）。需求演进为：
1. 空间页（`space.bilibili.com/{mid}`）与视频页都能在 popup 列出 UP **全部**投稿视频（总数、折叠展开、已采状态）。
2. popup 支持勾选（pick）+ 过滤（状态/时间/播放量）+ **批量采集**（即批量手动上报）。
3. collector-web 采集页支持输入 mid/空间链接批量采集；server 支持批量建任务。

## 架构决策

- **批量执行零新增**：复用现有采集任务系统（`collect_tasks`，pending → dispatched → succeeded/failed，调度器每扩展串行派发 `fetch-subtitle` 免导航直接调 B 站 API，天然防风控）。
- **server 不直连 B 站**：web 端要拉 UP 全量列表时，server 经扩展 WS `list-upper-videos` action 分页代理拉取（扩展有浏览器环境 + wbi 签名）。
- **popup 数据源**：background `arc/search` 全量分页（ps=30，页间 500ms 节流防 -412），每页落 `chrome.storage.local['upperAllVideos:${mid}']`（TTL 1h），popup 经 `storage.onChanged` 增量渲染进度。

## 阶段一：popup 列表 + 采集状态

### server
- `VideoFilter` 加 `creator_uid`（source_uid 精确，子查询 `v.creator_id IN (SELECT id FROM creators WHERE source_uid = ?)`）；`/api/videos?creator_uid=X` 供 popup/web 查已采集合。不用 `/api/creators?q=` LIKE（误匹配 + 两次请求）。

### 扩展
- background `fetchAllUpperVideos(mid)`：inflight Map 去重；每页写 storage + 中断（风控）保留已拉部分 + error 标记。
- 消息契约：popup → `{type:'FETCH_UPPER_ALL', mid}` → `{ok, status:'cached'|'started'|'inflight'}`；storage 是唯一数据真相。
- popup hooks：`useSpaceMid()`（URL 解析空间页 mid）、`useUpperAllVideos(mid)`（storage.onChanged 驱动）、`useCreatorCollected(mid, httpBase)`（分页拉已采 bvid 集合）。
- `UpperAllVideosCard` **替换** `UpperVideosList`：收起态「共 N 条 · 已采 M」，展开滚动列表（已采 ✓/未采 + 标题 + 时长/播放/日期）。

## 阶段二：批量采集

- 过滤条件：状态 tab（全部/未采/已采）+「全选未采」+ 时间档位（全部/近半年/近一年）+ 播放量下限档位（不限/1千/1万/10万）。
- popup：勾选 + 「采集选中 (N)」→ `POST /api/collect-tasks/batch`；N>50 confirm 防呆。
- server：
  - `POST /api/collect-tasks/batch {bvids[]}`：批量建任务，去重（同 bvid 已有 pending/dispatched 跳过；succeeded 允许重采）→ kick 调度器 → `{created, skipped}`。
  - `POST /api/upper-videos/expand {mid}`：经扩展 WS 分页循环拉全量 + 查库标已采 → `{total, items}`。扩展离线报错。main.ts 加 `/api/upper-videos` 路由。
- collector-web 采集页：「按 UP 批量」区块（输入 mid/链接 → 拉取 → 过滤+勾选 → 批量提交）。

## 错误处理

- 扩展离线：expand 端点返回错误；批量任务留 pending（现有行为）。
- B 站风控中断：popup 显示「已拉 N/共 M · 中断」，已拉部分可勾选。
- 纯扩展模式（popup）：列表可用，已采状态与采集按钮隐藏。

## 不做（YAGNI）

server 直连 B 站 API、多扩展路由、采集进度实时推送（轮询已够）、时长区间过滤。

## 测试轮次记录表

| 轮次 | 命令 | 结果 |
|---|---|---|
| 1 | `node --test --import tsx "src/**/*.test.ts"`（collector-server，含新增 creator_uid×4 / createTasksBatch×2 / expandUpperVideos×2 用例） | ✅ 275 pass / 0 fail |
| 2 | `pnpm turbo run build`（collector-server tsc + subtitle-collector vite + collector-web vite） | ✅ 3 successful |
| 3 | `pnpm turbo run test` 全量（server 275 + 扩展 node:test + web router/videoFilterUrl） | ✅ 3 successful / 0 fail |

备注：vite build 不做类型检查；`npx tsc --noEmit` 报的 Options.tsx / subtitleFormat.mjs / web 测试文件错误均为存量问题（不在本次改动文件内），未修复以保持改动聚焦。
