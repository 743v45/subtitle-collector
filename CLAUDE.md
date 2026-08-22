# bilibili-extensions 项目级 CLAUDE.md

> 本文件是本仓库的项目级开发规范；测试质量细则见 [docs/quality/RULES.md](docs/quality/RULES.md)。冲突时以本文件为准。

## 1. 项目概述

B 站**字幕（subtitle）**相关浏览器扩展的 monorepo（pnpm + turbo，workspace 为 `apps/*`）。
每个 `apps/<name>` 是一个独立扩展或应用；`scripts/` 放跨包脚本（含 `verify-*.mjs` 验证）。

## 2. 样式政策（豁免边界）

按"是否带构建链"划界，不一刀切禁手写 CSS：

| App 类型 | 例子 | 构建链 | 样式规则 |
|---|---|---|---|
| 无构建链纯原生扩展 | （暂无） | 无 | **豁免**手写 CSS 禁令，沿用原生手写 CSS |
| 有构建链前端 | `apps/collector-web`、`apps/subtitle-collector`（popup） | 有 | **无豁免**，强制 Tailwind 工具类 + shadcn/ui；禁 `style={{}}` 内联、禁手写 `.css`、禁 CSS-in-JS；subtitle-collector 的 inject/content 虽为裸 JS 但无独立样式，不豁免 popup |
| 纯后端 | `apps/collector-server` | — | 无 UI，不涉及 |

通用约束：**content script 向宿主页注入可视 UI 时，必须用 Shadow DOM 隔离样式，禁止注入裸 `<style>` 污染宿主页。**

## 3. 测试质量政策

> 细则全部外移 [docs/quality/RULES.md](docs/quality/RULES.md)（下称 RULES），本节只留摘要与入口。

**三层分级**：

- **日常（每次代码改动完成）**：即时 `pnpm build`（或受影响 app 的 build）——测试 runner 不做类型检查（tsx 直译/vitest 不跑 tsc），测试全绿≠可构建（RULES §6）。
- **日常（每次提交）**：`pnpm qa` 全量质量门（build + test + 覆盖率锁定 + 静态台账 check + depcruise；涉代码提交前手动必跑并在 commit message 引用结果，纯文档/配置豁免）＋ husky pre-commit（只查 git 新增文件的两条静态规则）＋ 测试中文注释三档。
- **低频（偿还/调整时）**：`node scripts/quality-baseline.mjs update` 刷新静态台账（默认 dry-run，`--write` 才落盘）；覆盖率锁定线上调（实际值高出锁定线 >2pp 时手动上调，只升不降）；`check --allow-degrade` 豁免通道（须 commit message 注明原因）。
- **定期审计**：Stryker 变异测试（各 app `pnpm mutation`，阶段性大改后手动跑；观察制不设阈值）；政策自检（每完成 5 个 spec 或 CLAUDE.md 大改时过一遍执行记录，连续两次零执行的条款提请退役）。

**八项规则**（一行一条，关键参数 + RULES 对应节）：

1. 单元测试：全中文测试名 + 注释三档（RULES §1）
2. 覆盖率：三 app 四指标锁定只升不降，>2pp 手动上调（RULES §2）
3. 圈复杂度 ≤15 / 模块 ≤400 行：新文件必须达标，存量走台账不得恶化（RULES §3）
4. 依赖结构：depcruise 五组规则（跨 app 禁 import / web 分层 / server 分层 / 扩展运行时脚本黑名单 / 禁循环），违反直接修不豁免（RULES §4）
5. Gherkin 验收：文档式中文场景 + 标注映射测试文件，样例 [main-pipeline.md](docs/quality/acceptance/main-pipeline.md)（RULES §5）
6. QA 流程：`pnpm qa` 一条命令 + pre-commit 分工，puppeteer 冒烟不进 qa（RULES §6）
7. 变异测试：Stryker 观察制，command runner 直跑 `node --test`（RULES §7）
8. 测试轮次记录表：每个 spec 必含，至少一行 `pnpm qa` 结果（RULES §5）

**各 app 测试方式**（runner + 覆盖率口径）：

| App | 命令 | 口径 |
|---|---|---|
| collector-server | `c8 node --test --import tsx "src/**/*.test.ts"` | c8 出覆盖率（node:test+tsx 直报覆盖率对个别文件行级丢失，见 [stats.test.ts](apps/collector-server/src/cli/commands/stats.test.ts) 头部排查记录）＋ `--check-coverage` 锁定阈值 |
| collector-web | `vitest run --coverage`（vitest 3 + jsdom + @testing-library/react，2026-08-22 经用户确认引入） | vitest thresholds 锁定；`vite build` 归 build task |
| subtitle-collector | `c8 node --test "test/*.test.mjs"`（import 源码不依赖 dist） | c8 包裹（`--experimental-test-coverage` 退役）＋锁定；扩展链路改动另跑 `pnpm test:ext` puppeteer 冒烟（不进 qa，涉 YouTube 加 `test:youtube`） |

- subtitle-extractor：依赖缺失测试冻结，豁免全套质量规则（RULES §10 豁免登记表；workspace 排除见 [pnpm-workspace.yaml](pnpm-workspace.yaml)）。
- `*.test.*` 测试文件对 complexity/max-lines 两条静态规则豁免（静态门只约束源码，测试质量由覆盖率管）。
- 编排：`turbo run test` 一条命令跑全部；qa 门内用 `--force` 直跑防缓存误判。
- 回归纪律：bug 修复 commit 必须含对应「失败→通过」的测试用例。
- 新 app 准入清单：完成 = 接入四件套（ESLint 范围、测试 runner+覆盖率锁定、depcruise、Stryker）＋ 豁免表登记（RULES §9）。

## 4. 字幕 vs 弹幕（措辞红线）

本项目是**字幕（subtitle）**系统，**不是弹幕（danmaku）**。文档与代码措辞严禁混用；遇到"弹幕"字样先确认指代。

## 5. 文档跳转

所有与代码/文档相关的输出须带 `[file:行号](path#L行号)` 链接定位，禁止笼统描述。

## 6. Feature 列表纪律（README 需求锚点）

[README.md](README.md) 的「目标与功能（Feature 列表）」是项目需求的唯一锚点，按「批量采集 → 查询导出 → 批量提取分析」链路组织，状态标记 ✅ 已实现 / 🚧 待建 / 📋 远期。

- **同步更新**：新增/完成功能必须同步更新该列表；过期列表比没有更糟。
- **优先级判断**：当前最大缺口是消费端（🚧 批量提取分析）。消费端手动流程跑顺前，采集侧新能力默认冻结。2026-08-22 经项目拷问确认：冻结政策维持——消费端闭环（bundle 导出 → Claude Code 会话分析 → `analysis/<主题>/` 落盘）跑通前不新增采集侧能力；落盘规范以 [README.md](README.md)「分析产物规范」条目（`analysis/<主题>/`）为准。
- **分析执行方**：分析在 Claude Code 会话中完成，系统只负责原料包导出（`export bundle`）与产物落盘规范；内置 AI pipeline 为远期项。

## 7. 扩展版本号纪律

`apps/subtitle-collector/manifest.json` 的 `version` 在**每次涉及扩展改动的提交里必须 bump**（补丁位 +1，如 0.1.1 → 0.1.2）。popup 品牌头直出 `manifest.version`，用户据此对照本地扩展是否为最新构建（chrome://extensions 刷新后核对）。collector-server / collector-web 走 docker rebuild 自带最新，无需手动版本。

## 8. 实现路线纪律（不绕路）

- **只走项目自己的方向**：遇到问题时优先沿既定架构先例修复（对齐本仓库已有模式），不引入替代方案/绕路变通（如换数据源、换协议、加旁路通道）。
- **外部方案必须先询问**：明显偏离项目方向的方案选择（换库/换协议/换数据源/新增外部依赖等"外部方案"）必须先向用户提出并确认，禁止直接尝试。内部开发（项目方向内的实现细节、bug 修复、对齐先例的重构）无需询问。

## 9. 工具可观察性纪律（先让工具能被观察 — 严格）

- **用 `scripts/` 工具（或扩展链路）做批量采集 / 验证 / 诊断前，必须先确认其失败路径的日志足以定位根因**：HTTP 状态与响应特征（页面标题 / 长度 / 反爬标记）、结构解析命中计数（renderer / viewModel 统计）、每步输入输出计数。参考实现：[youtube-collect-videos.mjs](scripts/youtube-collect-videos.mjs) 的 `[fetch]/[parse]/[filter]` 分步 stderr 日志 + `pageDiag()` 页面特征。
- **日志看不出问题的，先修日志再跑工具**。禁止在不可观察状态下盲跑工具后靠猜修——「解析失败(反爬?)」「0 视频」这类无上下文的失败报告视为工具 bug，修的是日志而不是先猜原因。
- 修复工具 bug 的提交，同步补上让该失败路径下次可观察的日志（回归纪律 §3 的日志版）。
