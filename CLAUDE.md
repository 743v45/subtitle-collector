# bilibili-extensions 项目级 CLAUDE.md

> 本文件补充/收窄全局 `~/.claude/CLAUDE.md` 在本项目的适用边界。冲突时以本文件为准。

## 1. 项目概述

B 站**字幕（subtitle）**相关浏览器扩展的 monorepo（pnpm + turbo，workspace 为 `apps/*`）。
每个 `apps/<name>` 是一个独立扩展或应用；`scripts/` 放跨包脚本（含 `verify-*.mjs` 验证）。

## 2. 样式政策（豁免边界 — 对齐审查 C4/C8）

按"是否带构建链"划界，**不要一刀切套用全局"禁止手写 CSS"规则**：

| App 类型 | 例子 | 构建链 | 样式规则 |
|---|---|---|---|
| 无构建链纯原生扩展 | `apps/subtitle-collector`（popup/inject/content）等 | 无 | **豁免**全局规则，沿用原生手写 CSS（MV3 无构建链，引 Tailwind 需 CDN/构建属过度工程） |
| 有构建链前端 | `apps/collector-web`（React + Vite） | 有 | **无豁免**，强制 Tailwind 工具类 + shadcn/ui；禁 `style={{}}` 内联、禁手写 `.css`、禁 CSS-in-JS |
| 纯后端 | `apps/collector-server` | — | 无 UI，不涉及 |

通用约束：**content script 向宿主页注入可视 UI 时，必须用 Shadow DOM 隔离样式，禁止注入裸 `<style>` 污染宿主页。**

## 3. 测试政策（豁免边界 — 对齐审查 C8）

| App 类型 | 测试方式 | 是否豁免全局 `integration-tests/*.spec.ts` |
|---|---|---|
| 无构建链扩展 | `scripts/verify-*.mjs`（puppeteer mock + `--load-extension`）+ `node:test`（核心逻辑提取纯函数测） | **豁免** Playwright E2E 强制要求 |
| collector-server（TS） | `node --test --import tsx` | — |
| collector-web | 至少 `vite build` 冒烟 | — |

约定：
- **验收章节位置灵活**（不必硬塞"第8章"），但每个 spec **必须含"测试轮次记录表"**（对齐全局 8.2）。
- **测试编排**：`turbo run test` 一条命令跑全部 —— `turbo.json` 需补 `test` task，各 app 在 `package.json` 暴露 `test` 脚本。
- **回归纪律**：bug 修复 commit 必须含对应「失败→通过」的测试用例。

## 4. 字幕 vs 弹幕（措辞红线）

本项目是**字幕（subtitle）**系统，**不是弹幕（danmaku）**。文档与代码措辞严禁混用；遇到"弹幕"字样先确认指代。

## 5. 文档跳转（沿用全局）

所有与代码/文档相关的输出须带 `[file:行号](path#L行号)` 链接定位，禁止笼统描述。
