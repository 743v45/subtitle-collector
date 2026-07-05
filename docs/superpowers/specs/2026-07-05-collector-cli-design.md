# collector-cli 设计文档

> 给 agent 用的 CLI，统一管控整个 bilibili-extensions 项目 + 按条件查询字幕采集数据。
> 状态：已批准方案 C（混合架构）+ 全范围，2026-07-05。

## 1. 目标与非目标

**目标**：
- 一个 CLI 入口接管整个项目：数据查询、客户端管控、数据导出/汇总、server 运维。
- **按条件查询**：UP/分区/标签/语言/轨类型/时间范围/stat 等，多排序键，分页。补齐现有 HTTP API 只支持 title/UP 模糊的缺口。
- **agent 友好**：stdout 纯结构化数据（默认 JSON），stderr 放人类日志，语义化退出码，幂等可管道，每命令 `--help`。

**非目标**：
- 不做交互式 TUI（agent 用，非人类交互）。
- 不重写采集端（subtitle-collector 扩展不动，仅复用其上报的数据）。
- 不替代 collector-web（web 仍为人类浏览页；CLI 面向 agent/脚本）。

## 2. 架构（方案 C：混合通道）

按职责分数据通道，避免单通道的能力天花板：

| 职责域 | 通道 | 理由 |
|---|---|---|
| 查询 / 导出 / 汇总 | **直连 SQLite（只读）** | 能查 change_log / stat / 任意条件，离线可用，复用 server 的 db 层 |
| 客户端管控（列表/切上报/下发命令） | **走 server HTTP** | WS 连接活在 server 进程，CLI 另起进程只能经 server 触达 |
| server 运维（探活/状态/起停） | **HTTP `/ping` + 本地进程** | 探活走 HTTP；起停走 pid 文件 |

**WAL 改动**（targeted improvement）：在 [db/migrate.ts](apps/collector-server/src/db/migrate.ts) `migrate()` 里加 `db.pragma('journal_mode = WAL')`。WAL 是 DB 持久属性，server 启动时设一次后，CLI 只读连接（`new Database(path, { readonly: true })`）即可与 server 写并发，不抢锁。现有测试需复核不破。

## 3. 命令树

全局选项（所有命令）：
```
--format <json|ndjson|csv|table>   输出格式，默认 json
--db <path>                        SQLite 路径，默认 $COLLECTOR_DB_PATH 或 apps/collector-server/bilibili-collector.db（import.meta.url 绝对解析）
--server <url>                     server URL，默认 http://127.0.0.1:21527
--token <token>                    鉴权 token，默认 $COLLECTOR_TOKEN
-q, --quiet                        抑制 stderr 日志
-h, --help / -v, --version
```

### 3.1 数据查询（直连 DB，只读）
```
collector-cli videos list [--q <text>] [--creator <name>] [--source <src>]
                          [--tid <id>] [--tname <name>] [--tag <tag>]
                          [--lang <zh|en|...>] [--track-type <1|2>]
                          [--has-subtitle] [--since <ts>] [--until <ts>]
                          [--min-duration <s>] [--max-duration <s>]
                          [--sort first_seen|published_at|title|duration|view]
                          [--desc] [--page <n>] [--size <n>]
collector-cli videos get <source> <source_vid>          # 详情含轨/版本（默认标记）
collector-cli videos get-by-id <id>
collector-cli versions get <id>                          # 取单条 version 的 payload
collector-cli changes list [--entity videos|subtitle_versions|...]
                           [--entity-id <id>] [--field <f>]
                           [--since <ts>] [--until <ts>] [--page <n>] [--size <n>]
```
- `--since/--until` 接受 Unix 秒/毫秒或 ISO8601，统一规范化为毫秒时间戳比对 `first_seen_at`（changes 比对 `changed_at`）。
- `--tag` 对 `extra.tags[].tag_name` 做 `LIKE %tag%`；`--tid/--tname` 对 `extra.tid/tname`；`--sort view` 从 `extra.stat.view` 解析。

### 3.2 数据导出 / 汇总（直连 DB，只读）
```
collector-cli export subtitle <source> <source_vid>
                          [--track <lan>] [--version <id>]
                          [--sub-format srt|vtt|txt|json] [-o <file>]
                          # 不指定 track/version 则取默认轨默认版本
                          # 注：字幕格式用 --sub-format（避开全局 --format 同名冲突，见 §9）
collector-cli export videos [--同 list 过滤] [-o <file>]
                          # 格式由全局 --format 控制（json|csv|ndjson）；table 不支持
collector-cli stats overview                  # 总视频/轨/版本/UP/语言/分区数 + 时间范围
collector-cli stats count --by creator|tname|lang|track-type [--过滤] [--top <n>]
```
- 字幕格式转换参考 [info/body.json](info/body.json) 样本与 [scripts/body2subtitle.py](scripts/body2subtitle.py)；payload 是 B 站字幕 JSON（`body: [{from,to,content}, ...]`）。

### 3.3 客户端管控（走 server HTTP）
```
collector-cli clients list                                      # GET /api/clients
collector-cli clients reporting <client_id> <on|off>            # POST /api/clients/:id/reporting
collector-cli clients command <client_id> <action>
                                [--op <op>] [--url <url>] [--vid <vid>]
                                [--wait] [--timeout <ms>]       # POST /api/clients/:id/command（新增）
```
- `action ∈ navigate | operate | fetch-subtitle`，对应扩展端 [background.js:65](apps/subtitle-collector/background.js#L65) 已实现的处理（`fetch-subtitle` 扩展端为占位 not-implemented，CLI 如实返回回执）。
- **`--wait` 收窄**：server 端 `requestCommand` 总是同步等扩展 `result` 回执或 timeout，行为恒为"等"，故 CLI **不暴露 `--wait`**，等待上限由 `--timeout`（默认 5000ms）控制。

### 3.4 server 运维
```
collector-cli server ping                    # GET /ping，探活
collector-cli server status                  # online/端口/DB 路径/DB 行数/在线客户端数/配置
collector-cli server start [--detached] [--port <p>] [--db <path>]   # spawn + pid 文件
collector-cli server stop                    # 读 pid kill
```
- pid 文件：`apps/collector-server/.collector-server.pid`（加入 .gitignore）。
- `start` 用 `child_process.spawn` detached + `unref`，stdio 重定向到 `apps/collector-server/.collector-server.log`。

## 4. 输出与退出码约定（agent 友好）

**stdout**：纯数据。
- 成功：数据 JSON（list 类 → `{total,page,size,items}`；单条 → 对象；`--format ndjson` → 每行一个 item；`csv` → 表格；`table` → 人类对齐）。
- 失败：`{"ok":false,"error":"<msg>","code":"<CODE>"}`。

**stderr**：人类可读日志/进度（`-q` 抑制）。

**退出码**：
| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 运行时错误（查询失败、server 返回错误等） |
| 2 | 参数/用法错误 |
| 3 | server 不可达（管控/运维命令） |
| 4 | DB 不可读（查询/导出命令） |
| 5 | 未找到（如 `videos get` 404） |

## 5. 技术选型与落点

- **命令行库**：`commander` ^12（成熟、子命令树、`--help` 自动、TS 友好）。加到 `apps/collector-server` dependencies。
- **落点**：`apps/collector-server/src/cli/`，入口 `src/cli/main.ts`；`package.json` 加 `"bin": {"collector-cli": "./dist/cli/main.js"}`；开发期用 `tsx src/cli/main.ts`。
- **DB 只读连接**：CLI 侧 `new Database(path, { readonly: true })`，享受 server 设的 WAL。
- **查询层**：新建 [src/db/advanced.ts](apps/collector-server/src/db/advanced.ts)（`listVideosFiltered` / `getChanges` / `aggregateStats` / `countOverview` / `getVideoByDbId`），不动现有 `db/queries.ts`（HTTP 兼容）。
- **下发命令端点**：[ws/server.ts](apps/collector-server/src/ws/server.ts) 加 `requestCommand`（仿 `requestReportingChange`）；[http/clients.ts](apps/collector-server/src/http/clients.ts) 加 `POST /api/clients/:id/command` 路由。
- **根 package.json**：加 `"cli": "pnpm -C apps/collector-server exec tsx src/cli/main.ts"` 便于人类快速调用（`pnpm cli ...`）。**注意：agent 应绕过 pnpm run，直接用 exec / build 产物**（见 §9）。

## 6. 模块边界

| 模块 | 职责 | 依赖 |
|---|---|---|
| `cli/main.ts` | commander 装配、全局选项、命令注册 | 所有 commands/* |
| `cli/output.ts` | 格式化器（json/ndjson/csv/table）+ 退出码常量 | — |
| `cli/config.ts` | 解析 db/server/token 路径 | — |
| `cli/db.ts` | 只读 DB 连接 helper | migrate, advanced |
| `cli/http.ts` | 调 server 的 HTTP client（fetch） | — |
| `cli/subtitleFormat.ts` | payload → srt/vtt/txt/json | — |
| `cli/commands/{videos,changes,export,stats,clients,server}.ts` | 各命令组处理函数（可测纯函数 + commander 注册） | db, http, output |
| `db/advanced.ts` | 扩展查询（CLI 专用，不碰 HTTP） | schema |

命令处理拆为**纯函数**（入参：db/http client + options → 结构化结果）+ **commander 薄包装**，纯函数可单测。

## 7. 测试策略（collector-server 豁免 Playwright，用 node:test）

- `db/advanced.test.ts`：临时文件 DB，migrate + 插样本，断言各 filter/sort/pagination。
- `cli/subtitleFormat.test.ts`：各格式转换快照。
- `cli/commands/*.test.ts`：调纯函数 + 内存/临时 DB，断言结构化输出与退出码。
- `http/clients.test.ts` 扩展：`POST /api/clients/:id/command`（起临时 server + 模拟 WS 客户端回 result）。
- WAL 改动：复核 [db/ingest.test.ts](apps/collector-server/src/db/ingest.test.ts) / [db/queries.test.ts](apps/collector-server/src/db/queries.test.ts) 仍通过。
- 编排：`turbo run test` / `pnpm --filter @bilibili-ext/collector-server test`。

## 8. 验收清单

| # | 项 | 验证 |
|---|---|---|
| 8.1 | `pnpm cli --help` 列出全部命令组 | 退出 0 |
| 8.2 | `videos list` 支持全量过滤条件，返回 `{total,page,size,items}` JSON | 各过滤命中正确 |
| 8.3 | `videos get` / `versions get` / `changes list` 返回正确结构，未找到退 5 | DB 样本 |
| 8.4 | `export subtitle --sub-format srt/vtt/txt/json` 输出正确，`-o` 写文件 | 对比 info/ 样本 |
| 8.5 | `stats overview` / `stats count --by` 聚合正确 | 样本计数 |
| 8.6 | `clients list/reporting/command` 经 server HTTP 工作，`command` 拿到扩展 result 回执 | 模拟 WS 客户端 |
| 8.7 | `server ping/status/start/stop` 工作，pid 文件正确 | 本地起停 |
| 8.8 | 输出格式 json/ndjson/csv/table 全部可用 | `--format` 各值 |
| 8.9 | 退出码 0/1/2/3/4/5 语义正确 | 各错误场景 |
| 8.10 | WAL 改动后现有测试全绿 + CLI 可与 server 写并发 | turbo test |
| 8.11 | `pnpm cli videos list` 在 server 运行时直读 DB 不报锁 | 并发读（WAL） |
| 8.12 | agent 调用 `pnpm -C apps/collector-server exec tsx src/cli/main.ts`：纯 stdout + 正确退出码（2/5） | 已验证 |
| 8.13 | `export subtitle --sub-format vtt` 端到端输出 WEBVTT（回归 commander 同名冲突） | R4 测试 |

### 8.2 测试轮次记录

| 轮次 | 范围 | 结果 | 备注 |
|---|---|---|---|
| R1 | db/advanced + subtitleFormat 单测 | 通过 | db/advanced 17/17（含 WAL 启用校验）；subtitleFormat 13/13 |
| R2 | cli commands 纯函数 + http clients command 端点 | 通过 | videos 14 + changes/export/stats 23 + clients 11 + server 23 + ws/http clients command 7 |
| R3 | 全量 node:test（140/140）+ 端到端冒烟（查询/过滤/排序/聚合/导出/退出码） | 通过 | `pnpm --filter @bilibili-ext/collector-server test` |
| R4 | export subtitle --sub-format 端到端回归 | 通过 | spawn tsx 验证 vtt 输出 WEBVTT（防 commander 同名冲突再现） |

## 9. agent 调用约定（重要）

CLI 代码本身退出码 / 输出正确，但 **pnpm run 包装有两难**：
- `pnpm cli ...`（= `pnpm run cli`）：stdout 混入 pnpm 命令回显（`> bilibili-extensions@ cli ...`），破坏"纯数据"
- `pnpm -s cli ...`（silent）：stdout 纯净，但 pnpm 把退出码吞成 1，丢失语义

**agent 应直接调 tsx 或 build 产物，绕过 pnpm run**：

| 方式 | 命令 | 适用 |
|---|---|---|
| 开发 | `pnpm -C apps/collector-server exec tsx src/cli/main.ts <args>` | 日常（纯 stdout + 正确退出码） |
| 生产 | `node apps/collector-server/dist/cli/main.js <args>`（先 `pnpm --filter @bilibili-ext/collector-server build`） | 部署 |
| bin | build 后 `pnpm -C apps/collector-server exec collector-cli <args>` | 已 build |

约定：
- 退出码：0 成功 / 1 运行时 / 2 参数 / 3 server 不可达 / 4 DB 不可读 / 5 未找到。
- stdout 失败体：`{"ok":false,"error":"...","code":"..."}`；成功体：数据 JSON（list 类 `{total,page,size,items}`）。
- stderr：人类日志（`-q` 抑制）。
- 字幕纯文本导出（`export subtitle --sub-format srt|vtt|txt`）直接写 stdout 纯文本，不走 JSON 包装。
- 全局选项须在子命令前：`collector-cli [全局选项] <命令组> <命令> [命令选项]`，如 `--db <path> videos list`。
