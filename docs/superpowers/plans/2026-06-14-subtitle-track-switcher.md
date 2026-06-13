# 字幕轨切换器（Subtitle Track Switcher）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `subtitle-extractor` 的 popup 从「全轨平铺卡片」改成「字幕轨切换器 + 选中轨时间轴逐行」。

**Architecture:** 仅改 `popup.html` / `popup.js`。把"合并 meta+contents / 选默认轨"提取为纯函数 `tracks.js`（无浏览器 API），用 Node 内置 `node:test` 做 TDD；popup 改 ES module import 该函数，渲染拆成 `renderSwitcher`（轨切换器）+ `renderView`（选中轨时间轴）。`manifest.json` / `content.js` / `inject.js` 不动。

**Tech Stack:** 原生 JS（Chrome MV3 扩展）、ES module、`node:test`（Node 22 内置）、puppeteer（现有回归脚本）。

**Spec:** [`docs/superpowers/specs/2026-06-14-subtitle-track-switcher-design.md`](../specs/2026-06-14-subtitle-track-switcher-design.md)

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `apps/subtitle-extractor/tracks.js` | 纯函数：`buildTracks(meta, contents)` 合并字幕轨 + `pickDefaultUrl(tracks)` 选默认轨。无 chrome/document API | 新建 |
| `apps/subtitle-extractor/tracks.test.mjs` | `node:test` 单测：覆盖 buildTracks 合并/规范化/追加未知轨 + pickDefaultUrl | 新建 |
| `apps/subtitle-extractor/popup.js` | import buildTracks；状态 `selectedUrl`；`renderSwitcher` + `renderView` + 轮询 query | 重构 |
| `apps/subtitle-extractor/popup.html` | `#track-switcher` + `#track-view` 结构；切换器样式；`<script type="module">` | 修改 |
| `apps/subtitle-extractor/package.json` | 加 `"type": "module"` + `"test"` 脚本 | 修改 |
| `scripts/verify-extension.mjs` | 回归：确认 inject/content 链路不被破坏（不新增逻辑，仅运行） | 不改，仅运行 |

**测试分层（务实）：** 核心数据逻辑（buildTracks/pickDefaultUrl）→ `node:test` 自动化；DOM 交互（点击切换/复制/视觉）+ 真实端到端 → verify 脚本回归 + 人工验收清单（spec 验收 1/3/4/5/7 的视觉交互部分由 Task 5 人工覆盖）。

---

## Task 1: tracks.js 纯函数 + node:test（TDD）

**Files:**
- Create: `apps/subtitle-extractor/tracks.js`
- Create: `apps/subtitle-extractor/tracks.test.mjs`
- Modify: `apps/subtitle-extractor/package.json`

- [ ] **Step 1: package.json 加 type:module + test 脚本**

改 `apps/subtitle-extractor/package.json` 为：

```json
{
  "name": "@bilibili-ext/subtitle-extractor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "echo 'No build step yet'",
    "test": "node --test tracks.test.mjs"
  }
}
```

> `"type": "module"` 让 node 把 `tracks.js` 当 ESM（含 `export`）。浏览器侧 content_scripts 按 manifest 加载，不读 package.json，不受影响。

- [ ] **Step 2: 写失败测试 `tracks.test.mjs`**

Create `apps/subtitle-extractor/tracks.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTracks, pickDefaultUrl } from './tracks.js';

test('空 meta + 空 contents 返回空数组', () => {
  assert.deepEqual(buildTracks([], {}), []);
  assert.deepEqual(buildTracks(null, null), []);
});

test('meta 单轨 + 匹配 contents，contentData 正确挂载', () => {
  const meta = [{ lan: 'ai-zh', lan_doc: 'AI（简体中文）', type: 1, subtitle_url: '//aisubtitle.hdslb.com/a.json' }];
  const contents = { 'https://aisubtitle.hdslb.com/a.json': { body: [{ from: 0, to: 1, content: 'x' }] } };
  const tracks = buildTracks(meta, contents);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]._url, 'https://aisubtitle.hdslb.com/a.json');
  assert.equal(tracks[0].type, 1);
  assert.equal(tracks[0].contentData.body[0].content, 'x');
});

test('协议相对 URL 规范化（// → https:）', () => {
  const meta = [{ lan: 'zh', lan_doc: '中', type: 2, subtitle_url: '//i0.hdslb.com/bfs/subtitle/b.json' }];
  const tracks = buildTracks(meta, {});
  assert.equal(tracks[0]._url, 'https://i0.hdslb.com/bfs/subtitle/b.json');
});

test('多轨顺序保留', () => {
  const meta = [
    { lan: 'ai-zh', lan_doc: 'AI中文', type: 1, subtitle_url: '//h/a.json' },
    { lan: 'en', lan_doc: '英语', type: 1, subtitle_url: '//h/b.json' },
    { lan: 'zh-Hans', lan_doc: '简体CC', type: 2, subtitle_url: '//h/c.json' },
  ];
  const tracks = buildTracks(meta, {});
  assert.equal(tracks.length, 3);
  assert.equal(tracks[0].lan, 'ai-zh');
  assert.equal(tracks[2].type, 2);
});

test('contents 有 meta 未列出的 url，追加为 unknown 项', () => {
  const meta = [{ lan: 'ai-zh', lan_doc: 'AI', type: 1, subtitle_url: '//h/a.json' }];
  const contents = { 'https://h/extra.json': { body: [] } };
  const tracks = buildTracks(meta, contents);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[1].lan, 'unknown');
  assert.equal(tracks[1].type, 0);
  assert.equal(tracks[1]._url, 'https://h/extra.json');
});

test('pickDefaultUrl 返回首轨 _url，空数组返回空串', () => {
  assert.equal(pickDefaultUrl([{ _url: 'u1' }, { _url: 'u2' }]), 'u1');
  assert.equal(pickDefaultUrl([]), '');
});
```

- [ ] **Step 3: 运行测试，确认失败（tracks.js 不存在）**

Run: `node --test apps/subtitle-extractor/tracks.test.mjs`
Expected: FAIL — `Cannot find module './tracks.js'`

- [ ] **Step 4: 实现 `tracks.js`**

Create `apps/subtitle-extractor/tracks.js`：

```js
export function buildTracks(meta, contents) {
  const normalizeUrl = (url) =>
    !url ? '' : url.startsWith('//') ? 'https:' + url : url;
  const items = (meta || []).map((m) => {
    const url = normalizeUrl(m.subtitle_url);
    return { ...m, _url: url, contentData: contents?.[url] || null };
  });
  const matched = new Set(items.map((i) => i._url));
  for (const [url, data] of Object.entries(contents || {})) {
    if (!matched.has(url)) {
      items.push({
        subtitle_url: url,
        lan: 'unknown',
        lan_doc: '未知',
        type: 0,
        _url: url,
        contentData: data,
      });
    }
  }
  return items;
}

export function pickDefaultUrl(tracks) {
  return tracks[0]?._url || '';
}
```

- [ ] **Step 5: 运行测试，确认全部通过**

Run: `node --test apps/subtitle-extractor/tracks.test.mjs`
Expected: PASS — 6 tests, 0 fail

- [ ] **Step 6: Commit**

```bash
git add apps/subtitle-extractor/tracks.js apps/subtitle-extractor/tracks.test.mjs apps/subtitle-extractor/package.json
git commit -m "feat: 提取 buildTracks 纯函数 + node:test 单测"
```

---

## Task 2: popup.html 结构 + 切换器样式

**Files:**
- Modify: `apps/subtitle-extractor/popup.html`

- [ ] **Step 1: 替换 popup.html 全文**

把 `apps/subtitle-extractor/popup.html` 整体替换为：

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { width: 420px; max-height: 500px; padding: 12px; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; overflow-y: auto; }
    #status { color: #666; padding: 20px 0; text-align: center; }
    #track-switcher { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0; }
    .track-item { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border: 1px solid #e5e5e5; border-radius: 14px; background: #fff; cursor: pointer; font-size: 12px; }
    .track-item:hover { background: #f5f5f5; }
    .track-item-active { border-color: #fb7299; background: #fff0f4; }
    .badge { padding: 1px 6px; border-radius: 8px; font-size: 10px; color: #fff; }
    .badge-ai { background: #fb7299; }
    .badge-cc { background: #23ade5; }
    .badge-unknown { background: #999; }
    .lang { color: #333; }
    .line { display: flex; gap: 8px; padding: 2px 0; line-height: 1.6; }
    .time { color: #999; font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .text { color: #333; }
    .copy-btn { margin-top: 8px; padding: 4px 12px; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 12px; background: #fff; color: #333; }
    .copy-btn:hover { background: #f5f5f5; }
    .loading { color: #999; font-style: italic; padding: 8px 0; }
  </style>
</head>
<body>
  <div id="status">检测字幕中...</div>
  <div id="track-switcher"></div>
  <div id="track-view"></div>
  <script type="module" src="popup.js"></script>
</body>
</html>
```

> 关键变化：去掉原 `#content`，拆成 `#track-switcher`（轨切换器）+ `#track-view`（选中轨展示）；新增 `.track-item` / `.track-item-active` 样式；`<script>` 改 `type="module"`（配合 Task 3 的 import）。保留 `.line`/`.time`/`.text`/`.copy-btn`/`.badge*`/`.loading` 复用。

- [ ] **Step 2: Commit**

```bash
git add apps/subtitle-extractor/popup.html
git commit -m "refactor: popup.html 加字幕轨切换器结构与样式"
```

> 注：此步后扩展暂时不工作（popup.js 还是旧 render、引用了不存在的 `#content`），Task 3 完成后恢复。如希望每步可运行，可把 Task 2/3 合并提交，但分开更易 review。

---

## Task 3: popup.js 重构（import + 切换器 + 选中轨）

**Files:**
- Modify: `apps/subtitle-extractor/popup.js`

- [ ] **Step 1: 替换 popup.js 全文**

把 `apps/subtitle-extractor/popup.js` 整体替换为：

```js
import { buildTracks, pickDefaultUrl } from './tracks.js';

let selectedUrl = "";

document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  const switcher = document.getElementById("track-switcher");
  const view = document.getElementById("track-view");
  let lastDataStr = "";

  function fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function typeBadge(t) {
    const isAI = t.type === 1;
    const label = isAI ? "AI" : t.type === 2 ? "CC" : "?";
    const cls = isAI ? "badge-ai" : t.type === 2 ? "badge-cc" : "badge-unknown";
    return { label, cls };
  }

  function renderSwitcher(tracks) {
    switcher.innerHTML = "";
    for (const t of tracks) {
      const b = typeBadge(t);
      const item = document.createElement("button");
      item.className = "track-item" + (t._url === selectedUrl ? " track-item-active" : "");
      item.innerHTML =
        `<span class="badge ${b.cls}">${b.label}</span>` +
        `<span class="lang">${t.lan_doc || t.lan || "?"}</span>`;
      item.onclick = () => {
        selectedUrl = t._url;
        renderSwitcher(tracks);
        renderView(tracks);
      };
      switcher.appendChild(item);
    }
  }

  function renderView(tracks) {
    const t = tracks.find((x) => x._url === selectedUrl) || null;
    view.innerHTML = "";
    if (!t) return;
    if (t.contentData?.body?.length) {
      const body = document.createElement("div");
      for (const line of t.contentData.body) {
        const el = document.createElement("div");
        el.className = "line";
        el.innerHTML =
          `<span class="time">${fmt(line.from)} → ${fmt(line.to)}</span>` +
          `<span class="text">${line.content || ""}</span>`;
        body.appendChild(el);
      }
      view.appendChild(body);

      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "复制字幕";
      btn.onclick = () => {
        const text = t.contentData.body.map((l) => l.content).join("\n");
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = "已复制！";
          setTimeout(() => (btn.textContent = "复制字幕"), 2000);
        });
      };
      view.appendChild(btn);
    } else {
      const loading = document.createElement("div");
      loading.className = "loading";
      loading.textContent = "字幕内容加载中...";
      view.appendChild(loading);
    }
  }

  function render(meta, contents) {
    const tracks = buildTracks(meta, contents);
    if (tracks.length === 0) return false;
    if (!tracks.some((t) => t._url === selectedUrl)) {
      selectedUrl = pickDefaultUrl(tracks);
    }
    status.style.display = "none";
    renderSwitcher(tracks);
    renderView(tracks);
    return true;
  }

  function query() {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        status.textContent = "请在 B 站视频页面使用此扩展";
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "GET_SUBTITLE" }, (res) => {
        if (chrome.runtime.lastError || !res) {
          status.textContent = "未连接到页面，请刷新视频页面后重试";
          return;
        }
        const dataStr = JSON.stringify(res);
        if (dataStr === lastDataStr) return;
        lastDataStr = dataStr;
        if (!render(res.meta, res.contents)) {
          status.textContent = "未检测到字幕，请刷新视频页面后重试";
          status.style.display = "";
        }
      });
    });
  }

  query();
  setInterval(query, 2000);
});
```

> 关键逻辑：
> - `selectedUrl` 模块级状态，跨轮询保持选中
> - `render()` 里 `if (!tracks.some(t => t._url === selectedUrl)) selectedUrl = pickDefaultUrl(tracks)` —— 选中轨消失时回退 `meta[0]`（spec 验收 6）
> - `renderSwitcher` 点击切轨 → 重渲染切换器（更新高亮）+ `renderView`（spec 验收 3）
> - `renderView` 拿选中轨渲染时间轴逐行 + 复制按钮（spec 验收 2/4）

- [ ] **Step 2: 单测仍通过（确认 import 不破坏纯函数）**

Run: `node --test apps/subtitle-extractor/tracks.test.mjs`
Expected: PASS — 6 tests（tracks.js 未改）

- [ ] **Step 3: Commit**

```bash
git add apps/subtitle-extractor/popup.js
git commit -m "feat: popup 改字幕轨切换器 + 选中轨时间轴逐行"
```

---

## Task 4: 回归 — verify-extension.mjs 确认链路不受影响

**Files:**
- 不改代码，仅运行 `scripts/verify-extension.mjs`

- [ ] **Step 1: 运行回归脚本**

Run: `node scripts/verify-extension.mjs`
Expected:
```
[1] inject.js 注入: ✅ fetch 已 hook (...)
[2] player API 拦截 + META: ✅
[3] 字幕内容拦截: ✅ (请求 3 条，捕获 3 条内容)
=== 字幕类型分析 ===
  - AI（简体中文） | AI自动生成 | lan=ai-zh | 内容=✅
  - 英语（机器翻译） | AI自动生成 | lan=en | 内容=✅
  - 简体中文（UP上传） | UP主上传(CC) | lan=zh-Hans | 内容=✅
内容样例: [...]
```

> 前置：需已 `pnpm add -D puppeteer`（脚本头注释说明）。若未装：`pnpm add -D puppeteer` 后重跑。
> 目的：popup 重构不该影响 inject/content 链路（本就未动这些文件），此步是回归保险，确认 ES module 改造没破坏扩展加载/注入。

- [ ] **Step 2: 若 [1] 显示 ❌ 未注入**

说明 `type: "module"` 或 import 影响了扩展加载。排查：
- 确认 `popup.html` script 是 `type="module"`（仅 popup 用 module，content_scripts 不受影响）
- 确认 `manifest.json` 未被改动（content_scripts 仍引 `inject.js` / `content.js`，这俩文件未改、未加 import）
- inject.js / content.js 是 IIFE / 普通脚本，不含 `import`/`export`，ESM 改造不影响它们

---

## Task 5: 人工端到端验收（"看着插件干活"）

**Files:** 无（验收清单，对照 spec 第 6 章验收标准）

> 背景：chrome-devtools MCP 连的是系统 Chrome（独立 profile），手动 UI 加载扩展后 content script 可注入（[`MANUAL.md`](../../../MANUAL.md) 第 2 章「手动安装」）。真实字幕需登录态 + 用户点字幕按钮触发（[`MANUAL.md`](../../../MANUAL.md) 第 3 章）。

- [ ] **Step 1: 加载扩展到浏览器**

在 chrome-devtools MCP 浏览器（已登录 B 站）：
1. 导航到 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」→ 选 `apps/subtitle-extractor` 目录（参考 [`MANUAL.md`](../../../MANUAL.md) 第 7 章 2026-06-10 01:50 半自动流程：用户点按钮 → AppleScript `Cmd+Shift+G` 输入 `/Users/taevas/code/mymy/bilibili-extensions/apps/subtitle-extractor` → Enter）

- [ ] **Step 2: 打开有字幕的视频，触发字幕加载**

导航到测试视频 `https://www.bilibili.com/video/BV1qcEE6FEhn/`（[`MANUAL.md`](../../../MANUAL.md) 第 3 章测试视频，有 AI 字幕），播放后点播放器右下角「字幕」按钮选择字幕语言（触发字幕内容请求 → inject 拦截 → content.js 存储）。

- [ ] **Step 3: 逐项验收（对照 spec 第 6 章）**

| 验收项 | 操作 | 期望 |
|---|---|---|
| 1 | 点扩展图标打开 popup | `#track-switcher` 列出字幕轨（AI/CC badge + 语言） |
| 2 | 看 popup 默认状态 | 默认选中第一条轨（`track-item-active`），下方时间轴逐行 |
| 3 | 点切换器另一轨 | `#track-view` 切换为该轨内容，高亮转移 |
| 4 | 点「复制字幕」 | 剪贴板含选中轨全部文本，按钮变「已复制！」2 秒 |
| 5 | 在无字幕视频打开 popup | 显示「未检测到字幕...」提示 |
| 6 | 切换轨后等 2s+ 轮询 | 选中轨保持（不被重置回第一条） |
| 7 | 全程真实字幕 | 真实登录态下显示真实字幕文本（非 mock） |

- [ ] **Step 4: 验收通过，更新 MANUAL.md**

在 [`MANUAL.md`](../../../MANUAL.md) 顶部「决定性突破」后追加一节，记录：字幕轨切换器 popup 已实现 + 真实端到端验证结果（哪些视频/轨验证通过）。

---

## Self-Review

**1. Spec 覆盖：**
- 验收 1（切换器列轨）→ Task 3 `renderSwitcher` + Task 5 人工 ✓
- 验收 2（默认选中 + 时间轴）→ Task 1 `pickDefaultUrl` 单测 + Task 3 `renderView` + Task 5 ✓
- 验收 3（点击切换）→ Task 3 `item.onclick` + Task 5 人工 ✓
- 验收 4（复制）→ Task 3 copy btn + Task 5 人工 ✓
- 验收 5（无字幕提示）→ Task 3 `query` status 分支（沿用现有）+ Task 5 ✓
- 验收 6（轮询保持选中）→ Task 1 单测 + Task 3 `render` 的 `some` 判断 + Task 5 ✓
- 验收 7（真实端到端）→ Task 4 回归 + Task 5 真实 ✓

**2. 占位符扫描：** 无 TBD/TODO；每步含完整代码或确切命令。✓

**3. 类型/命名一致性：** `buildTracks` / `pickDefaultUrl` / `selectedUrl` / `_url` / `renderSwitcher` / `renderView` 在 Task 1/3 一致；`tracks.test.mjs` import 的导出名与 `tracks.js` export 一致。✓

**已知缺口（已务实覆盖）：** DOM 交互（点击切换/复制/视觉高亮）无自动化测试，由 Task 5 人工验收清单覆盖；核心数据逻辑由 Task 1 `node:test` 覆盖。
