# bilibili-extensions

B 站**字幕（subtitle）**相关浏览器扩展与配套服务的 monorepo（pnpm + turbo）。

> 措辞红线：本项目是**字幕**系统，**不是弹幕（danmaku）**。详见 [CLAUDE.md](CLAUDE.md) 第 4 节。

## 目标与功能（Feature 列表）

> 项目目的：**批量**采集 B 站小众/技术向视频的字幕，**批量**提取分析，产出三种文字资产——**观点汇总**（大家怎么看某技术话题）、**面试题库**（面试内容整理）、**理念整理**（UP 主系列视频的方法论提炼）。工具链是手段，分析产物才是产出。

状态标记：✅ 已实现 ｜ 🚧 待建（当前优先级）｜ 📋 远期规划

### 批量采集（✅ 四入口全通）

- ✅ **单视频**：浏览被动入库（打开 B 站视频页自动采）+ 手动补采 `collect subtitle <bvid>`
- ✅ **UP 主批量**：`collect upper-videos <mid>` / `collect new-videos <mid>` / `collect discover <mid...>` + popup「UP 全部视频」卡勾选批量
- ✅ **YouTube 频道批量**：popup 频道卡（`@handle/**` 任意子页识别，ytInitialData + InnerTube 全量分页，勾选批量 navigate 采集）+ CLI `collect yt-videos <@handle|UCxxx|URL> [--since-days N] [--collect]`
- ✅ **合集批量**：popup 合集卡（视频属合集时列出全集 `seasons_archives_list` 全量分页，勾选批量采集上报）
- ✅ **搜索批量**：`collect search <keyword>` / `collect find <keyword>`（粉丝数/发布时间/播放量等条件过滤）；YouTube 关键词搜索 `collect yt-search <keyword> [--order relevance|newest|views] [--since-days N] [--collect]`（候选 + 未入库串行采集）
- ✅ 充电专属视频采集 + 付费标记（`videos list --paid`）
- ✅ **已采集视频刷新**：视频详情页「刷新字幕」按钮 / 采集页与历史页任务行刷新图标，一键重采（ingest 按 body_hash 幂等去重，内容未变零新增），任务行显示「已刷新：新增 X 版 / 无新增」；UP 批量勾选含已采视频时提交按钮提示将刷新
- ✅ 客户端任务派发管控：popup/options「仅上报状态」开关（关后调度器不向该客户端派采集任务，保持连接上报；多客户端时任务派给其他机器，全关留 pending）+ web 客户端页 / CLI `clients task-dispatch <id> <on|off>` 远程切换 + `clients list` 可见状态
- ✅ **无字幕标记**：采集确认无字幕（UP 未传 CC 且平台未生成 AI 字幕）自动打 `no-subtitle` 系统档标签（`videos list --tag no-subtitle` 圈定），采到字幕轨时自动摘标——历史存量回填 `scripts/backfill-no-subtitle-tags.mjs`
- 🚧 无字幕视频兜底：subtitle-extractor 浏览器本地 Whisper 转写（旁挂手动工具，未集成入库链路——转写产物暂无回流 bundle 的桥）；📋 远期改为服务端 ASR 批量转写 `no-subtitle` 标圈定的视频（落地前置：✅ 无字幕标记已就位）

### 查询与导出（✅）

- ✅ web 后台：视频库**列表布局**（一行一视频：平台图标+标题 / 创作者 / 播放 / 时长 / 轨道数 / 发布时间 / 分区 / 标签列，窄屏自动折叠次要列）、多维筛选搜索（关键词、字幕正文、**多标签下拉多选**、标签档位、分区、时间、时长/播放区间等；全部 URL query 承载，刷新/分享还原，视频详情的轨/版本选择亦进 URL）、UP 主 / 分类管理 / 采集日志；**原站外链跳转**（视频标题旁 ↗ 开 B 站/YouTube 视频页、UP 名/创作者 ↗ 开空间页/频道页，覆盖视频库/详情/创作者/任务卡各处，站内详情整行点击不受影响）
- ✅ 采集任务历史页多维查询：按 UP（名字模糊 / mid 精确；任务行 UP 归属冗余——批量提交/重采/ingest 回填，未入库/失败任务也命中）、时间范围（今天 / 近7天 / 近30天 / 自定义）、平台、采集方式（批量/单点）、标题/关键词（vid 段搜 BV 号）、批次聚焦筛选；URL query 承载，可刷新/分享还原；重试并入原批次（聚焦视图实时看重试行，不另开新批）、任务全部到终态时浏览器系统通知（提交/重试后切走标签页，跑完即被提醒）
- ✅ 视频标签六档：manual/batch/ai/system（落表，system=系统状态标如 no-subtitle，采集链路自动打/摘）+ bili（视频自带）/ **season（合集，只读实时读 extra.ugc_season.title）**，tag_priority 可调 + 按档位过滤/聚合
- ✅ 字幕正文全文检索：`sub search <keyword>`（带时间戳定位片段）
- ✅ 导出：`export subtitle`（srt/vtt/txt/json）、`export videos`（csv/ndjson/table）

### 批量提取分析（🚧 当前最大缺口，消费端）

- ✅ **原料包导出** `export bundle`：按 UP 主 / 搜索主题 / 任意过滤器，把一批视频的元信息 + 字幕打包成分析原料目录（manifest.json + videos/*.txt + ANALYZE.md 三件套，正文为 `[分:秒] 字幕` 行格式）
- 🚧 **分析产物规范**：bundle → Claude Code 会话分析 → 产物落盘 `analysis/<主题>/`，三类模板：
  - **观点汇总**：某技术话题，多个 UP 主怎么看（含分歧与共识）
  - **面试题库**：面试相关视频 → 题目 + 考点 + 参考答案
  - **理念整理**：某 UP 主系列视频 → 核心理念 / 方法论提炼
- 📋 内置 AI pipeline（CLI 一条命令自动分析，需 API 集成）：远期，待手动流程跑顺后再评估
- 📋 评论采集：远期（当前分析数据源 = 视频/字幕内容，不含评论区）

## 架构

| App | 类型 | 作用 |
|---|---|---|
| [apps/subtitle-collector](apps/subtitle-collector) | 浏览器扩展（MV3，Vite + @crxjs 构建） | 在 B 站页面注入、抽取字幕元信息，经 WebSocket 上报给本地服务端 |
| [apps/collector-server](apps/collector-server) | 后端（Node + TS） | 本地回环服务：收扩展上报（WS `/ext`）+ HTTP API（`/api/*`）+ 静态托管 web 产物 |
| [apps/collector-web](apps/collector-web) | 前端（React + Vite） | 字幕库浏览/详情 UI；`vite build` 产物直接写入 `apps/collector-server/public/`，由 server 托管 |
| [apps/subtitle-extractor](apps/subtitle-extractor) | 浏览器扩展（MV3，Vite + transformers.js） | B站音轨提取 → 浏览器本地 Whisper 转写 → SRT/VTT 导出（无字幕视频兜底，零后端、数据不出本机） |

数据流（默认部署为本地闭环，`127.0.0.1`；暴露部署见「环境变量」）：

```
浏览器(B站页面) ──MV3扩展──WS──▶ collector-server(21527) ◀──HTTP── 浏览器(collector-web UI)
                                      │
                                      ▼
                                 SQLite (.db)
```

## 前置要求

- **Node 22**（见 [.nvmrc](.nvmrc)；`@types/node@^22`、`better-sqlite3`、`puppeteer` 在 22 上稳定）
- **pnpm 9.15.4**（`package.json` 声明了 `packageManager`，启用 Corepack 会自动锁版：`corepack enable`）

## 快速开始

```bash
# 1. 安装依赖（根目录一次到位，含 ws / better-sqlite3 / puppeteer）
pnpm install

# 2. 启动本地服务端（终端 A，监听 http://127.0.0.1:21527）
pnpm --filter @bilibili-ext/collector-server dev

# 3. 构建前端产物（首次或 web 改动后；产物落到 collector-server/public）
pnpm --filter @bilibili-ext/collector-web build

# 4. 构建并加载扩展到 Chrome
pnpm --filter @bilibili-ext/subtitle-collector build   # 产物到 apps/subtitle-collector/dist/
#    打开 chrome://extensions/ → 开启「开发者模式」→「加载已解压的扩展程序」
#    → 选择 apps/subtitle-collector/dist 目录（crxjs 生成的构建产物，含 manifest.json）
```

> 一键多终端替代：`pnpm dev`（= `turbo dev`）并行起 server + collector-web + 扩展三端的 dev server；扩展 dev server 端口在 [vite.config.ts](apps/subtitle-collector/vite.config.ts) 用 `server.strictPort` 钉死为 **5174**，避免与 collector-web（默认 5173）端口漂移、把不一致的端口烧进 dist 而触发 CRXJS popup 闪烁死循环。扩展本身仍需手动加载 dist 到浏览器。

加载扩展后，popup 显示「已连接 ✓」需要满足：
1. collector-server 已在 `127.0.0.1:21527` 运行；
2. 扩展 popup 里激活的 server 是默认的 `ws://127.0.0.1:21527/ext`（server 端不设 `COLLECTOR_TOKEN` 时开箱即连，URL 不带 query）。

server 端**可选**设置 `COLLECTOR_TOKEN`：设置后扩展的 server URL 必须带 `?token=xxx`（在 popup 服务器配置里填完整 URL），CLI 请求必须带 Bearer token；不设则是无 token 模式（适合内网）。

## 环境变量

只有 collector-server 读取环境变量，详见 [apps/collector-server/.env.example](apps/collector-server/.env.example)。五项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `COLLECTOR_PORT` | `21527` | HTTP + WS 监听端口 |
| `COLLECTOR_DB_PATH` | `./bilibili-collector.db` | SQLite 路径 |
| `COLLECTOR_TOKEN` | 空（无 token 模式） | 可选鉴权 token；设置后扩展 server URL 须带 `?token=xxx`、CLI 须带 Bearer，暴露部署必须设置 |
| `COLLECTOR_HOST` | `127.0.0.1` | 监听地址，默认仅 loopback（防 DNS rebinding）。Docker / 暴露部署设 `0.0.0.0`，此时必须设置 `COLLECTOR_TOKEN`（启动强校验） |
| `COLLECTOR_ALLOWED_HOSTS` | 空（仅 loopback） | 显式放行非 loopback 的 Host/Origin，逗号分隔（如 `192.168.1.5,collector.local`）；配合 `COLLECTOR_HOST=0.0.0.0` 暴露部署，设置后必须设 `COLLECTOR_TOKEN`（`/api/*` 强制 Bearer） |

关键约束：
- 服务端默认监听 `127.0.0.1`（防 DNS rebinding），并非固定不可改：需暴露部署（局域网 IP / caddy 域名）时用 `COLLECTOR_HOST=0.0.0.0` + `COLLECTOR_ALLOWED_HOSTS` 显式放行访问 Host，且此时必须设置 `COLLECTOR_TOKEN`（启动强校验，见 [apps/collector-server/src/main.ts](apps/collector-server/src/main.ts)）。
- **改 `COLLECTOR_PORT` 时**，须同步修改扩展 popup 里配置的 server URL；**设了 `COLLECTOR_TOKEN` 时**，扩展的 server URL 须带 `?token=xxx`、CLI 须带 Bearer（扩展侧不再有 config.js 常量，server 列表存扩展 storage，popup 可改）。
- 当前代码直接读 `process.env`（未集成 dotenv）。开发期可 `COLLECTOR_TOKEN=xxx pnpm dev` 注入；生产可 `node --env-file=.env dist/main.js`。

## 测试

```bash
pnpm test        # turbo run test：三端单测（server c8 / web vitest / 扩展 c8，各带覆盖率锁定）
pnpm qa          # 全量质量门：build + test + 静态质量台账 check + depcruise（细则见 docs/quality/RULES.md）
pnpm test:ext    # puppeteer mock 扩展回归（scripts/verify-collector.mjs，按需手动，不进 qa）
```

- **单测**（`pnpm test`）：[apps/collector-server](apps/collector-server)（c8 + node:test）、[apps/collector-web](apps/collector-web)（vitest + jsdom + Testing Library）、[apps/subtitle-collector](apps/subtitle-collector)（c8 包裹 node --test，import 源码）；三端覆盖率按锁定线只升不降。
- **质量门**（`pnpm qa`）：涉代码提交前手动跑——build + test + 圈复杂度/模块大小台账 + 依赖结构检查；政策见 [CLAUDE.md](CLAUDE.md) 第 3 节与 [docs/quality/RULES.md](docs/quality/RULES.md)。
- **扩展 e2e**（`pnpm test:ext`）：puppeteer 起 mock server + `--load-extension` 端到端回归。**仅在本地运行**（脚本当前按 macOS 的 Chrome 路径定位，且 MV3 扩展需要 headed 浏览器）。
- **构建冒烟**：`pnpm --filter @bilibili-ext/collector-web build` 与 `pnpm --filter @bilibili-ext/subtitle-collector build`（见 CI）。

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) 在 push/PR 时跑：
1. `pnpm test`（单测）
2. collector-web `vite build` 冒烟 + 产物存在性校验

> puppeteer 扩展 e2e **不在 CI 内**（脚本 macOS 专用、需 headed Chrome），请在本地 `pnpm test:ext`。

## 项目约定

- 开发规范、样式政策、测试质量政策、字幕/弹幕措辞红线：见 [CLAUDE.md](CLAUDE.md)。
- 服务端运维手册：见 [MANUAL-collector.md](MANUAL-collector.md)。
- 设计文档与实现计划：见 [docs/superpowers/specs/](docs/superpowers/specs) 与 [docs/superpowers/plans/](docs/superpowers/plans)。
- 变更记录：见 [CHANGELOG.md](CHANGELOG.md)。
