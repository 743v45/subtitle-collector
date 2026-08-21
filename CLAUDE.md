# bilibili-extensions 项目级 CLAUDE.md

> 本文件补充/收窄全局 `~/.claude/CLAUDE.md` 在本项目的适用边界。冲突时以本文件为准。

## 1. 项目概述

B 站**字幕（subtitle）**相关浏览器扩展的 monorepo（pnpm + turbo，workspace 为 `apps/*`）。
每个 `apps/<name>` 是一个独立扩展或应用；`scripts/` 放跨包脚本（含 `verify-*.mjs` 验证）。

## 2. 样式政策（豁免边界 — 对齐审查 C4/C8）

按"是否带构建链"划界，**不要一刀切套用全局"禁止手写 CSS"规则**：

| App 类型 | 例子 | 构建链 | 样式规则 |
|---|---|---|---|
| 无构建链纯原生扩展 | （暂无） | 无 | **豁免**全局规则，沿用原生手写 CSS |
| 有构建链前端 | `apps/collector-web`、`apps/subtitle-collector`（popup） | 有 | **无豁免**，强制 Tailwind 工具类 + shadcn/ui；禁 `style={{}}` 内联、禁手写 `.css`、禁 CSS-in-JS；subtitle-collector 的 inject/content 虽为裸 JS 但无独立样式，不豁免 popup |
| 纯后端 | `apps/collector-server` | — | 无 UI，不涉及 |

通用约束：**content script 向宿主页注入可视 UI 时，必须用 Shadow DOM 隔离样式，禁止注入裸 `<style>` 污染宿主页。**

## 3. 测试政策（豁免边界 — 对齐审查 C8）

| App 类型 | 测试方式 | 是否豁免全局 `integration-tests/*.spec.ts` |
|---|---|---|
| subtitle-collector（已迁构建链） | `vite build` 冒烟 + `scripts/verify-*.mjs`（puppeteer mock，`--load-extension=apps/subtitle-collector/dist`）+ `node:test`（reporting.mjs 纯函数，import 源码不依赖 dist） | **豁免** Playwright E2E；新增 `vite build` 冒烟 |
| collector-server（TS） | `node --test --import tsx` | — |
| collector-web | 至少 `vite build` 冒烟 | — |
| subtitle-extractor（旁挂工具） | 依赖缺失期间测试冻结（workspace 排除，见 [pnpm-workspace.yaml](pnpm-workspace.yaml)） | 豁免 turbo 编排 |

约定：
- **验收章节位置灵活**（不必硬塞"第8章"），但每个 spec **必须含"测试轮次记录表"**（对齐全局 8.2）。
- **测试编排**：`turbo run test` 一条命令跑全部 —— `turbo.json` 需补 `test` task，各 app 在 `package.json` 暴露 `test` 脚本。
- **回归纪律**：bug 修复 commit 必须含对应「失败→通过」的测试用例。

## 4. 字幕 vs 弹幕（措辞红线）

本项目是**字幕（subtitle）**系统，**不是弹幕（danmaku）**。文档与代码措辞严禁混用；遇到"弹幕"字样先确认指代。

## 5. 文档跳转（沿用全局）

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
