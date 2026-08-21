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
- ✅ **搜索批量**：`collect search <keyword>` / `collect find <keyword>`（粉丝数/发布时间/播放量等条件过滤）
- ✅ 充电专属视频采集 + 付费标记（`videos list --paid`）
- ✅ 无字幕视频兜底：subtitle-extractor 浏览器本地 Whisper 转写

### 查询与导出（✅）

- ✅ web 后台：视频库浏览 / 搜索 / UP 主 / 分类管理 / 采集日志
- ✅ 视频标签五档：manual/batch/ai（落表）+ bili（视频自带）/ **season（合集，只读实时读 extra.ugc_season.title）**，tag_priority 可调 + 按档位过滤/聚合
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

数据流（本地闭环，全部跑在 `127.0.0.1`）：

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
2. [apps/subtitle-collector/config.js](apps/subtitle-collector/config.js) 的 `TOKEN` 与服务端 `COLLECTOR_TOKEN` **完全一致**（默认都是 `change-me-collector-token`，生产部署务必改掉）。

## 环境变量

只有 collector-server 读取环境变量，详见 [apps/collector-server/.env.example](apps/collector-server/.env.example)。三项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `COLLECTOR_PORT` | `21527` | HTTP + WS 监听端口 |
| `COLLECTOR_DB_PATH` | `./bilibili-collector.db` | SQLite 路径 |
| `COLLECTOR_TOKEN` | `change-me-collector-token` | WS 握手 token，**生产必须改成随机串** |

关键约束：
- 服务端固定监听 `127.0.0.1`（防 DNS rebinding，不可改 bind host）。
- **改 `COLLECTOR_PORT` / `COLLECTOR_TOKEN` 时，必须同步修改** [apps/subtitle-collector/config.js](apps/subtitle-collector/config.js)（扩展侧是硬编码常量，不走 env）。
- 当前代码直接读 `process.env`（未集成 dotenv）。开发期可 `COLLECTOR_TOKEN=xxx pnpm dev` 注入；生产可 `node --env-file=.env dist/main.js`。

## 测试

```bash
pnpm test        # turbo run test：collector-server 单测 + subtitle-collector 单测（node:test）
pnpm test:ext    # puppeteer mock 扩展回归（scripts/verify-collector.mjs）
```

- **单测**（`pnpm test`）：跑 [apps/collector-server](apps/collector-server) 的 4 个 `*.test.ts`（db/http/ws）与 [apps/subtitle-collector](apps/subtitle-collector) 的 `reporting/wbi/subtitleFormat.test.mjs`（纯函数，import 源码）。
- **扩展 e2e**（`pnpm test:ext`）：puppeteer 起 mock server + `--load-extension` 端到端回归。**仅在本地运行**（脚本当前按 macOS 的 Chrome 路径定位，且 MV3 扩展需要 headed 浏览器）。
- **构建冒烟**：`pnpm --filter @bilibili-ext/collector-web build` 与 `pnpm --filter @bilibili-ext/subtitle-collector build`（见 CI）。

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) 在 push/PR 时跑：
1. `pnpm test`（单测）
2. collector-web `vite build` 冒烟 + 产物存在性校验

> puppeteer 扩展 e2e **不在 CI 内**（脚本 macOS 专用、需 headed Chrome），请在本地 `pnpm test:ext`。

## 项目约定

- 开发规范、样式政策、测试政策、字幕/弹幕措辞红线：见 [CLAUDE.md](CLAUDE.md)。
- 服务端运维手册：见 [MANUAL-collector.md](MANUAL-collector.md)。
- 设计文档与实现计划：见 [docs/superpowers/specs/](docs/superpowers/specs) 与 [docs/superpowers/plans/](docs/superpowers/plans)。
- 变更记录：见 [CHANGELOG.md](CHANGELOG.md)。
