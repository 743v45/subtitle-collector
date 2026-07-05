# BUGFIX 记录 — subtitle-collector

> 本文件累积 subtitle-collector 扩展的 bug 修复记录，每条含根因 / 修复点 / 验证 / 测试轮次表。
> 对齐全局 CLAUDE.md「审查与文档化规则」；测试政策遵循项目 CLAUDE.md 第 3 节（subtitle-collector 豁免 Playwright，用 vite build 冒烟 + verify-*.mjs + node:test）。

---

## BUG-1：`Uncaught Error: Extension context invalidated`（content.js）

### 现象
bilibili 视频页控制台报 `Uncaught Error: Extension context invalidated`，堆栈指向 content script 的 minified 函数（如 `assets/content.js-<hash>.js:1 (m)`）。多见于 SPA 自动播放下一个相关视频时（URL 含 `player_end_recommend_autoplay` / `trackid=web_related_...`）。

### 根因
扩展上下文失效（扩展被 reload / 自动更新 / 禁用后重启用过），但 bilibili 标签页**未刷新**，驻留的 content script 持有的 `chrome.runtime` 引用已死。此后任何 `chrome.runtime.*` 调用同步抛 `Extension context invalidated`。

bilibili 是 SPA：切换视频不刷新页面 → content script 不重注入 → 每个新视频持续触发 `PLAYER_META` window message → [content.js:15](content.js#L15) `fetchSubtitleBodiesViaBg` → [content.js:38](content.js#L38) `chrome.runtime.sendMessage(FETCH_SUBTITLE)`，以及 [content.js](content.js) `flushIfReady` 内的 `chrome.runtime.sendMessage(INGEST)`。这两处是高频抛错点（minified 堆栈里的 `m`）。

对照：[background.js:276](background.js#L276)/[:337](background.js#L337) 与 [src/popup/hooks.ts:284](src/popup/hooks.ts#L284) **都**查了 `chrome.runtime.lastError`，唯独 content.js 漏了。

### 影响
- **开发期**：reload 扩展后，打开的 bilibili 标签页持续抛 Uncaught Error，污染控制台、干扰调试。
- **生产期**：扩展自动更新后，已打开标签页**字幕采集静默失效**（FETCH_SUBTITLE 抓不回字幕体、INGEST 发不出去），用户无感知。

### 修复点
仅修两处确凿高频抛错点（精准修改；第 [:95](content.js#L95) `onMessage.addListener` 是注入瞬间一次性注册，仅「注入时上下文已失效」才抛，且失效上下文不再投递消息故 listener 内部不会在失效态触发，按「不为不可能场景加错误处理」原则不动）：

| 位置 | 改动 |
|---|---|
| [content.js:38](content.js#L38) `FETCH_SUBTITLE` | 外层 `try/catch` 兜同步异常；回调首句查 `chrome.runtime.lastError` 兜异步错误 |
| [content.js:84](content.js#L84) `INGEST` | 外层 `try/catch`（无回调） |

风格对齐 [background.js:276](background.js#L276) 现有 `lastError` 写法。

### 为什么不写自动化测试
此 bug 是 `chrome.runtime` **运行时**行为（扩展 reload 致上下文失效），三类测试均难真实复现：
- `verify-*.mjs` 的 puppeteer mock 无法稳定模拟「扩展 reload 致旧 content 驻留」——puppeteer 重载扩展的行为与生产 chrome 不一致；
- `node:test` 是纯函数测试，content.js 是裸脚本非可导入模块，强抽函数 mock 会扭曲代码（违背「简单优先」）；
- 项目政策豁免 Playwright E2E。

故采用 **vite build 冒烟 + 手动验证步骤**，符合项目 CLAUDE.md 第 3 节。

### 验证

#### 自动化（每次改动必跑）
1. `pnpm -C apps/subtitle-collector build` —— 构建通过，dist 产物含新代码（grep `lastError` / `上下文可能已失效` 命中）。
2. `pnpm -C apps/subtitle-collector test` —— 35 个 node:test 全过（确保未碰纯函数逻辑）。

#### 手动回归（首次修复 / 大改后跑）
1. `pnpm -C apps/subtitle-collector build`，chrome://extensions 重新加载 `dist/`。
2. 打开任一 bilibili 视频页，等字幕采集正常工作一次（控制台见 `[content] INGEST ...`）。
3. chrome://extensions 点扩展的「重新加载」按钮（模拟扩展更新），**不刷新** bilibili 标签页。
4. 在该标签页等 SPA 自动播放下一个视频，或手动点下一个相关视频。
5. **预期**：控制台**不再**有 `Uncaught Error: Extension context invalidated`；只见 `[content] FETCH_SUBTITLE 发送异常（扩展上下文可能已失效）...` 与 `[content] INGEST 发送异常...` 的 warn。
6. 刷新该 bilibili 标签页后，字幕采集恢复正常（`INGEST` 重新上报）。

### 测试轮次记录表

| 轮次 | 日期 | 改动 | build | node:test | 手动回归 | 结果 |
|---|---|---|---|---|---|---|
| R1 | 2026-07-05 | content.js:38/84 加 try/catch + lastError | ✅ 722ms | ✅ 35/35 | ⏳ 待用户在真实浏览器执行 | 自动化通过，手动待验 |

> ⏳ 手动回归需用户在真实 bilibili 环境执行（开发期模拟 reload + SPA 自动播放）；完成后请把上表「手动回归」列从 ⏳ 改为 ✅/❌ 并补一句结论。

---

## BUG-2：popup 字幕列表 AI 字幕语言被抹平成 "AI"（中/英/日无法区分）

### 现象
某视频有多语言 AI 字幕（中文 / 英语 / 日本語各一条 AI 轨），SubCatch popup 的字幕列表里这些轨**全部显示成 "AI"**，看不出是哪种语言。用户反馈「全是 AI 字幕，没区分中文/英语/日本语」（示例视频 BV1cXobBfETp）。

### 根因
**数据层没丢语言，是 UI 层抹平的。** `lan`/`lan_doc` 采集链路端到端保留：
- 采集：[inject.js:62](inject.js#L62) `lan: s.lan, lan_doc: s.lan_doc` 原样透传；
- 落地：[content.js:125-132](content.js#L125-L132) `GET_LOCAL_STATE` 响应带上 `lan`/`lan_doc`；
- 类型：[src/popup/types.ts:78-85](src/popup/types.ts#L78-L85) `LocalSub.lan`/`lan_doc`。

但展示层把 AI 字幕的语言直接替换成了 "AI"（旧 [src/popup/Popup.tsx:738-739](src/popup/Popup.tsx#L738-L739)）：
```js
const isAi = !!url && url.includes('aisubtitle');
const label = isAi ? 'AI' : (s.lan_doc ?? s.lan ?? '未知'); // ← AI 字幕语言被抹掉
```
于是同视频的中 / 英 / 日 AI 字幕 label 全是 "AI"，视觉上无法区分。

### 影响
- popup 字幕列表里，同视频不同语言的 AI 字幕**视觉上无法区分**，用户看到一排 "AI"。
- 复制时难以判断复制的是哪一轨语言。

### 修复点
| 位置 | 改动 |
|---|---|
| 新增 [subtitleLabel.mjs](subtitleLabel.mjs) | 抽纯函数 `isAiSubtitle(sub)` / `subtitleTrackLabel(sub)`；label 始终返回 `lan_doc ?? lan ?? '未知'`，不被 AI 覆盖 |
| 新增 [test/subtitleLabel.test.mjs](test/subtitleLabel.test.mjs) | 回归测试 6 例：AI 字幕保留各自语言名、不再统一 "AI"，及 `isAiSubtitle` 判定与兜底 |
| [src/popup/Popup.tsx:22-23](src/popup/Popup.tsx#L22-L23) | import 两个纯函数 |
| [src/popup/Popup.tsx:738-741](src/popup/Popup.tsx#L738-L741) | `isAi`/`label` 改用纯函数；语言名始终显示，不再被 AI 替换 |
| [src/popup/Popup.tsx:749-759](src/popup/Popup.tsx#L749-L759) | 副 `lan` 去掉 `!isAi` 限制；AI 改为独立 `<Badge variant="secondary">` 叠加 |

UI 效果：`中文（简体） zh-Hans [AI]` / `English en [AI]` / `日本語 ja [AI]` —— 语言名主标签 + 灰色语言码 + 小 AI 徽章并存。

### 为什么用 .mjs + node:test
label 逻辑原本内联在 `.tsx` 里，而 subtitle-collector 的 `node --test` 只 import `.mjs`（见项目 CLAUDE.md 第 3 节测试政策）。把判定抽到 `.mjs` 纯函数，既让 UI 与测试共用同一份真相（避免逻辑漂移），又能写确定性回归测试，符合「bug 必须加回归测试」纪律。`subtitleFormat.mjs` 已是同样范式。

### 验证

#### 自动化（每次改动必跑）
1. `pnpm -C apps/subtitle-collector test` —— 41/41 通过（BUG-1 时 35 个 + 本次新增 6 个 subtitleLabel 用例）。
2. `pnpm -C apps/subtitle-collector build` —— vite build 通过（708ms，78 modules），popup 产物含新逻辑。

#### 手动回归（首次修复后跑）
1. `pnpm -C apps/subtitle-collector build`，chrome://extensions 重新加载 `dist/`。
2. 打开有多语言 AI 字幕的视频（如 BV1cXobBfETp），等字幕采集（控制台见 `[content] INGEST ...`）。
3. 点扩展图标打开 popup，展开「字幕」区。
4. **预期**：各 AI 字幕轨分别显示自己的语言名 + 小 "AI" 徽章（中 / 英 / 日 一眼可分），不再是一排 "AI"。

### 测试轮次记录表

| 轮次 | 日期 | 改动 | build | node:test | 手动回归 | 结果 |
|---|---|---|---|---|---|---|
| R1 | 2026-07-05 | 抽 subtitleLabel.mjs + Popup.tsx label/badge 改造 | ✅ 708ms | ✅ 41/41 | ⏳ 待用户在 BV1cXobBfETp 验证 | 自动化通过，手动待验 |

> ⏳ 手动回归需用户在真实 bilibili 环境执行（登录态才能拿到 AI 字幕，curl 未登录 `need_login_subtitle=true` 无法复现）；完成后请把上表「手动回归」列从 ⏳ 改为 ✅/❌ 并补一句结论。
