# scripts/ 工具脚本最小输出契约

> 2026-10-05 落地（改造账本 [P1-12](../plans/improvement-backlog-2026-10.md) / [cli-completeness #12](../plans/cli-completeness.md)）。
> 适用对象：`scripts/*.mjs`（含 `*.mts`）数据生产、批量操作、诊断查询类工具脚本。
> 定位：**最小契约**，只管「退出码 / stderr 日志 / stdout 数据」三件事；**不推行 CLI 的 0-6 语义化退出码**（[cli-completeness §5](../plans/cli-completeness.md) 已显式不纳入）。

## 0. 适用范围

**适用**：一次性或编排调用的数据工具——采集、回填、导出、备份、验证、批量写操作。编排方（agent、cron、pipe 链）依赖其退出码与 stdout 判断成败。

**不适用**（三类豁免，见 §5 例外登记表）：

1. **常驻 / 交互进程**：`launch-chrome.mjs`、`proxy-collector-server.mjs`——生命周期由人管理，无「一次性成败」语义。
2. **质量门 / qa 链脚本**：`quality-baseline.mjs`、`pre-commit-check.mjs`——stdout 是人读门禁报告，消费方是 `pnpm qa` 自身（各自已有独立约定）。
3. **puppeteer 真浏览器冒烟族**（`verify-collector.mjs` 等）：人观察式验收工具，非编排链环节。

## 1. 三条最小契约

| # | 契约 | 内容 |
|---|---|---|
| ① | **退出码 0 / 非 0** | 成功 = 0；任何失败（含**部分失败**）= 非 0。多脚本可用非 0 值细分失败类（如 export-bundle 的 0/2/3、verify-yt-channel 的 0/1/2），但不强制，也不对齐 CLI 的 0-6 语义。脚本内退出用 `process.exitCode = 1`（让 stderr 先落盘）或末尾 `process.exit(1)`（无后续输出时）。 |
| ② | **失败路径 stderr 带 `[tag]` 分步日志** | 步骤 tag（`[fetch]`/`[parse]`/`[apply]`）或循环内条目 tag（`[vid]`），带关键输入与失败原因——对齐 [CLAUDE.md §9](../../CLAUDE.md#9-工具可观察性纪律先让工具能被观察--严格) 工具可观察性：日志不足以定位根因视为脚本 bug。正常进度/诊断也走 stderr（同一套 tag），保证 stdout 纯净。 |
| ③ | **stdout 只出数据产物，可 pipe** | TSV / JSON / 清单等下游可解析的产物；无数据产物的脚本 stdout 应为空。禁止 stdout 出进度、表格装饰、成功提示——那类内容走 stderr。 |

## 2. 范本

| 脚本 | 学什么 |
|---|---|
| [youtube-collect-videos.mjs](../../scripts/youtube-collect-videos.mjs) | 全套范本：`[fetch]`/`[handle]`/`[playlist]`/`[browse]`/`[parse]`/`[filter]` 分步 stderr、`pageDiag()` 页面特征诊断、stdout 纯 TSV（可直接 pipe 进 youtube-collect-subs）、失败 exit 1 |
| [verify-yt-channel.mjs](../../scripts/verify-yt-channel.mjs) | stdout 单行纯 JSON + stderr 分步日志 + 0/1/2 三值退出码成文于头注释 |
| [export-bundle.mjs](../../scripts/export-bundle.mjs) | 头注释成文自有退出码语义（0/2/3/透传）的最小写法 |

## 3. 新增 / 改动脚本检查单

- [ ] 所有失败分支非 0 退出；部分失败也是非 0（§1①）
- [ ] 失败分支有 `[tag]` 日志，含关键输入与原因（§1②，§9 纪律）
- [ ] stdout 逐处核对：是数据产物才允许 `console.log` / `process.stdout.write`，否则改 stderr（§1③）
- [ ] 退出码语义（若非平凡）写在头注释一行
- [ ] `node --check` 可加载；有 dry 通路（`--list`/`--dry-run`/无参用法提示）的跑一遍验证退出码

## 4. 存量对齐盘点（2026-10-05，P1-12 本轮）

24 个脚本 × 三契约全量核对结果。「顺手修」= 本轮已改并通过 `node --check` + dry 通路验证；「合规」= 通读确认无需改动。

| 脚本 | 判定 | 本轮改动 / 说明 |
|---|---|---|
| youtube-collect-videos.mjs | 合规（范本） | 不改 |
| verify-yt-channel.mjs | 合规 | stdout 纯 JSON 一行 + stderr 分步 + 0/1/2 成文 |
| export-bundle.mjs | 合规 | 退出码 0/2/3 成文于头注释 |
| collect-uppers.mts | 合规 | 0/2/3/4 成文 + `[1/3]` 全 stderr + stdout 空 |
| bili-cookie-from-chrome.mjs | 合规 | stdout 出 cookie 值（数据产物），诊断走 stderr |
| sqlite-rescue.mjs | 合规 | 诊断走 stderr，导出文件为数据产物 |
| verify-skill-sync.mjs | 合规 | 全 stderr；stdout 空（无数据产物） |
| youtube-collect-subs.mjs | 顺手修 | 头行加 `[subs]` tag；部分失败 exit 1（原恒 0）+ 限流自救提示 stderr |
| collect-batch.mjs | 顺手修 | 进度/耗时改 stderr；STOP_REASON 与失败明细明确为 stdout 数据产物并注释；部分失败 exit 1；tag-apply 失败 `[tag-apply]` stderr |
| verify-audio-extract.mjs | 顺手修 | 前置失败（CDP 未就绪）原恒 exit 0 → 失败 `[audio-extract]` stderr + exit 1 |
| verify-deployed.mjs | 顺手修 | 报告全量 stdout → stderr（本脚本无数据产物，stdout 应空）；头注释成文退出码 0/1 与流路由 |
| backup-restore.mjs | 顺手修 | 人读进度 stdout → stderr；头注释成文输出契约；容器内 node -e 完整性检查保持 stdout（execFileSync 捕获通道） |
| backup-export.mjs | 顺手修 | 三处进度 stdout → stderr；头注释成文退出码 0/1/2/3 与流路由 |
| backfill-no-subtitle-tags.mjs | 顺手修 | apply 批次包 try/catch：失败 `[apply]` stderr（含批次输入与已打标进度）+ exit 1（原裸 stack 崩溃）；头注释成文 dry-run stdout TSV 为数据产物 |
| load-collector-extension.sh | 例外 | .sh 不在本契约范围（§5） |

## 5. 例外登记表（暂不对齐，及原因）

| 脚本 | 缺什么 | 为什么暂缓 |
|---|---|---|
| launch-chrome.mjs | 无退出码语义（常驻进程被 kill 收场） | 交互常驻进程，无一次性成败语义；§0 豁免类 1 |
| proxy-collector-server.mjs | 同上 | 同上 |
| verify-collector.mjs / verify-youtube-collector.mjs / verify-active-collect.mjs / verify-collector-report-toggle.mjs / verify-connection-mode.mjs / verify-extractor.mjs / verify-phase2.mjs | stdout 混排人读报告与进度；退出码不成文 | puppeteer 真浏览器冒烟族：人观察式验收，非编排链环节（不进 qa、不 pipe）；统一改造收益低，待单个脚本涉改时顺手对齐（§0 豁免类 3） |
| quality-baseline.mjs / pre-commit-check.mjs | stdout 人读门禁报告（非数据产物） | pnpm qa / husky 链内消费方是 `pnpm qa` 自身与其测试，输出格式由各自测试锁定，改流路由反而破坏既有断言；§0 豁免类 2 |
| verify-deployed.mjs 的 stdout | 无（本轮已对齐） | — |

> 新脚本按 §3 检查单执行；例外脚本涉改时按「顺手对齐」原则处理并在本表划销。
