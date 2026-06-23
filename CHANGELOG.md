# CHANGELOG

字幕采集系统的里程碑记录。被动采集链路（浏览即入库）为第一个可用的阶段性成果。

---

## v0.1 —— 被动采集 MVP（浏览即入库）

> 状态：**可用**。打开 B 站视频页，扩展自动拦截 player API + 字幕轨，上报本地服务端落 SQLite，网页可查阅。

### 能力

- **扩展（apps/subtitle-collector）**：MAIN world hook 拦 `api.bilibili.com/x/player` 抽元信息 + 字幕轨列表；字幕体改由 background 用 host_permissions 免 CORS 抓取（B 站新版播放器改用同源 protobuf endpoint，旧 aisubtitle 请求拦不到）。WS 连服务端，浏览时被动上报 `ingest`；WS 断线暂存 `chrome.storage.local`，重连补发；MV3 SW 用 alarms 保活。
- **服务端（apps/collector-server）**：loopback HTTP + WS。WS 收 `ingest` 幂等去重写四层表（creators/videos/subtitle_tracks/subtitle_versions）+ change_log，回 `ingest-ack`；`verifyClient` + 握手 token 防非扩展接入。HTTP 提供 `/ping` 探活 + `/api/videos` 列表搜索 + `/api/videos/:source/:source_vid` 详情 + `/api/versions/:id` 取 payload + 静态托管 collector-web。
- **网页（apps/collector-web）**：React + Vite + Tailwind + shadcn/ui。列表（标题/创作者搜索、分页、入库时间倒序）+ 详情（轨切换器 + 版本切换器 + 时间轴逐行 + 复制）。
- **信号区分**：subtitle_url 为空时区分 风控 / 需登录 / 无字幕 / 单轨缺失 四种情况。

### 已实现但未接线（spec 预留，服务端尚无调度方调用）

- `navigate` Command：background 已实现 `chrome.tabs.create`，但服务端无任务调度层下发。
- `operate` Command：content.js 已实现 click-subtitle-toggle + 观察窗口，无调用方。
- `fetch-subtitle` Command：占位（返回 not implemented）。

### 已知空壳（未实现）

- popup「当前视频」「上报」两行：DOM 存在但 popup.js 未赋值。
- popup「手动补采」按钮：可点但无反馈；依赖 `collected` Map 已有数据，错过加载时机则无效。

### 关键设计文档

- [媒体字幕采集库设计（MVP spec）](docs/superpowers/specs/2026-06-20-media-subtitle-collector-design.md)
- [主动采集/服务端控制中心 设计探索笔记（未定稿）](docs/superpowers/specs/2026-06-23-active-collection-exploration.md)

---

## 下一里程碑（规划中，未开工）

**主动采集 / 服务端控制中心** —— 把 collector-server 从"被动接收器"升级成"采集大脑"：服务端表达需求 → 拉视频列表 → 控制采集速度 → 驱动采集终端逐个入库 → 进度可见。详见上方探索笔记，核心架构岔路（结构化任务 API vs AI Agent 对话循环 vs 实验驱动）待拍板。
