# 主动采集 P1（AI 驱动 / 全扩展通信）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给主题 → Claude skill + `collector-cli` 驱动 `subtitle-collector` 扩展，全自动搜 B 站 → 捞字幕 → 聚合；已采视频不重采。

**Architecture:** 全扩展通信——B 站数据获取只由扩展在浏览器内 `fetch`（cookie 自动带）。新增 4 个 WS action（P1 用 `search` + `fetch-subtitle`），复用已实现的 `requestCommand` + pending Map 通道。CLI 新增 `collect` 命令组（底层复用 `ServerClient.sendCommand` + 直读 SQLite）。Claude skill 文档化命令序列。

**Tech Stack:** subtitle-collector（Vite + crxjs，裸 JS background/content/inject 经 Rollup 打包，ESM）、collector-server（Node + tsx + commander + better-sqlite3 + ws）、测试（扩展 `node --test test/*.test.mjs` + `scripts/verify-*.mjs` puppeteer；server `node --test --import tsx src/**/*.test.ts`）。

**范围：** P1（主线）。P2（UP 主维度）见 spec §12 B1–B4，待 P1 落地后单独出 plan。spec：[2026-07-05-active-collection-design.md](../specs/2026-07-05-active-collection-design.md)。

---

## File Structure

**扩展（subtitle-collector）—— 新增 3 个纯模块 + 改 background：**
- `apps/subtitle-collector/wbi.js`（新）—— Wbi 签名纯函数（`MIXIN_KEY_ENC_TAB` / `getMixinKey` / `encWbi` / `extractKeysFromNav`）
- `apps/subtitle-collector/bili-fetch.js`（新）—— B 站响应解析纯函数（`parseBiliResponse` / `formatSearchResult`）+ 浏览器侧 `biliFetch` 编排
- `apps/subtitle-collector/ingest-payload.js`（新）—— fetch-subtitle 的 payload 组装纯函数（`extractExtraFromView` / `buildIngestPayload`）
- `apps/subtitle-collector/background.js`（改）—— 新增 `search` action、替换 `fetch-subtitle` 占位为真实实现
- `apps/subtitle-collector/package.json`（改）—— 加 `md5` 依赖（Wbi 需要 MD5；浏览器无原生 MD5）

**测试（扩展）：**
- `apps/subtitle-collector/test/wbi.test.mjs`（新）
- `apps/subtitle-collector/test/bili-fetch.test.mjs`（新）
- `apps/subtitle-collector/test/ingest-payload.test.mjs`（新）
- `scripts/verify-active-collect.mjs`（新）—— puppeteer 端到端

**CLI（collector-server）—— 新增 collect 命令组：**
- `apps/collector-server/src/cli/commands/collect.ts`（新）—— `collect search/subtitle/dedupe` 纯处理 + commander 装配
- `apps/collector-server/src/cli/commands/collect.test.ts`（新）—— 纯处理单测
- `apps/collector-server/src/cli/main.ts`（改）—— 注册 `collect` 命令组

**skill：**
- `.claude/skills/bili-collect/SKILL.md`（新）—— Claude skill 文档

**职责边界：** 三个扩展纯模块各自单一职责、可独立单测、被 background.js 编排；CLI collect.ts 纯处理函数接 `ServerClient`/`Database`，commander 装配与现有命令组同模式；不碰 server WS 协议（已支持任意 action）。

---

## Task 1: Wbi 签名纯模块

**Files:**
- Modify: `apps/subtitle-collector/package.json`（加 `md5` 依赖）
- Create: `apps/subtitle-collector/wbi.js`
- Test: `apps/subtitle-collector/test/wbi.test.mjs`

- [ ] **Step 1: 加 md5 依赖**

Run:
```bash
pnpm --filter @bilibili-ext/subtitle-collector add md5
```
Expected: `apps/subtitle-collector/package.json` 的 `dependencies` 出现 `"md5": "^2.x"`，pnpm-lock 同步。

- [ ] **Step 2: 写失败测试**

`apps/subtitle-collector/test/wbi.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIXIN_KEY_ENC_TAB, getMixinKey, encWbi, extractKeysFromNav } from '../wbi.js';

test('MIXIN_KEY_ENC_TAB 长度 64', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64);
});

// 测试向量来自 bilibili-API-collect wbi.md（Rust demo tests）
test('getMixinKey 对已知 img_key+sub_key 得固定 mixin_key', () => {
  const img = '7cd084941338484aae1ad9425b84077c';
  const sub = '4932caff0ff746eab6f01bf08b70ac45';
  assert.equal(getMixinKey(img + sub), 'ea1db124af3c7062474693fa704f4ff8');
});

test('encWbi 固定 wts 得固定 w_rid', () => {
  const img = '7cd084941338484aae1ad9425b84077c';
  const sub = '4932caff0ff746eab6f01bf08b70ac45';
  const out = encWbi({ foo: '114', bar: '514', zab: 1919810 }, img, sub, 1702204169);
  assert.equal(out, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
});

test('encWbi 过滤 value 中的 !\\'()* 字符', () => {
  const out = encWbi({ k: "a'b(c)" }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169);
  assert.match(out, /k=abc/); // !'()* 被过滤
});

test('extractKeysFromNav 从 nav 响应抽 img_key/sub_key', () => {
  const nav = { data: { wbi_img: {
    img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  } } };
  assert.deepEqual(extractKeysFromNav(nav), {
    img_key: '7cd084941338484aae1ad9425b84077c',
    sub_key: '4932caff0ff746eab6f01bf08b70ac45',
  });
});
```

- [ ] **Step 3: 跑测试看失败**

Run:
```bash
pnpm --filter @bilibili-ext/subtitle-collector test
```
Expected: FAIL —— `Cannot find module '../wbi.js'`。

- [ ] **Step 4: 实现 wbi.js**

`apps/subtitle-collector/wbi.js`:
```javascript
import md5 from 'md5';

// 社区公开的 64 项重排表（bilibili-API-collect wbi.md）
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

// 对 imgKey+subKey 重排，取前 32 字符 → mixin_key
export function getMixinKey(raw) {
  return MIXIN_KEY_ENC_TAB.map((n) => raw[n]).join('').slice(0, 32);
}

// Wbi 签名：返回完整的 query string（含 wts + w_rid）。wts 缺省取当前秒。
export function encWbi(params, imgKey, subKey, wts = Math.round(Date.now() / 1000)) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const chrFilter = /[!'()*]/g;
  const query = Object.keys({ ...params, wts })
    .sort()
    .map((key) => {
      const value = String({ ...params, wts }[key]).replace(chrFilter, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const wRid = md5(query + mixinKey);
  return `${query}&w_rid=${wRid}`;
}

// 从 nav 接口响应抽 img_key / sub_key（去 URL 前缀和 .png 后缀）
export function extractKeysFromNav(navData) {
  const img = navData?.data?.wbi_img?.img_url ?? '';
  const sub = navData?.data?.wbi_img?.sub_url ?? '';
  return {
    img_key: img.slice(img.lastIndexOf('/') + 1, img.lastIndexOf('.')),
    sub_key: sub.slice(sub.lastIndexOf('/') + 1, sub.lastIndexOf('.')),
  };
}
```

- [ ] **Step 5: 跑测试看通过**

Run:
```bash
pnpm --filter @bilibili-ext/subtitle-collector test
```
Expected: PASS（5 个 test 全过）。

- [ ] **Step 6: Commit**

```bash
git add apps/subtitle-collector/wbi.js apps/subtitle-collector/test/wbi.test.mjs apps/subtitle-collector/package.json pnpm-lock.yaml
git commit -m "feat(subtitle-collector): Wbi 签名纯模块 + 测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: B 站响应解析纯模块（bili-fetch.js）

**Files:**
- Create: `apps/subtitle-collector/bili-fetch.js`
- Test: `apps/subtitle-collector/test/bili-fetch.test.mjs`

- [ ] **Step 1: 写失败测试**

`apps/subtitle-collector/test/bili-fetch.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBiliResponse, formatSearchResult } from '../bili-fetch.js';

test('parseBiliResponse code:0 返回 data', () => {
  assert.deepEqual(parseBiliResponse({ code: 0, data: { foo: 1 } }), { ok: true, data: { foo: 1 } });
});

test('parseBiliResponse code:-101 → need_login', () => {
  assert.deepEqual(parseBiliResponse({ code: -101 }), { ok: false, code: 'need_login' });
});

test('parseBiliResponse code:-412 → risk_control', () => {
  assert.deepEqual(parseBiliResponse({ code: -412 }), { ok: false, code: 'risk_control' });
});

test('parseBiliResponse 其他错误码透传', () => {
  assert.deepEqual(parseBiliResponse({ code: -509, message: 'x' }), { ok: false, code: 'bili_-509', message: 'x' });
});

test('formatSearchResult 把 search response.data 格式化成 {total, items}', () => {
  const data = {
    page: { count: 137 },
    result: [
      { bvid: 'BV1a', title: 't1', author: 'up1', mid: 11, play: 100, duration: 120, pubdate: 1700000000 },
      { bvid: 'BV2b', title: 't2', author: 'up2', mid: 22, play: 200, duration: 60, pubdate: 1700000001 },
    ],
  };
  const out = formatSearchResult(data);
  assert.equal(out.total, 137);
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].bvid, 'BV1a');
  assert.equal(out.items[0].up, 'up1');
  assert.equal(out.items[0].mid, 11);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @bilibili-ext/subtitle-collector test`
Expected: FAIL —— `Cannot find module '../bili-fetch.js'`。

- [ ] **Step 3: 实现 bili-fetch.js**

`apps/subtitle-collector/bili-fetch.js`:
```javascript
import { encWbi } from './wbi.js';

const BILI_API = 'https://api.bilibili.com';

// 把 B 站响应体归一化：code:0 → data；-101 → need_login；-412 → risk_control；其余透传 code。
export function parseBiliResponse(body) {
  if (!body || typeof body.code !== 'number') {
    return { ok: false, code: 'malformed', message: 'non-json or missing code' };
  }
  if (body.code === 0) return { ok: true, data: body.data };
  if (body.code === -101) return { ok: false, code: 'need_login' };
  if (body.code === -412) return { ok: false, code: 'risk_control' };
  return { ok: false, code: `bili_${body.code}`, message: body.message ?? '' };
}

// search/type response.data → { total, items:[{bvid,title,up,mid,play,duration,pubdate}] }
export function formatSearchResult(data) {
  const items = Array.isArray(data?.result) ? data.result.map((r) => ({
    bvid: r.bvid, title: r.title, up: r.author, mid: r.mid,
    play: r.play ?? 0, duration: r.duration ?? 0, pubdate: r.pubdate ?? 0,
  })) : [];
  return { total: data?.page?.count ?? items.length, items };
}

// 浏览器侧 fetch 编排：扩展 background 调用，cookie 自动带。
//   wbi:true → 先算 Wbi 签名（需 wbiKeys）；headers 固定 Referer。
//   返回 { ok, data } 或 { ok:false, code }（供 action 处理器直接回执）。
export async function biliFetch(pathname, { wbi = false, params = {}, wbiKeys = null } = {}) {
  let url = BILI_API + pathname;
  if (wbi) {
    if (!wbiKeys) throw new Error('wbiKeys required for wbi request');
    url += '?' + encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
  } else {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += '?' + qs;
  }
  const res = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/' } });
  const body = await res.json().catch(() => null);
  return parseBiliResponse(body);
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @bilibili-ext/subtitle-collector test`
Expected: PASS（两个新 test + Task 1 的 5 个全过）。

- [ ] **Step 5: Commit**

```bash
git add apps/subtitle-collector/bili-fetch.js apps/subtitle-collector/test/bili-fetch.test.mjs
git commit -m "feat(subtitle-collector): bili-fetch 响应解析纯模块 + 测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: fetch-subtitle 的 payload 组装纯模块（ingest-payload.js）

**Files:**
- Create: `apps/subtitle-collector/ingest-payload.js`
- Test: `apps/subtitle-collector/test/ingest-payload.test.mjs`

- [ ] **Step 1: 写失败测试**

`apps/subtitle-collector/test/ingest-payload.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractExtraFromView, buildIngestPayload } from '../ingest-payload.js';

const view = {
  bvid: 'BV1xx', aid: 11, cid: 22, title: '标题', pic: 'https://pic',
  desc: '简介', ctime: 1700000000, pubdate: 1700000000, tid: 17, tname: '单机游戏',
  copyright: 1, state: 0, pub_location: 'IP 上海',
  tags: [{ tag_id: 1, tag_name: '游戏' }], dimension: { width: 1920, height: 1080, rotate: 0 },
  pages: [{ cid: 22, page: 1, part: 'P1', duration: 120 }],
  rights: { download: 1 }, honor_reply: { honor: [] }, ugc_season: null,
  stat: { view: 10, danmaku: 1, reply: 2, favorite: 3, coin: 4, share: 5, like: 6, now_rank: 0, his_rank: 0 },
  duration: 120, up: { mid: 99, name: 'up主', face: 'https://face' },
};

test('extractExtraFromView 抽齐 extra 字段', () => {
  const extra = extractExtraFromView(view);
  assert.equal(extra.aid, 11);
  assert.equal(extra.cid, 22);
  assert.equal(extra.pic, 'https://pic');
  assert.equal(extra.desc, '简介');
  assert.equal(extra.tid, 17);
  assert.equal(extra.tname, '单机游戏');
  assert.equal(extra.publocation, 'IP 上海');
  assert.deepEqual(extra.tags, [{ tag_id: 1, tag_name: '游戏' }]);
  assert.equal(extra.stat.view, 10);
});

test('buildIngestPayload 组装完整 payload（含轨+版本）', () => {
  const subs = [{ lan: 'zh-Hans', lan_doc: '简体中文', type: 2, subtitle_url: '//aisubtitle.hdslb.com/x.json' }];
  const bodies = { '//aisubtitle.hdslb.com/x.json': { body: [{ from: 0, to: 1, content: '字' }] } };
  const payload = buildIngestPayload(view, subs, bodies);
  assert.equal(payload.source, 'bilibili');
  assert.equal(payload.video.source_vid, 'BV1xx');
  assert.equal(payload.video.title, '标题');
  assert.equal(payload.video.creator.name, 'up主');
  assert.equal(payload.video.creator.avatar, 'https://face');
  assert.equal(payload.video.duration, 120);
  assert.equal(payload.video.published_at, 1700000000000);
  assert.equal(payload.tracks.length, 1);
  assert.equal(payload.tracks[0].lan, 'zh-Hans');
  assert.equal(payload.tracks[0].versions[0].origin, 'external');
  assert.deepEqual(payload.tracks[0].versions[0].payload, { body: [{ from: 0, to: 1, content: '字' }] });
});

test('buildIngestPayload 无字幕 → tracks:[]', () => {
  const payload = buildIngestPayload(view, [], {});
  assert.deepEqual(payload.tracks, []);
  assert.equal(payload.video.source_vid, 'BV1xx'); // video 仍组装
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @bilibili-ext/subtitle-collector test`
Expected: FAIL —— `Cannot find module '../ingest-payload.js'`。

- [ ] **Step 3: 实现 ingest-payload.js**

`apps/subtitle-collector/ingest-payload.js`:
```javascript
// 从 /x/web-interface/view 响应抽 extra（字段集对齐 inject.js readVideoExtra / schema.sql extra 注释）
export function extractExtraFromView(v) {
  const extra = { aid: v?.aid ?? null, cid: v?.cid ?? null, pic: v?.pic ?? null };
  if (!v) return extra;
  if (v.desc != null) extra.desc = v.desc;
  if (v.ctime != null) extra.ctime = v.ctime;
  if (v.tid != null) extra.tid = v.tid;
  if (v.tname != null) extra.tname = v.tname;
  if (v.copyright != null) extra.copyright = v.copyright;
  if (v.state != null) extra.state = v.state;
  if (v.pub_location != null) extra.publocation = v.pub_location;
  if (Array.isArray(v.tags)) extra.tags = v.tags.map((t) => ({ tag_id: t.tag_id, tag_name: t.tag_name }));
  if (v.dimension) extra.dimension = { width: v.dimension.width, height: v.dimension.height, rotate: v.dimension.rotate };
  if (Array.isArray(v.pages)) extra.pages = v.pages.map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration }));
  if (v.rights) extra.rights = v.rights;
  if (v.honor_reply) extra.honor = v.honor_reply;
  if (v.ugc_season) extra.ugc_season = { id: v.ugc_season.id, title: v.ugc_season.title };
  if (v.stat) {
    const s = v.stat;
    extra.stat = {
      view: s.view ?? null, danmaku: s.danmaku ?? null, reply: s.reply ?? null,
      favorite: s.favorite ?? null, coin: s.coin ?? null, share: s.share ?? null,
      like: s.like ?? null, now_rank: s.now_rank ?? null, his_rank: s.his_rank ?? null,
    };
  }
  return extra;
}

function normalizeUrl(u) {
  return typeof u === 'string' && u.startsWith('//') ? 'https:' + u : u;
}

// 组装 ingest payload（结构对齐 content.js flushIfReady 的 record）
export function buildIngestPayload(view, subs, subtitleBodies) {
  return {
    source: 'bilibili',
    video: {
      source_vid: view.bvid,
      creator: {
        source_uid: String(view.up?.mid ?? ''),
        name: view.up?.name ?? null,
        avatar: view.up?.face ?? null,
      },
      title: view.title,
      extra: extractExtraFromView(view),
      duration: view.duration ?? null,
      published_at: view.pubdate ? view.pubdate * 1000 : null,
    },
    tracks: (subs ?? []).map((s) => ({
      lan: s.lan, lan_doc: s.lan_doc, track_type: s.type ?? null,
      versions: [{
        origin: 'external',
        payload: subtitleBodies[normalizeUrl(s.subtitle_url)] ?? null,
        source_url: normalizeUrl(s.subtitle_url),
      }],
    })),
  };
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @bilibili-ext/subtitle-collector test`
Expected: PASS（3 个新 test + 之前的全过）。

- [ ] **Step 5: Commit**

```bash
git add apps/subtitle-collector/ingest-payload.js apps/subtitle-collector/test/ingest-payload.test.mjs
git commit -m "feat(subtitle-collector): ingest payload 组装纯模块 + 测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 扩展 background `search` action

**Files:**
- Modify: `apps/subtitle-collector/background.js`（顶部加 import + action 分发加 search 分支 + wbiKeys 缓存）

> 说明：编排层（fetch + WS）依赖浏览器 chrome.*/fetch，无法纯单测；本 task 的 TDD = `vite build` 冒烟（确保 SW 不语法错、能打包），端到端功能验证在 Task 9 的 `verify-active-collect.mjs`。纯逻辑（签名/解析/格式化）已在 Task 1–3 单测覆盖。

- [ ] **Step 1: 先确认现状（build 冒烟基线）**

Run:
```bash
pnpm --filter @bilibili-ext/subtitle-collector build
```
Expected: build 成功（dist/ 产出 manifest.json）。

- [ ] **Step 2: 改 background.js —— 加 import + wbiKeys 缓存**

在 `apps/subtitle-collector/background.js` 顶部现有 import 块（[:1-2](../../apps/subtitle-collector/background.js#L1)）后追加：
```javascript
import { extractKeysFromNav } from "./wbi.js";
import { biliFetch, formatSearchResult } from "./bili-fetch.js";
```

在 `let clientId = null;`（[:8](../../apps/subtitle-collector/background.js#L8)）那一段的模块级变量区追加：
```javascript
// Wbi img_key/sub_key 缓存（每日更替，这里简化为进程内缓存，刷新见 refreshWbiKeys）
let wbiKeys = null;
async function refreshWbiKeys() {
  const parsed = await biliFetch('/x/web-interface/nav');
  if (!parsed.ok) throw new Error('nav fetch failed: ' + (parsed.code ?? ''));
  wbiKeys = extractKeysFromNav(parsed.data);
  return wbiKeys;
}
```

- [ ] **Step 3: 改 background.js —— action 分发加 search 分支**

在 `ws.onmessage` 的 action 分发（[background.js:65](../../apps/subtitle-collector/background.js#L65) `if (msg.action === "navigate")`）链里，`else if (msg.action === "operate")` 之前插入 `search` 分支：
```javascript
      } else if (msg.action === "search") {
        try {
          if (!wbiKeys) await refreshWbiKeys();
          const parsed = await biliFetch('/x/web-interface/wbi/search/type', {
            wbi: true,
            params: {
              search_type: 'video',
              keyword: msg.keyword,
              page: msg.page ?? 1,
              order: msg.order ?? 'pubdate',
              ...(msg.tid ? { tid: msg.tid } : {}),
            },
            wbiKeys,
          });
          if (!parsed.ok) {
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: parsed.code }));
          } else {
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: formatSearchResult(parsed.data) }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
```

- [ ] **Step 4: build 冒烟**

Run: `pnpm --filter @bilibili-ext/subtitle-collector build`
Expected: build 成功，dist/ 重新产出。

- [ ] **Step 5: Commit**

```bash
git add apps/subtitle-collector/background.js
git commit -m "feat(subtitle-collector): search action（扩展内 fetch 搜索接口）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 扩展 background `fetch-subtitle` action（真正实现，替换占位）

**Files:**
- Modify: `apps/subtitle-collector/background.js`（import + 替换 fetch-subtitle 占位分支）

- [ ] **Step 1: 改 background.js —— 加 import**

在 Task 4 追加的 import 块里再加：
```javascript
import { buildIngestPayload } from "./ingest-payload.js";
```

- [ ] **Step 2: 替换 fetch-subtitle 占位分支**

把 `apps/subtitle-collector/background.js` 的 fetch-subtitle 占位（[background.js:81-83](../../apps/subtitle-collector/background.js#L81)）：
```javascript
      } else if (msg.action === "fetch-subtitle") {
        // MVP 占位（spec §6.2/§7.3 明列，协议闭环不吞 id；后续可接真实逻辑）
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "not implemented" }));
```
替换为：
```javascript
      } else if (msg.action === "fetch-subtitle") {
        try {
          const bvid = msg.bvid;
          // 1. view：完整元信息（标题/UP/stat/tags/pages/desc，组装 extra）
          const viewRes = await biliFetch('/x/web-interface/view', { params: { bvid } });
          if (!viewRes.ok) { ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: viewRes.code })); return; }
          const view = viewRes.data;
          // 2. player/wbi/v2：字幕轨
          if (!wbiKeys) await refreshWbiKeys();
          const playerRes = await biliFetch('/x/player/wbi/v2', { wbi: true, params: { bvid, aid: view.aid, cid: view.cid }, wbiKeys });
          if (!playerRes.ok) { ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: playerRes.code })); return; }
          const subs = playerRes.data?.subtitle?.subtitles ?? [];
          // 3. 字幕体
          const bodies = {};
          for (const s of subs) {
            const url = s.subtitle_url?.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url;
            if (!url) continue;
            const r = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/' } });
            if (r.ok) bodies[url] = await r.json().catch(() => null);
          }
          // 4. ingest（无字幕也入库 video，避免重采）
          const payload = buildIngestPayload(view, subs, bodies);
          ws.send(JSON.stringify({ type: "ingest", payload }));
          // 5. 回执（这里不阻塞等 ingest-ack；ingest 由 server 异步入库，回执只报采集到的轨数）
          ws.send(JSON.stringify({
            type: "result", id: msg.id, ok: true,
            data: { bvid, tracks: subs.length, ingested: true, ...(subs.length === 0 ? { reason: 'no_subtitle' } : {}) },
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
```

- [ ] **Step 3: build 冒烟**

Run: `pnpm --filter @bilibili-ext/subtitle-collector build`
Expected: build 成功。

- [ ] **Step 4: Commit**

```bash
git add apps/subtitle-collector/background.js
git commit -m "feat(subtitle-collector): fetch-subtitle action 真正实现（view+player+字幕体→ingest）

替换 not implemented 占位。无字幕视频也入 video，避免重采。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: CLI `collect` 命令组骨架 + `collect search`

**Files:**
- Create: `apps/collector-server/src/cli/commands/collect.ts`
- Create: `apps/collector-server/src/cli/commands/collect.test.ts`
- Modify: `apps/collector-server/src/cli/main.ts`（注册 collect）

- [ ] **Step 1: 写失败测试**

`apps/collector-server/src/cli/commands/collect.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSearch, resolveClientId } from './collect.js';

// mock ServerClient：记录调用的 sendCommand 参数，返回固定回执。
function mockClient(sendCommandResult: unknown, listClientsResult: unknown[] = [{ client_id: 'c1' }]) {
  const calls: Array<{ clientId: string; action: string; params: unknown; timeout: number }> = [];
  return {
    calls,
    async listClients() { return listClientsResult as unknown[]; },
    async sendCommand(clientId: string, action: string, params: Record<string, unknown>, timeout: number) {
      calls.push({ clientId, action, params, timeout });
      return sendCommandResult;
    },
  };
}

test('collectSearch 下发 search action 并透传回执', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { total: 5, items: [{ bvid: 'BV1' }] } } });
  const out = await collectSearch(c as any, 'c1', 'RAG', { page: 2, order: 'pubdate' }, 15000);
  assert.deepEqual(c.calls[0], { clientId: 'c1', action: 'search', params: { keyword: 'RAG', page: 2, order: 'pubdate' }, timeout: 15000 });
  assert.deepEqual(out, { ok: true, result: { ok: true, data: { total: 5, items: [{ bvid: 'BV1' }] } } });
});

test('resolveClientId 显式传入则透传', async () => {
  const c = mockClient([], [{ client_id: 'c1' }, { client_id: 'c2' }]);
  assert.equal(await resolveClientId(c as any, 'c2'), 'c2');
  assert.equal(c.calls.length, 0);
});

test('resolveClientId 未传入取第一个在线', async () => {
  const c = mockClient([], [{ client_id: 'c9' }]);
  assert.equal(await resolveClientId(c as any, undefined), 'c9');
});

test('resolveClientId 无在线 client → 抛错', async () => {
  const c = mockClient([], []);
  await assert.rejects(() => resolveClientId(c as any, undefined), /no online client/);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @bilibili-ext/collector-server test`
Expected: FAIL —— `Cannot find module './collect.js'`。

- [ ] **Step 3: 实现 collect.ts（search 部分）**

`apps/collector-server/src/cli/commands/collect.ts`:
```typescript
// collect 命令组：主动去 B 站采集（经 server→扩展，扩展内 fetch）。
// 设计参考 [2026-07-05-active-collection-design.md §6.4](../../../../docs/superpowers/specs/2026-07-05-active-collection-design.md)。
// 底层全部复用 ServerClient.sendCommand + POST /api/clients/:id/command。
// 措辞：字幕（subtitle），非弹幕。
import { Command } from 'commander';
import { ServerClient } from '../http.js';
import { emitResult, emitError } from '../output.js';
import { getCliContext } from '../main.js';

/** 采集类命令默认超时（高于管控类 5000，给扩展 fetch+入库留时间）。 */
const DEFAULT_COLLECT_TIMEOUT_MS = 15000;

/** ServerClient 最小接口（便于测试注入 mock）。 */
export interface CollectClient {
  listClients(): Promise<unknown[]>;
  sendCommand(clientId: string, action: string, params: Record<string, unknown>, timeout: number): Promise<unknown>;
}

/** --client 缺省时取第一个在线 client；无在线 → 抛错（action 前由调用方捕获转 ARGS）。 */
export async function resolveClientId(client: CollectClient, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const list = await client.listClients();
  const first = list.find((c) => (c as { client_id?: string })?.client_id);
  if (!first) throw new Error('no online client（扩展未连接，先确认浏览器已装扩展并已连 server）');
  return (first as { client_id: string }).client_id;
}

// ── 纯处理函数（可测：注入 mock client + 参数，返回结构化数据）──

export interface SearchOpts { page?: number; order?: string; tid?: number; }

/** `collect search <keyword>`：下发 search action，透传 server 响应。 */
export async function collectSearch(
  client: CollectClient,
  clientId: string,
  keyword: string,
  opts: SearchOpts,
  timeout: number,
): Promise<unknown> {
  const params: Record<string, unknown> = { keyword, page: opts.page ?? 1, order: opts.order ?? 'pubdate' };
  if (opts.tid != null) params.tid = opts.tid;
  return client.sendCommand(clientId, 'search', params, timeout);
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @bilibili-ext/collector-server test`
Expected: PASS（4 个新 test）。

- [ ] **Step 5: 装配 commander + 注册到 main.ts**

在 `apps/collector-server/src/cli/commands/collect.ts` 末尾追加 commander 装配：
```typescript
// ── commander 装配 ──
function handleHttpError(err: unknown): never {
  // 复用 clients.ts 的 HTTP 错误归一化语义（不重复 import，保持本文件自包含）
  const msg = err instanceof Error ? err.message : String(err);
  if (/no online client/.test(msg)) emitError(msg, 'ARGS');
  emitError(msg, 'RUNTIME');
}

export function buildCollectCommand(): Command {
  const collect = new Command('collect');
  collect.description('主动采集（经 server→扩展，扩展内 fetch B 站）');

  collect
    .command('search <keyword>')
    .description('关键词搜视频，返回候选列表（不入库）')
    .option('--page <n>', '页码（默认 1）', (v) => Number.parseInt(v, 10), 1)
    .option('--order <o>', '排序（默认 pubdate）', 'pubdate')
    .option('--tid <id>', '分区 tid')
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '等扩展回执的超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (keyword: string, opts: { page: number; order: string; tid?: string; client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const tid = opts.tid != null ? Number.parseInt(opts.tid, 10) : undefined;
        const data = await collectSearch(client as CollectClient, clientId, keyword, { page: opts.page, order: opts.order, tid }, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  return collect;
}
```

在 `apps/collector-server/src/cli/main.ts` 的动态 import 列表（[main.ts:84-100](../../apps/collector-server/src/cli/main.ts#L84)）加 `buildCollectCommand`：
- Promise.all 数组加 `{ buildCollectCommand }` 与 `import('./commands/collect.js')`
- addCommand 序列加 `program.addCommand(buildCollectCommand());` 并注释 `// collect search / subtitle / dedupe`

- [ ] **Step 6: 跑测试 + 手动冒烟**

Run:
```bash
pnpm --filter @bilibili-ext/collector-server test
pnpm --filter @bilibili-ext/collector-server cli -- --help
```
Expected: test PASS；`--help` 输出含 `collect`。

- [ ] **Step 7: Commit**

```bash
git add apps/collector-server/src/cli/commands/collect.ts apps/collector-server/src/cli/commands/collect.test.ts apps/collector-server/src/cli/main.ts
git commit -m "feat(cli): collect 命令组骨架 + collect search

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: CLI `collect subtitle <bvid>`

**Files:**
- Modify: `apps/collector-server/src/cli/commands/collect.ts`（加纯处理 + commander）
- Modify: `apps/collector-server/src/cli/commands/collect.test.ts`（加测试）

- [ ] **Step 1: 写失败测试（追加到 collect.test.ts）**

```typescript
test('collectSubtitle 下发 fetch-subtitle action', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { bvid: 'BV1', tracks: 2, ingested: true } } });
  const out = await collectSubtitle(c as any, 'c1', 'BV1', 15000);
  assert.deepEqual(c.calls[0], { clientId: 'c1', action: 'fetch-subtitle', params: { bvid: 'BV1' }, timeout: 15000 });
  assert.deepEqual(out, { ok: true, result: { ok: true, data: { bvid: 'BV1', tracks: 2, ingested: true } } });
});
```
并在文件顶部 import 加 `collectSubtitle`。

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @bilibili-ext/collector-server test`
Expected: FAIL —— `collectSubtitle is not defined`。

- [ ] **Step 3: 实现纯处理**

在 `collect.ts` 的纯处理区追加：
```typescript
/** `collect subtitle <bvid>`：下发 fetch-subtitle，扩展 fetch view+player+字幕体→ingest。 */
export async function collectSubtitle(
  client: CollectClient,
  clientId: string,
  bvid: string,
  timeout: number,
): Promise<unknown> {
  return client.sendCommand(clientId, 'fetch-subtitle', { bvid }, timeout);
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @bilibili-ext/collector-server test`
Expected: PASS。

- [ ] **Step 5: 装配 commander（在 buildCollectCommand 内加子命令）**

```typescript
  collect
    .command('subtitle <bvid>')
    .description('采集单个视频字幕入库（扩展 fetch view+player+字幕体）')
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (bvid: string, opts: { client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = await collectSubtitle(client as CollectClient, clientId, bvid, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });
```

- [ ] **Step 6: Commit**

```bash
git add apps/collector-server/src/cli/commands/collect.ts apps/collector-server/src/cli/commands/collect.test.ts
git commit -m "feat(cli): collect subtitle <bvid>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: CLI `collect dedupe <bvid...>`（直读 SQLite 批量判重）

**Files:**
- Modify: `apps/collector-server/src/cli/commands/collect.ts`（加纯处理 + commander）
- Modify: `apps/collector-server/src/cli/commands/collect.test.ts`（加测试）

- [ ] **Step 1: 写失败测试（追加）**

```typescript
import Database from 'better-sqlite3';
import { collectDedupe } from './collect.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE videos (id INTEGER PRIMARY KEY, source TEXT, source_vid TEXT, title TEXT, first_seen_at INTEGER, UNIQUE(source, source_vid));
  `);
  return db;
}

test('collectDedupe 按视频是否在库分 collected/missing', () => {
  const db = makeDb();
  db.prepare("INSERT INTO videos (source, source_vid, title, first_seen_at) VALUES ('bilibili','BV1','t',1)").run();
  const out = collectDedupe(db, ['BV1', 'BV2', 'BV3']);
  assert.deepEqual(out.collected.sort(), ['BV1']);
  assert.deepEqual(out.missing.sort(), ['BV2', 'BV3']);
});

test('collectDedupe 空输入 → 空结果', () => {
  const db = makeDb();
  assert.deepEqual(collectDedupe(db, []), { collected: [], missing: [] });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @bilibili-ext/collector-server test`
Expected: FAIL —— `collectDedupe is not defined`。

- [ ] **Step 3: 实现纯处理**

在 `apps/collector-server/src/cli/commands/collect.ts` 顶部 import 区追加（与 [videos.ts:8-12](../../apps/collector-server/src/cli/commands/videos.ts#L8) 一致）：
```typescript
import type Database from 'better-sqlite3';
import { openReadonlyDb } from '../db.js';
```

在纯处理区追加：
```typescript
/** `collect dedupe <bvid...>`：直读 SQLite，判据=video 是否存在（无字幕视频采过后也入 videos）。 */
export function collectDedupe(
  db: Database.Database,
  bvids: string[],
): { collected: string[]; missing: string[] } {
  if (bvids.length === 0) return { collected: [], missing: [] };
  const placeholders = bvids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT source_vid FROM videos WHERE source = 'bilibili' AND source_vid IN (${placeholders})`,
  ).all(...bvids) as Array<{ source_vid: string }>;
  const set = new Set(rows.map((r) => r.source_vid));
  const collected: string[] = [];
  const missing: string[] = [];
  for (const b of bvids) (set.has(b) ? collected : missing).push(b);
  return { collected, missing };
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @bilibili-ext/collector-server test`
Expected: PASS。

- [ ] **Step 5: 装配 commander**

```typescript
  collect
    .command('dedupe <bvid...>')
    .description('批量判重：按 video 是否已入库分 collected/missing（直读 SQLite）')
    .action((bvids: string[]) => {
      const ctx = getCliContext();
      let db: Database.Database;
      try { db = openReadonlyDb(ctx.dbPath); } catch (err) { return handleHttpError(err); }
      const data = collectDedupe(db, bvids);
      emitResult(data, ctx.format);
    });
```

- [ ] **Step 6: Commit**

```bash
git add apps/collector-server/src/cli/commands/collect.ts apps/collector-server/src/cli/commands/collect.test.ts
git commit -m "feat(cli): collect dedupe <bvid...> 批量判重（直读 SQLite）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 端到端 verify 脚本 + 出站验证 + Claude skill

**Files:**
- Create: `scripts/verify-active-collect.mjs`
- Create: `.claude/skills/bili-collect/SKILL.md`

- [ ] **Step 1: 写 verify-active-collect.mjs（基于 verify-collector.mjs 模式）**

`scripts/verify-active-collect.mjs`:
```javascript
#!/usr/bin/env node
/**
 * 主动采集 P1 端到端回归（puppeteer mock，不依赖真实登录态）。
 * 覆盖：
 *   1. search action：mock WS server 下发 search → 扩展 fetch 搜索接口（puppeteer 拦截）→ 回执 {total, items}
 *   2. fetch-subtitle action：下发 → 扩展 fetch view+player+字幕体（拦截）→ ingest 上报 → 回执 {tracks, ingested}
 *   3. 无字幕视频：fetch-subtitle → ingest（tracks:[]）→ 回执 {reason:'no_subtitle'}
 *
 * ⚠️ 风险点：扩展 fetch 在 service worker 内发起，puppeteer page.setRequestInterception
 *    只拦当前 page。若 SW fetch 拦不到，回退方案：用 CDP browser-level Fetch domain，
 *    或先 navigate 打开一个 bilibili 页（让 SW 活跃）再测。实现时先验证拦截是否生效。
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..', 'apps', 'subtitle-collector', 'dist');
if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error(`[fatal] ${EXT}/manifest.json 不存在。请先 pnpm --filter @bilibili-ext/subtitle-collector build。`);
  process.exit(1);
}

const received = { ingests: [], results: [] };
const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer, path: '/ext' });
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.type === 'hello') ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
    else if (m.type === 'ingest') { received.ingests.push(m.payload); ws.send(JSON.stringify({ type: 'ingest-ack', ok: true })); }
    else if (m.type === 'result') received.results.push(m);
  });
});
await new Promise((r) => httpServer.listen(21527, '127.0.0.1', r));

// Chrome 定位（同 verify-collector.mjs）
let exec = '';
try {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(cand)) exec = cand;
} catch {}
if (!exec && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
  exec = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const browser = await puppeteer.launch({
  ...(exec ? { executablePath: exec } : {}),
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--window-size=1280,900'],
});
await new Promise((r) => setTimeout(r, 3000));
const page = await browser.newPage();

// mock B 站接口
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  const h = { 'access-control-allow-origin': '*' };
  if (u.includes('/x/web-interface/nav')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } }) });
  } else if (u.includes('/x/web-interface/wbi/search/type')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { page: { count: 1 }, result: [{ bvid: 'BVsearch', title: '搜索结果', author: 'up1', mid: 11, play: 5, duration: 60, pubdate: 1700000000 }] } }) });
  } else if (u.includes('/x/web-interface/view')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { bvid: 'BVcap', aid: 1, cid: 2, title: '采集目标', duration: 60, pubdate: 1700000000, up: { mid: 99, name: 'up主', face: 'f' }, stat: { view: 1 } } }) });
  } else if (u.includes('/x/player/wbi/v2')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-Hans', lan_doc: '简体中文', type: 2, subtitle_url: '//aisubtitle.hdslb.com/cap.json' }] } } }) });
  } else if (u.includes('aisubtitle.hdslb.com/cap.json')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ body: [{ from: 0, to: 1, content: '采集字幕样例' }] }) });
  } else { req.continue(); }
});

// 让扩展 SW 活跃：先开一个 bilibili 页
await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2000));

// 1. search
for (const c of wss.clients) c.send(JSON.stringify({ id: 't-search', action: 'search', keyword: '测试', page: 1, order: 'pubdate' }));
await new Promise((r) => setTimeout(r, 3000));
const searchRes = received.results.find((r) => r.id === 't-search');
console.log('[search]', searchRes?.ok && searchRes.data?.items?.length === 1 ? '✅ 返回候选' : '❌', searchRes);

// 2. fetch-subtitle（有字幕）
for (const c of wss.clients) c.send(JSON.stringify({ id: 't-cap', action: 'fetch-subtitle', bvid: 'BVcap' }));
await new Promise((r) => setTimeout(r, 4000));
const capRes = received.results.find((r) => r.id === 't-cap');
const capIngest = received.ingests.find((p) => p.video?.source_vid === 'BVcap');
console.log('[fetch-subtitle]', capRes?.ok && capRes.data?.tracks === 1 ? '✅ 采到 1 轨' : '❌', capRes);
console.log('[fetch-subtitle ingest]', capIngest ? '✅ 入库上报' : '❌ 未上报 ingest');

// 3. TODO 无字幕场景：mock 一个 view+player(subtitles:[]) 的 bvid，断言 ingest.tracks:[] + result.reason:'no_subtitle'
//    （实现时补：在 view/player mock 里按 bvid 分支，再加一段下发 + 断言）

await browser.close();
httpServer.close();
const ok = searchRes?.ok && capRes?.ok && capIngest;
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: 跑 verify（先 build 扩展）**

Run:
```bash
pnpm --filter @bilibili-ext/subtitle-collector build
node scripts/verify-active-collect.mjs
```
Expected: `[search] ✅`、`[fetch-subtitle] ✅`、`[fetch-subtitle ingest] ✅`，退出码 0。
> 若 SW fetch 未被 puppeteer 拦截（search/fetch-subtitle 一直 pending 或报 network error），按文件头注释的回退方案处理（CDP browser-level Fetch domain，或确保 navigate 后 SW 活跃）。

- [ ] **Step 3: 出站验证（spec A6）**

Run:
```bash
grep -rn "api.bilibili.com" apps/collector-server/src apps/subtitle-collector/src 2>/dev/null || true
grep -rn "api.bilibili.com" apps/subtitle-collector/bili-fetch.js apps/subtitle-collector/wbi.js
```
Expected: 第一条（server/CLI + popup src）**无输出**（服务端/CLI/popup 不出站）；第二条仅扩展的 `bili-fetch.js`/`wbi.js` 命中（合法，扩展内 fetch）。

- [ ] **Step 4: 写 Claude skill**

`.claude/skills/bili-collect/SKILL.md`:
```markdown
---
name: bili-collect
description: 给主题批量采集 B 站字幕并聚合。当用户说"采集/搜集 X 的字幕""帮我整理 Y 的视频资料""找一批讲 Z 的视频"时触发。
---

# B 站字幕主动采集

经 collector-cli 驱动 subtitle-collector 扩展，全自动搜 B 站 → 捞字幕 → 聚合。
全部扩展通信（扩展在浏览器内 fetch，带登录 cookie）。已采视频不重采。

## 前置检查
1. server 在线：`collector-cli server ping`。不通 → 提示用户 `collector-cli server start`。
2. 扩展在线：`collector-cli clients list`。为空 → 提示用户打开装了扩展的浏览器、确认已登录 B 站。

## 标准流程
1. **搜候选**：
   `collector-cli collect search "<主题>" --format json`
   → 取返回的 `result.data.items[].bvid`。
2. **判重**：
   `collector-cli collect dedupe <上一步的 bvid 列表 空格分隔> --format json`
   → 只对 `missing` 继续；`collected` 的直接复用库里已有。
3. **逐个采集**（串行，每个之间 sleep ~1s 防风控）：
   `collector-cli collect subtitle <BV>`
   - `result.data.reason == "no_subtitle"` → 该视频无字幕，跳过
   - `result.error == "need_login"` → 停下，通知用户登录 B 站
   - `result.error == "risk_control"` → 停下冷却，通知用户
4. **聚合**：
   `collector-cli export subtitle --format srt`（导出字幕）
   `collector-cli stats overview`（看采集概况）

## 注意
- 主题太宽（如"人工智能"）会搜出一堆；建议先用具体关键词，或按 tid 分区缩小。
- 字幕是逐字稿，不是弹幕。
```

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-active-collect.mjs .claude/skills/bili-collect/SKILL.md
git commit -m "test+feat: 主动采集 P1 端到端 verify 脚本 + Claude skill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 完工验收（对齐 spec §12 P1）

跑完全部 task 后，逐项确认：

- [ ] A1 Wbi 签名：`pnpm --filter @bilibili-ext/subtitle-collector test`（wbi.test.mjs 用固定向量断言）
- [ ] A2 collect search：`verify-active-collect.mjs` 的 `[search] ✅`
- [ ] A3 collect subtitle 有字幕：`verify-active-collect.mjs` 的 `[fetch-subtitle] ✅` + ingest 上报
- [ ] A4 无字幕：verify 脚本 Step 2 注释的 TODO 补完后断言 `reason:'no_subtitle'` + ingest.tracks:[]
- [ ] A5 collect dedupe：`collect.test.ts` 的 collectDedupe 两个 test
- [ ] A6 出站验证：Task 9 Step 3 grep 结果
- [ ] A7 CLI 退出码/format：对齐 [output.ts](../../apps/collector-server/src/cli/output.ts)（现有命令组同规范，复用 emitResult/emitError）
- [ ] A8 skill 可用：`.claude/skills/bili-collect/SKILL.md` 存在且命令名对齐 §6.4

## 测试轮次记录表（spec §13.1）

| 轮次 | 日期 | 测试内容 | 结果 | 发现的问题 / 修复 |
|---|---|---|---|---|
| （实现阶段填写） | | | | |
