# 字幕轨切换器（Subtitle Track Switcher）设计

> 日期：2026-06-14
> 状态：设计中
> 关联扩展：`apps/subtitle-extractor`

---

## 1. 概述

把现有 `subtitle-extractor` 的 popup 从「所有字幕轨平铺成卡片」改成「字幕轨切换器 + 选中轨时间轴逐行展示」。用户在 popup 里切换选择某条字幕轨（如 AI 中文 / CC 简体），下方显示该轨的逐行字幕（时间 + 文本）。

## 2. 背景

现有 popup（[`popup.js:17` render()](../../../apps/subtitle-extractor/popup.js#L17)）把 `meta` 里每条字幕轨渲染成一个独立卡片，所有轨同时铺满 popup。视频有多语言/多类型字幕时信息密集，难以聚焦单条轨内容。

**需求演变（本轮 brainstorming 澄清）：**

| 轮次 | 决定 |
|---|---|
| 数据源 | **字幕**（subtitle），不是弹幕（danmaku）—— 详见项目 memory `subtitle-vs-danmaku` |
| 展示位置 | popup 内（不动视频页） |
| 交互 | 字幕轨切换器，一次选一条轨 |
| 选中轨形式 | 保留时间轴逐行（`from→to + content`） |
| 动画 | 无（不做滚动 / 飘屏 / 纯文本整体） |

## 3. 需求（最终确认）

| 项 | 决定 |
|---|---|
| 数据源 | 字幕（现有 `inject.js` 抓的 AI `type:1` / CC `type:2` 字幕轨） |
| 展示位置 | popup 内 |
| 交互 | 字幕轨切换器，选一条轨 |
| 选中轨展示 | 时间轴逐行（`from→to + content`），沿用现有 `.line` 样式 |
| 动画 | 无 |
| 视频页改动 | 无 |
| manifest / content.js / inject.js 改动 | 无 |

## 4. 设计

### 4.1 架构（不变）

数据流沿用现有，**零改动**：

```
inject.js(MAIN, hook fetch/XHR) --postMessage--> content.js(存 meta+contents)
popup.js --chrome.runtime.sendMessage(GET_SUBTITLE)--> content.js 返回 {meta, contents}
```

### 4.2 改动范围

**只动两个文件：**

- [`popup.html`](../../../apps/subtitle-extractor/popup.html)：加切换器容器结构 + 切换器样式
- [`popup.js`](../../../apps/subtitle-extractor/popup.js)：重构 `render()` 为「渲染切换器 + 渲染选中轨」，加切换交互

**不动：** `manifest.json`、`content.js`、`inject.js`

### 4.3 popup 结构

```
#status          无字幕 / 加载提示（沿用）
#track-switcher  字幕轨切换器（横向可点项，每项：badge + 语言）
#track-view      选中轨展示区（时间轴逐行 + 复制按钮）
```

### 4.4 交互逻辑

1. popup 打开 → 拉 data（`GET_SUBTITLE`）→ 渲染切换器（`meta` 每条轨一项）
2. 默认选中 `meta[0]` → 渲染该轨 `body` 逐行（`from→to + content`）+ 复制按钮
3. 点击切换器某项 → 更新选中态 → 重渲染 `#track-view`
4. 2s 轮询（沿用 [`popup.js:133`](../../../apps/subtitle-extractor/popup.js#L133)）：数据变化时重渲染切换器；按 `_url` 匹配判断当前选中轨是否仍存在——存在则保持选中，否则回退 `meta[0]`

### 4.5 样式

- 切换器项：横向排列，选中项高亮
- 时间轴行、复制按钮：完全复用现有 `.line` / `.time` / `.text` / `.copy-btn`

### 4.6 关于「手写 CSS」

全局 CLAUDE.md 规定「禁止手写 CSS，用 Tailwind/shadcn」。但本扩展是**纯原生 JS Chrome 扩展、无构建链**，popup 是普通 HTML，现有 [`popup.html`](../../../apps/subtitle-extractor/popup.html) 已是手写 `<style>`。引入 Tailwind 需加构建链 + CDN，过度工程且与现状不一致。**本设计沿用现有手写 CSS 风格**，仅新增切换器所需的最少样式（选中态高亮）。

## 5. 不做（YAGNI）

- 视频页 DOM 注入 / 滚动动画 / 弹幕样式
- 字幕轨选择的持久化（`chrome.storage`）—— 默认选第一条即可
- 纯文本整体模式（去时间轴）—— 用户明确选保留时间轴
- 字幕搜索 / 过滤

## 6. 验收标准

| # | 验收项 |
|---|---|
| 1 | popup 在有字幕的视频页打开，切换器列出所有字幕轨（含 AI/CC badge + 语言名） |
| 2 | 默认选中第一条轨，下方显示该轨时间轴逐行（时间 + 文本） |
| 3 | 点击切换器其他轨，下方切换显示对应轨内容 |
| 4 | 复制按钮复制选中轨全部文本 |
| 5 | 无字幕时显示提示（沿用现有 `#status`） |
| 6 | 2s 轮询更新：新轨出现 / 旧轨消失时切换器同步；当前选中轨仍存在则保持选中 |
| 7 | 真实登录态端到端：视频页 → `inject` 抓字幕 → popup 显示真实字幕 |

## 7. 测试方式

沿用项目现有 puppeteer mock 验证模式（[`scripts/verify-extension.mjs`](../../../scripts/verify-extension.mjs)）：

- mock player API 返回 3 条字幕轨（AI 中文 / AI 英语 / CC 简体）
- 加载扩展 → 打开 popup → 验证：
  - 切换器有 3 项，badge / 语言正确
  - 默认选中第一条，内容正确
  - 模拟点击第 2 项 → `#track-view` 切换为第 2 轨内容
- 真实字幕端到端：登录态浏览器打开有字幕的视频，确认 popup 显示真实字幕

> 说明：本项目无 Playwright/构建链，测试沿用 puppeteer mock 脚本方式（与 [`MANUAL.md`](../../../MANUAL.md)「端到端验证」一致），不强行引入 `integration-tests/*.spec.ts`。

## 8. 风险

- popup 是 `chrome-extension://` 页面，puppeteer 验证需访问 `chrome-extension://<id>/popup.html`（[`MANUAL.md`](../../../MANUAL.md) 已有先例）
- 真实字幕需登录态 + 用户点字幕按钮才触发（[`MANUAL.md`](../../../MANUAL.md) 第 3 章：字幕非页面加载时返回）—— 端到端验证需手动触发字幕按钮
