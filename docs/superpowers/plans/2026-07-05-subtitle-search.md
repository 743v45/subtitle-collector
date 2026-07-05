# 字幕正文检索（`sub search` + `videos list --subtitle-q`）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 用最省 token 的方式，按「字幕里讲过什么」检索已采集视频并定位到具体片段——补齐 CLI 层漏暴露的字幕检索 + 新增片段级检索命令。

**Architecture:** 两层：(1) `videos list --subtitle-q` 透传到已有的 [VideoFilter.subtitle_q](apps/collector-server/src/db/advanced.ts#L16)（DB/HTTP 层早实现，仅 CLI 漏暴露）；(2) 新命令 `sub search`，复用 [listVideosFiltered](apps/collector-server/src/db/advanced.ts#L174) 做候选预筛 + [getVideoByDbId](apps/collector-server/src/db/advanced.ts#L219)/[getVersionPayload](apps/collector-server/src/db/queries.ts#L77) 取默认轨 payload + JS 精确匹配 [matchBody](apps/collector-server/src/cli/commands/sub.ts) 提取 ±N 秒上下文片段。子串模式靠 SQL `LIKE` 预筛加速（⊇ JS 精确，不漏召回）；正则模式**禁用** LIKE 预筛（元字符破坏 LIKE 会漏召回）。

**Tech Stack:** TypeScript + Node.js（`node:test` + `node:assert/strict`）、commander v12、better-sqlite3（只读直连）、tsx（测试/运行）。措辞：**字幕（subtitle），非弹幕（danmaku）**。

**Spec:** [docs/superpowers/specs/2026-07-05-subtitle-search-design.md](docs/superpowers/specs/2026-07-05-subtitle-search-design.md)

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/collector-server/src/cli/commands/videos.ts` | Modify | 加 `--subtitle-q` option + `VideosListOpts.subtitleQ` + 映射；顺带 export `parseNum`/`parseTime` 供 sub.ts 复用（DRY） |
| `apps/collector-server/src/cli/commands/videos.test.ts` | Modify | 补 `subtitleQ` 透传 + 命中测试（R2） |
| `apps/collector-server/src/cli/commands/sub.ts` | Create | 新命令组：纯函数 `matchBody` / `extractSnippets` / `payloadBody` / `searchSubtitles` + 类型 + `PayloadSource` 接口 + 生产 `makeDbPayloadSource` + `buildSubCommand` |
| `apps/collector-server/src/cli/commands/sub.test.ts` | Create | 纯函数 + 编排测试（注入 mock `PayloadSource`），文件头含测试轮次记录表 |
| `apps/collector-server/src/cli/main.ts` | Modify | 动态 import + `program.addCommand(buildSubCommand())` |

**任务依赖图**（并发友好）：Task 1 独立 ｜ Task 2、Task 3 互相独立 ｜ Task 4 依赖 2+3 ｜ Task 5 依赖 4 ｜ Task 6 依赖 5。

---

## Task 1: `videos list --subtitle-q`（第一层，CLI 对齐 HTTP）

**Files:**
- Modify: `apps/collector-server/src/cli/commands/videos.ts`
- Test: `apps/collector-server/src/cli/commands/videos.test.ts`

- [ ] **Step 1: 写失败测试**

在 `videos.test.ts` 末尾（`videosGetById` 测试之后）追加：

```ts
// ── videosList: subtitleQ 透传（字幕正文检索，对齐 HTTP subtitle_q）──

test('videosList: subtitleQ 透传，命中字幕正文 content 的视频', () => {
  const { db, dir } = setup();
  try {
    // 额外 ingest 一个带正文字幕的视频（setup 样本的 payload body 都是 []）
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV9', title: '通胀专题', creator: { source_uid: '9', name: '经济UP' }, extra: { stat: { view: 0 } }, duration: 100, published_at: T + 5000 },
      tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { body: [{ from: 0, to: 2, content: '今天聊通胀和CPI' }] } }] }],
    });
    // subtitleQ='通胀' 只命中 BV9（其余样本 payload 为空）
    assert.deepEqual(titles(videosList(db, { subtitleQ: '通胀' }).items), ['通胀专题']);
    // 不存在的词 → 0
    assert.equal(videosList(db, { subtitleQ: '不存在的词XYZ' }).total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/videos.test.ts`
Expected: FAIL，报 `subtitleQ` 不在 `VideosListOpts` / TypeScript 编译错（`Property 'subtitleQ' does not exist`）。

- [ ] **Step 3: 实现 `--subtitle-q` 透传**

改 `apps/collector-server/src/cli/commands/videos.ts` 三处：

(a) `VideosListOpts` 接口（约 L43-61）加字段——在 `size?: number;` 之前插一行：

```ts
  subtitleQ?: string;        // 字幕正文关键词模糊匹配（命中 subtitle_versions.payload）
  page?: number;
  size?: number;
```

(b) `ListRawOpts` 接口（约 L112-130）加字段——在 `size?: string;` 之前插：

```ts
  subtitleQ?: string;
  page?: string;
  size?: string;
```

(c) `videosList` 纯函数（约 L64-88）的 filter 映射加一行——在 `tag: opts.tag,` 之后插：

```ts
    subtitle_q: opts.subtitleQ,
```

(d) `buildVideosCommand` 的 `list` 子命令（约 L174-218）加 option + action 映射：

在 `.option('--tag <tag>', ...)` 之后插一行：

```ts
    .option('--subtitle-q <text>', '字幕正文关键词模糊匹配（命中 subtitle_versions.payload）')
```

在 action 的 `opts` 对象里（约 L197-215）的 `tag: raw.tag,` 之后插：

```ts
        subtitleQ: raw.subtitleQ,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/videos.test.ts`
Expected: PASS（全部用例，含新增的 subtitleQ 用例）。

- [ ] **Step 5: 手测 CLI option 已注册**

Run: `cd apps/collector-server && pnpm exec tsx src/cli/main.ts videos list --help | grep subtitle-q`
Expected: 输出含 `--subtitle-q <text>`。

- [ ] **Step 6: Commit**

```bash
git add apps/collector-server/src/cli/commands/videos.ts apps/collector-server/src/cli/commands/videos.test.ts
git commit -m "feat(cli): videos list 补 --subtitle-q 透传（对齐 HTTP subtitle_q）

DB/HTTP 层早有 subtitle_q（buildVideoWhere 的 LIKE EXISTS 子查询），
仅 CLI 层漏暴露。补 option + opts 字段 + filter 映射。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `matchBody` 纯函数（无 IO，可先行）

**Files:**
- Create: `apps/collector-server/src/cli/commands/sub.ts`（先建文件骨架 + matchBody）
- Test: `apps/collector-server/src/cli/commands/sub.test.ts`（先建文件头 + matchBody 测试）

- [ ] **Step 1: 建测试文件 + 写失败测试**

创建 `apps/collector-server/src/cli/commands/sub.test.ts`：

```ts
// sub.ts 纯处理函数单测：matchBody / extractSnippets / searchSubtitles。
// matchBody/extractSnippets 无 IO 直接断言；searchSubtitles 注入 mock PayloadSource + 临时 DB。
// 跑法：cd apps/collector-server && node --test --import tsx src/cli/commands/sub.test.ts
//
// 测试轮次记录表（对齐全局 CLAUDE.md §8.2 + 项目 CLAUDE.md §3）：
// | 轮次 | 日期 | 范围 | 结果 | 备注 |
// |---|---|---|---|---|
// | R3 | （待填） | matchBody / extractSnippets 纯函数 | ⏳ | |
// | R4 | （待填） | searchSubtitles 编排 + mock PayloadSource | ⏳ | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchBody, extractSnippets } from './sub.js';

// ── matchBody ──

test('matchBody: 子串默认大小写不敏感', () => {
  const body = [
    { from: 0, to: 1, content: '今天 CPI 同比上涨' },
    { from: 1, to: 2, content: '天气不错' },
  ];
  assert.deepEqual(matchBody(body, 'cpi'), [0]);   // 小写 keyword 命中大写 CPI
  assert.deepEqual(matchBody(body, 'CPI'), [0]);
  assert.deepEqual(matchBody(body, '天气'), [1]);
  assert.deepEqual(matchBody(body, '不存在'), []);
});

test('matchBody: --case-sensitive 区分大小写', () => {
  const bodyLower = [{ from: 0, to: 1, content: 'cpi' }];
  assert.deepEqual(matchBody(bodyLower, 'CPI', { caseSensitive: true }), []);  // 大写不命中纯小写
  assert.deepEqual(matchBody(bodyLower, 'CPI'), [0]);                          // 默认不敏感命中
  const bodyMixed = [{ from: 0, to: 1, content: 'CPI 与 cpi 的区别' }];
  assert.deepEqual(matchBody(bodyMixed, 'CPI', { caseSensitive: true }), [0]);
});

test('matchBody: --regex 正则匹配多段', () => {
  const body = [
    { from: 0, to: 1, content: '通胀压力' },
    { from: 1, to: 2, content: 'CPI 上涨' },
    { from: 2, to: 3, content: 'GDP 下行' },
  ];
  assert.deepEqual(matchBody(body, '通胀|CPI', { regex: true }), [0, 1]);
  assert.deepEqual(matchBody(body, 'G.P', { regex: true }), [2]);  // GDP 命中 G.P
});

test('matchBody: 非法正则抛错（供 action 层转 ARGS）', () => {
  assert.throws(() => matchBody([], '(', { regex: true }), /非法正则/);
  assert.throws(() => matchBody([], '[', { regex: true }), /非法正则/);
});

test('matchBody: 空 body → 空命中', () => {
  assert.deepEqual(matchBody([], 'x'), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/sub.test.ts`
Expected: FAIL（`Cannot find module './sub.js'` 或 matchBody 未导出）。

- [ ] **Step 3: 建 sub.ts 骨架 + matchBody 实现**

创建 `apps/collector-server/src/cli/commands/sub.ts`：

```ts
// collector-cli 字幕内容检索命令组：sub search。
// 设计参考 [字幕正文检索设计文档](docs/superpowers/specs/2026-07-05-subtitle-search-design.md)。
//
// 架构（对齐 collect.ts find 区段）：commander 薄包装 + 纯/可注入函数。
// - matchBody / extractSnippets / payloadBody：纯函数，无 IO，直接单测。
// - searchSubtitles：编排纯函数，注入 db + PayloadSource（生产 makeDbPayloadSource，测试 mock）。
// 措辞：字幕（subtitle），非弹幕。

import type Database from 'better-sqlite3';

// ── payload body 结构（对齐 subtitleFormat.ts BodyItem）──
export interface BodyItem {
  from: number;
  to: number;
  content: string;
}

// ── matchBody 选项 ──
export interface MatchOpts {
  regex?: boolean;
  caseSensitive?: boolean;
}

/**
 * 在字幕 body[].content 上做匹配，返回命中段索引数组（按原顺序）。
 * - 默认：大小写不敏感子串匹配（String.includes，对齐 SQL LIKE 语义）。
 * - regex=true：把 keyword 当 JavaScript 正则源串，加 'i' flag（除非 caseSensitive）。
 * - 非法正则抛 Error（含「非法正则」前缀，供 action 层转 ARGS 退码）。
 */
export function matchBody(body: BodyItem[], keyword: string, opts: MatchOpts = {}): number[] {
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(keyword, opts.caseSensitive ? '' : 'i');
    } catch (err) {
      throw new Error(`非法正则: ${keyword} — ${(err as Error).message}`);
    }
    const hits: number[] = [];
    body.forEach((item, i) => {
      if (re.test(item.content)) hits.push(i);
    });
    return hits;
  }
  const needle = opts.caseSensitive ? keyword : keyword.toLowerCase();
  const hits: number[] = [];
  body.forEach((item, i) => {
    const hay = opts.caseSensitive ? item.content : item.content.toLowerCase();
    if (hay.includes(needle)) hits.push(i);
  });
  return hits;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/sub.test.ts`
Expected: PASS（matchBody 全部 5 个用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/cli/commands/sub.ts apps/collector-server/src/cli/commands/sub.test.ts
git commit -m "feat(cli): sub 命令组骨架 + matchBody 纯函数（字幕正文匹配）

子串默认大小写不敏感；--regex 正则；--case-sensitive 区分大小写；
非法正则抛错供 action 层转 ARGS。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `extractSnippets` 纯函数（无 IO，可与 Task 2 并行）

**Files:**
- Modify: `apps/collector-server/src/cli/commands/sub.ts`（加 extractSnippets + payloadBody）
- Test: `apps/collector-server/src/cli/commands/sub.test.ts`（加 extractSnippets 测试）

- [ ] **Step 1: 写失败测试**

在 `sub.test.ts` 的 `matchBody` 测试块之后追加：

```ts
// ── extractSnippets ──

test('extractSnippets: ±ctxSec 上下文窗口贪心吞并邻段', () => {
  const body = [
    { from: 0, to: 2, content: 'A' },
    { from: 3, to: 5, content: 'B' },     // 命中：与前后时间差 1s
    { from: 6, to: 8, content: 'C' },
    { from: 100, to: 101, content: 'D' }, // 远离（差 95s）不吞
  ];
  const out = extractSnippets(body, [1], 10, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'B');
  assert.equal(out[0].from, 3);
  assert.equal(out[0].to, 5);
  // 向前吞 A（3-2=1<=10）；向后吞 C（6-5=1<=10）；D 不吞（100-5=95>10）
  assert.deepEqual(out[0].context, '[0-2] A [3-5] B [6-8] C');
});

test('extractSnippets: 边界——首段命中向后吞，末段命中向前吞', () => {
  const body = [
    { from: 0, to: 1, content: 'X' },
    { from: 2, to: 3, content: 'Y' },
  ];
  const head = extractSnippets(body, [0], 10, {});
  assert.deepEqual(head[0].context, '[0-1] X [2-3] Y'); // 首段向后吞 Y
  const tail = extractSnippets(body, [1], 10, {});
  assert.deepEqual(tail[0].context, '[0-1] X [2-3] Y'); // 末段向前吞 X
});

test('extractSnippets: ctxSec=0 只留命中段本身', () => {
  const body = [
    { from: 0, to: 1, content: 'X' },
    { from: 2, to: 3, content: 'Y' },
    { from: 4, to: 5, content: 'Z' },
  ];
  const out = extractSnippets(body, [1], 0, {});
  assert.deepEqual(out[0].context, '[2-3] Y');
});

test('extractSnippets: --plain 去时间戳前缀只留纯文本', () => {
  const body = [
    { from: 0, to: 1, content: 'X' },
    { from: 2, to: 3, content: 'Y' },
  ];
  const out = extractSnippets(body, [0], 10, { plain: true });
  assert.deepEqual(out[0].context, 'XY');
});

test('extractSnippets: maxPerVideo 截断（按命中顺序取前 N）', () => {
  const body = [0, 1, 2, 3, 4].map((i) => ({ from: i * 100, to: i * 100 + 1, content: `hit${i}` }));
  const out = extractSnippets(body, [0, 1, 2, 3, 4], 0, { maxPerVideo: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.content), ['hit0', 'hit1']);
});

test('extractSnippets: 多命中点各自独立产出片段', () => {
  const body = [
    { from: 0, to: 1, content: 'A' },
    { from: 100, to: 101, content: 'B' },  // 命中（远离 A）
    { from: 200, to: 201, content: 'A' },  // 命中（远离 B）
  ];
  const out = extractSnippets(body, [1, 2], 10, {});
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'B');
  assert.equal(out[1].content, 'A');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/sub.test.ts`
Expected: FAIL（`extractSnippets` 未导出）。

- [ ] **Step 3: 实现 extractSnippets + payloadBody**

在 `sub.ts` 的 `matchBody` 之后追加：

```ts
// ── 片段（命中点 + 上下文）──
export interface Snippet {
  from: number;       // 命中段起始秒
  to: number;         // 命中段结束秒
  content: string;    // 命中段原文
  context: string;    // ±ctxSec 邻段拼接；默认 "[from-to] content" 空格连接，plain=true 去前缀
}

export interface ExtractOpts {
  plain?: boolean;
  maxPerVideo?: number;
}

/**
 * 对每个命中索引产出片段：从命中段向前后贪心吞并「时间差 <= ctxSec」的邻段，
 * 拼成 context。时间差定义：向前 = center.from - body[lo-1].to；向后 = body[hi+1].from - center.to。
 * - plain=true：context 只留纯文本（邻段 content 直接拼接）。
 * - maxPerVideo：按命中顺序取前 N（默认不限）。
 */
export function extractSnippets(
  body: BodyItem[],
  hitIndices: number[],
  ctxSec: number,
  opts: ExtractOpts = {},
): Snippet[] {
  const max = opts.maxPerVideo ?? Number.MAX_SAFE_INTEGER;
  return hitIndices.slice(0, max).map((idx) => {
    const center = body[idx];
    let lo = idx;
    while (lo > 0 && center.from - body[lo - 1].to <= ctxSec) lo--;
    let hi = idx;
    while (hi < body.length - 1 && body[hi + 1].from - center.to <= ctxSec) hi++;
    const segs = body.slice(lo, hi + 1);
    const context = opts.plain
      ? segs.map((s) => s.content).join('')
      : segs.map((s) => `[${s.from}-${s.to}] ${s.content}`).join(' ');
    return { from: center.from, to: center.to, content: center.content, context };
  });
}

/**
 * 从 payload（B 站字幕 JSON 对象）校验并提取 body 数组。
 * 结构不符（非对象/缺 body/body 非数组/条目缺字段）→ 返回 null（调用方跳过该视频，不崩）。
 * 校验逻辑镜像 subtitleFormat.ts 的 extractBody，但返回 null 而非抛错（检索场景容错优先）。
 */
export function payloadBody(payload: unknown): BodyItem[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = (payload as { body?: unknown }).body;
  if (!Array.isArray(body)) return null;
  const items: BodyItem[] = [];
  for (const raw of body) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { from, to, content } = raw as Record<string, unknown>;
    if (typeof from !== 'number' || typeof to !== 'number' || typeof content !== 'string') return null;
    items.push({ from, to, content });
  }
  return items;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/sub.test.ts`
Expected: PASS（matchBody + extractSnippets 全部用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/cli/commands/sub.ts apps/collector-server/src/cli/commands/sub.test.ts
git commit -m "feat(cli): extractSnippets + payloadBody 纯函数（上下文片段提取）

extractSnippets 按时间窗贪心吞并邻段产出 context；--plain 去时间戳；
maxPerVideo 截断。payloadBody 容错提取 body（异常返回 null）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `searchSubtitles` 编排 + `PayloadSource`（依赖 Task 2+3）

**Files:**
- Modify: `apps/collector-server/src/cli/commands/sub.ts`（加类型 + PayloadSource + makeDbPayloadSource + searchSubtitles）
- Test: `apps/collector-server/src/cli/commands/sub.test.ts`（加编排测试）

- [ ] **Step 1: 写失败测试**

在 `sub.test.ts` 顶部 import 区改为（加 searchSubtitles / makeDbPayloadSource / 类型 + 复用 setup 模式）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { matchBody, extractSnippets, searchSubtitles, makeDbPayloadSource, type PayloadSource, type PayloadEntry } from './sub.js';
```

在文件末尾追加（编排测试块）：

```ts
// ── searchSubtitles（注入 mock PayloadSource + 临时 DB）──
// 临时库 setup：2 视频，BV1 字幕含「通胀」，BV2 字幕含「天气」。payload body 非空。
const T2 = 1_700_000_000_000;
function setupSub(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-sub-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '通胀解读', creator: { source_uid: '1', name: 'UP1' }, extra: { stat: { view: 100 } }, duration: 200, published_at: T2 + 1000 },
    tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { body: [
      { from: 0, to: 2, content: '开场白' },
      { from: 3, to: 5, content: '今天聊通胀成因' },
      { from: 100, to: 101, content: '通胀的对策' },
    ] } } }] }],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV2', title: '天气播报', creator: { source_uid: '2', name: 'UP2' }, extra: { stat: { view: 50 } }, duration: 60, published_at: T2 + 2000 },
    tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { body: [
      { from: 0, to: 2, content: '今天天气晴朗' },
    ] } } }] }],
  });
  // 覆写 first_seen_at 为确定值
  db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(T2 + 100, 'BV1');
  db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(T2 + 200, 'BV2');
  return { db, dir };
}

// mock PayloadSource：按 videoId 返回预设 payload 列表（绕过 getVideoByDbId 的默认轨逻辑，独立验证编排）
function mockSource(map: Record<number, PayloadEntry[]>): PayloadSource {
  return { getPayloads: (vid: number) => map[vid] ?? [] };
}

test('searchSubtitles: 子串模式命中 + 片段时间戳 + matched_videos/total_snippets', () => {
  const { db, dir } = setupSub();
  try {
    const src = makeDbPayloadSource(db); // 走真实默认轨路径
    const out = searchSubtitles(db, src, { keyword: '通胀' });
    assert.equal(out.keyword, '通胀');
    assert.equal(out.regex, false);
    assert.equal(out.matched_videos, 1);       // 只 BV1
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].video.source_vid, 'BV1');
    assert.equal(out.items[0].video.title, '通胀解读');
    assert.equal('pic' in out.items[0].video, false);  // 强制不含 pic（媒体字段剔除）
    assert.equal(out.items[0].snippets.length, 2);      // 第 2、3 段命中
    assert.ok(out.items[0].snippets[0].context.includes('通胀'));
    assert.ok(out.total_snippets >= 1);
    assert.equal(out.truncated, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: F9a 子串模式 LIKE 预筛 ⊇ JS 精确（LIKE 噪声被 JS 滤掉，不漏召回）', () => {
  // BV1 字幕 body 不含字面「137」，但 payload JSON 含 "from":137 → LIKE '%137%' 命中。
  // 进 source 后 JS matchBody 在 content 里找不到「137」→ 该视频被滤掉，不进结果（消噪声）。
  const dir = mkdtempSync(join(tmpdir(), 'cli-sub-noise-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVn', title: '噪声视频', creator: { source_uid: '9', name: 'UP9' }, extra: {}, duration: 200, published_at: T2 },
      tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { body: [
        { from: 137, to: 138, content: '这段内容完全不含数字关键词' },
      ] } } }] }],
    });
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '137' });
    assert.equal(out.matched_videos, 0);  // LIKE 命中但 JS 滤掉 → 0
    assert.deepEqual(out.items, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: F9b 正则模式不加 LIKE 预筛（否则元字符致漏召回）', () => {
  // BV1 content='通胀'，但 LIKE '%通胀|CPI%' 不命中（| 是 LIKE 字面量）。
  // 正则模式必须不靠 LIKE 预筛，否则 BV1 被候选池过滤空 → 漏。
  const { db, dir } = setupSub();
  try {
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀|对策', regex: true });
    assert.equal(out.matched_videos, 1);          // BV1 仍命中（正则 /通胀|对策/ 命中其 content）
    assert.equal(out.items[0].video.source_vid, 'BV1');
    assert.ok(out.items[0].snippets.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: --max-snippets 全局截断 + truncated=true', () => {
  const { db, dir } = setupSub();
  try {
    // BV1 命中 2 片段；maxSnippets=1 → 只取 1，标记 truncated
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀', maxSnippets: 1 });
    assert.equal(out.total_snippets, 1);
    assert.equal(out.truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: --max-snippets-per-video 单视频截断', () => {
  const { db, dir } = setupSub();
  try {
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀', maxSnippetsPerVideo: 1 });
    assert.equal(out.items[0].snippets.length, 1);  // BV1 有 2 命中，截到 1
    assert.equal(out.total_snippets, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: --plain 片段去时间戳', () => {
  const { db, dir } = setupSub();
  try {
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀', plain: true });
    assert.equal(out.items[0].snippets[0].context.includes('['), false);  // 无时间戳前缀
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: 视频预筛 videoFilter（tname/view 叠加）', () => {
  const { db, dir } = setupSub();
  try {
    // BV1 view=100, BV2 view=50；minView=80 只留 BV1
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀', videoFilter: { min_view: 80 } });
    assert.equal(out.matched_videos, 1);
    assert.equal(out.items[0].video.source_vid, 'BV1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: F12 无字幕 / payload 结构异常 → 该视频跳过不崩（mock source）', () => {
  const { db, dir } = setupSub();
  try {
    // BV1 注入异常 payload（body 不是数组）+ BV2 正常；mock source 覆盖 BV1
    const v1Id = (db.prepare('SELECT id FROM videos WHERE source_vid=?').get('BV1') as { id: number }).id;
    const v2Id = (db.prepare('SELECT id FROM videos WHERE source_vid=?').get('BV2') as { id: number }).id;
    const src: PayloadSource = {
      getPayloads: (vid: number) => {
        if (vid === v1Id) return [{ track: { id: 1, lan: 'zh', track_type: 1 }, version: { id: 1, origin: 'asr' }, payload: { body: '不是数组' } }];
        if (vid === v2Id) return [{ track: { id: 2, lan: 'zh', track_type: 1 }, version: { id: 2, origin: 'asr' }, payload: { body: [{ from: 0, to: 1, content: '通胀' }] } }];
        return [];
      },
    };
    // 子串模式 '通胀'：BV1 payload 异常被 payloadBody 滤掉；BV2 命中
    // 注意：LIKE 预筛会先在 DB 层过滤（BV1/BV2 的真实 payload 都 LIKE 命中「通胀」），两视频都进候选
    const out = searchSubtitles(db, src, { keyword: '通胀' });
    assert.equal(out.matched_videos, 1);
    assert.equal(out.items[0].video.source_vid, 'BV2');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: --full 回整条字幕文本', () => {
  const { db, dir } = setupSub();
  try {
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀', full: true });
    assert.equal(typeof out.items[0].full, 'string');
    assert.ok((out.items[0].full ?? '').includes('通胀'));
    assert.ok((out.items[0].full ?? '').includes('开场白'));  // txt 拼接全部 content
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/sub.test.ts`
Expected: FAIL（`searchSubtitles` / `makeDbPayloadSource` 未导出）。

- [ ] **Step 3: 实现 searchSubtitles + PayloadSource + makeDbPayloadSource**

在 `sub.ts` 顶部 import 区（`import type Database` 之后）补充：

```ts
import { listVideosFiltered, getVideoByDbId, type VideoFilter, type ListFilter, type VideoListItemAdvanced } from '../../db/advanced.js';
import { getVersionPayload } from '../../db/queries.js';
import { convertSubtitle, type SubtitleFormat } from '../subtitleFormat.js';
```

在 `payloadBody` 之后追加：

```ts
// ── PayloadSource：默认轨/版本 payload 来源抽象（生产 makeDbPayloadSource，测试 mock）──
export interface TrackInfo { id: number; lan: string | null; track_type: number | null; }
export interface VersionInfo { id: number; origin: string; }
export interface PayloadEntry { track: TrackInfo; version: VersionInfo; payload: unknown; }

export interface PayloadSource {
  /** 给定视频 id，返回其默认轨（allTracks=true 时全部轨）各自默认版本的 payload 列表，按轨优先级排序。 */
  getPayloads(videoId: number, allTracks: boolean): PayloadEntry[];
}

/**
 * 生产实现：复用 getVideoByDbId（已按 trackPriority/versionPriority 排序、标 is_default）+
 * getVersionPayload 取 payload。getVideoByDbId 不返回 payload，故再按 version id 单取。
 */
export function makeDbPayloadSource(db: Database.Database): PayloadSource {
  return {
    getPayloads(videoId: number, allTracks: boolean): PayloadEntry[] {
      const detail = getVideoByDbId(db, videoId);
      if (!detail) return [];
      const targetTracks = allTracks
        ? detail.tracks
        : detail.tracks.filter((t) => (t as { is_default?: boolean }).is_default);
      const out: PayloadEntry[] = [];
      for (const t of targetTracks) {
        const defaultVer = t.versions.find((v) => (v as { is_default?: boolean }).is_default) ?? t.versions[0];
        if (!defaultVer) continue;
        const pv = getVersionPayload(db, defaultVer.id);
        if (!pv) continue;
        out.push({
          track: { id: t.id, lan: t.lan, track_type: t.track_type },
          version: { id: pv.id, origin: pv.origin },
          payload: pv.payload,
        });
      }
      return out;
    },
  };
}

// ── searchSubtitles 结果形状（对齐 spec §4）──
export interface SubtitleSnippet extends Snippet {}

export interface SubtitleSearchItem {
  // video 元信息：刻意不含 pic / 封面 / 视频链接等媒体字段（AI 看不了且占 token —— 用户明确要求剔除）
  video: { id: number; source: string; source_vid: string; title: string;
           creator_name: string | null; duration: number | null; published_at: number | null };
  track: TrackInfo;
  version: VersionInfo;
  snippets: SubtitleSnippet[];
  full?: string;
}

export interface SubtitleSearchResult {
  keyword: string;
  regex: boolean;
  matched_videos: number;
  total_snippets: number;
  truncated: boolean;
  items: SubtitleSearchItem[];
}

export interface SearchSubtitlesOpts {
  keyword: string;
  regex?: boolean;
  caseSensitive?: boolean;
  ctxSec?: number;                 // 默认 10
  maxSnippetsPerVideo?: number;    // 默认 3
  maxSnippets?: number;            // 默认 30
  maxVideos?: number;              // 默认 100
  allTracks?: boolean;
  plain?: boolean;
  full?: boolean;
  fullFormat?: SubtitleFormat;     // 默认 'txt'
  videoFilter?: VideoFilter;       // 视频预筛（复用，不含 subtitle_q）
}

/**
 * 字幕正文检索编排：
 * ① 候选池 = listVideosFiltered(videoFilter + size=maxVideos)；子串模式额外带 subtitle_q=keyword 做 LIKE 预筛加速；
 *    正则模式**禁用** subtitle_q 预筛（元字符破坏 LIKE 召回，见 spec §3）。
 * ② 每候选 source.getPayloads → payloadBody 校验 → matchBody 精确匹配（消 LIKE 噪声）；
 *    取第一个有命中的 payload 作为该视频代表（默认轨优先），产出片段。
 * ③ 跨视频累计 maxSnippets 截断，标记 truncated。
 */
export function searchSubtitles(
  db: Database.Database,
  source: PayloadSource,
  opts: SearchSubtitlesOpts,
): SubtitleSearchResult {
  const keyword = opts.keyword;
  const regex = !!opts.regex;
  const ctxSec = opts.ctxSec ?? 10;
  const maxPerVideo = opts.maxSnippetsPerVideo ?? 3;
  const maxSnippets = opts.maxSnippets ?? 30;
  const maxVideos = opts.maxVideos ?? 100;

  // ① 候选池
  const filter: ListFilter = { ...(opts.videoFilter ?? {}), size: maxVideos };
  if (!regex && keyword) {
    filter.subtitle_q = keyword;  // 子串模式 LIKE 预筛（⊇ JS 精确，不漏召回）
  }
  const candidates: VideoListItemAdvanced[] = listVideosFiltered(db, filter).items;

  // ②③ 逐候选匹配 + 累计截断
  const items: SubtitleSearchItem[] = [];
  let totalSnippets = 0;
  let truncated = false;

  for (const v of candidates) {
    if (totalSnippets >= maxSnippets) { truncated = true; break; }
    const payloads = source.getPayloads(v.id, !!opts.allTracks);
    let chosen: { track: TrackInfo; version: VersionInfo; snippets: SubtitleSnippet[]; payload: unknown } | null = null;
    for (const pe of payloads) {
      const body = payloadBody(pe.payload);
      if (!body) continue;  // 结构异常跳过
      const hits = matchBody(body, keyword, { regex, caseSensitive: opts.caseSensitive });
      if (hits.length === 0) continue;  // LIKE 噪声在此被 JS 滤掉
      const snippets = extractSnippets(body, hits, ctxSec, { plain: opts.plain, maxPerVideo });
      if (snippets.length === 0) continue;
      chosen = { track: pe.track, version: pe.version, snippets, payload: pe.payload };
      break;  // 取第一个命中 payload（默认轨优先）
    }
    if (!chosen) continue;

    // 全局配额截断
    const remaining = maxSnippets - totalSnippets;
    if (chosen.snippets.length > remaining) {
      chosen.snippets = chosen.snippets.slice(0, remaining);
      truncated = true;
    }
    totalSnippets += chosen.snippets.length;

    const item: SubtitleSearchItem = {
      video: {
        id: v.id, source: v.source, source_vid: v.source_vid, title: v.title,
        creator_name: (v as { creator_name: string | null }).creator_name,
        duration: v.duration, published_at: v.published_at,
      },
      track: chosen.track,
      version: chosen.version,
      snippets: chosen.snippets,
    };
    if (opts.full) {
      try {
        item.full = convertSubtitle(chosen.payload, opts.fullFormat ?? 'txt');
      } catch {
        // payload 结构异常（理论上 payloadBody 已挡，兜底）：full 省略
      }
    }
    items.push(item);
  }

  return {
    keyword,
    regex,
    matched_videos: items.length,
    total_snippets: totalSnippets,
    truncated,
    items,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/sub.test.ts`
Expected: PASS（matchBody + extractSnippets + searchSubtitles 全部用例，含 F9a/F9b/F12）。

- [ ] **Step 5: 全量回归**

Run: `pnpm -C apps/collector-server test`
Expected: PASS（确认新测试不破坏既有 commands/*.test.ts）。

- [ ] **Step 6: Commit**

```bash
git add apps/collector-server/src/cli/commands/sub.ts apps/collector-server/src/cli/commands/sub.test.ts
git commit -m "feat(cli): searchSubtitles 编排 + PayloadSource（片段级字幕检索）

候选池子串模式带 LIKE 预筛加速（⊇ JS 精确，不漏召回）；正则模式禁用预筛
（元字符破坏 LIKE 会漏召回，F9b 回归）。每视频取默认轨首个命中 payload，
产出 ±ctxSec 上下文片段，跨视频累计 maxSnippets 截断。--full 回整条。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `buildSubCommand` CLI 装配 + 注册（依赖 Task 4）

**Files:**
- Modify: `apps/collector-server/src/cli/commands/videos.ts`（export `parseNum`/`parseTime` 复用）
- Modify: `apps/collector-server/src/cli/commands/sub.ts`（加 buildSubCommand）
- Modify: `apps/collector-server/src/cli/main.ts`（注册）
- Test: 手测 `--help` + 参数校验

- [ ] **Step 1: export videos.ts 的 parseNum/parseTime（DRY 复用）**

改 `apps/collector-server/src/cli/commands/videos.ts`：

(a) `parseNum` 函数签名（约 L133）`function parseNum(` → `export function parseNum(`

(b) `parseTime` 函数签名（约 L152）`function parseTime(` → `export function parseTime(`

> `parseSort` 不 export（sub 用不到 VideoSortKey）。`normalizeTimestamp` 早已 export。

- [ ] **Step 2: 在 sub.ts 加 buildSubCommand**

在 `sub.ts` 顶部 import 区追加：

```ts
import { Command } from 'commander';
import { getCliContext } from '../main.js';
import { emitResult, emitError } from '../output.js';
import { openReadonlyDb } from '../db.js';
import { normalizeTimestamp, parseNum, parseTime } from './videos.js';
```

在文件末尾追加：

```ts
// ── commander 装配 ──

interface SubSearchRawOpts {
  regex?: boolean;
  caseSensitive?: boolean;
  ctx?: string;
  maxSnippetsPerVideo?: string;
  maxSnippets?: string;
  maxVideos?: string;
  allTracks?: boolean;
  plain?: boolean;
  full?: boolean;
  fullFormat?: string;
  // 视频预筛（复用 videos list 口径）
  creator?: string;
  source?: string;
  tid?: string;
  tname?: string;
  tag?: string;
  lang?: string;
  trackType?: string;
  hasSubtitle?: boolean;
  since?: string;
  until?: string;
  minView?: string;
  maxView?: string;
  minDuration?: string;
  maxDuration?: string;
}

const FULL_FORMATS = ['txt', 'srt', 'vtt', 'json'] as const;

function openDbOrEmit(dbPath: string): Database.Database {
  try {
    return openReadonlyDb(dbPath);
  } catch (err) {
    return emitError((err as Error).message, 'DB_UNREADABLE');
  }
}

export function buildSubCommand(): Command {
  const sub = new Command('sub')
    .description('字幕内容检索（直连 SQLite 只读）：search');

  sub
    .command('search <keyword>')
    .description('按字幕正文关键词检索，返回命中视频 + 时间戳 ±ctx 秒上下文片段（默认不回全文）')
    .option('--regex', '把 <keyword> 当 JavaScript 正则源串匹配')
    .option('--case-sensitive', '区分大小写（默认不区分，对齐 SQL LIKE）')
    .option('--ctx <秒>', '每个命中点的上下文时间窗（默认 10）')
    .option('--max-snippets-per-video <n>', '单视频最多片段数（默认 3）')
    .option('--max-snippets <n>', '全局片段总数上限（默认 30）')
    .option('--max-videos <n>', '候选视频上限（默认 100）')
    .option('--all-tracks', '搜所有字幕轨（默认只搜默认轨：CC中文>AI中文>英文>其他）')
    .option('--plain', '片段去时间戳前缀只留纯文本（from/to 始终保留）')
    .option('--full', '回整条字幕（配合 --full-format，默认 txt）')
    .option('--full-format <fmt>', '整条字幕格式：txt|srt|vtt|json（默认 txt）')
    .option('--creator <name>', 'UP 名模糊匹配（视频预筛）')
    .option('--source <src>', '视频来源精确（如 bilibili）')
    .option('--tid <id>', '分区 tid 精确（视频预筛）')
    .option('--tname <name>', '分区名模糊匹配（视频预筛）')
    .option('--tag <tag>', '标签名模糊匹配（视频预筛）')
    .option('--lang <lang>', '字幕语言模糊匹配（视频预筛，如 zh）')
    .option('--track-type <type>', '字幕轨类型 1=AI 2=CC（视频预筛）')
    .option('--has-subtitle', '仅含字幕的视频（视频预筛）')
    .option('--since <ts>', '起始时间（视频预筛，Unix 秒/毫秒 或 ISO8601）')
    .option('--until <ts>', '结束时间（视频预筛）')
    .option('--min-view <n>', '最小播放量（视频预筛）')
    .option('--max-view <n>', '最大播放量（视频预筛）')
    .option('--min-duration <s>', '最小时长秒（视频预筛）')
    .option('--max-duration <s>', '最大时长秒（视频预筛）')
    .action((keyword: string, raw: SubSearchRawOpts) => {
      if (!keyword || keyword.length === 0) {
        return emitError('<keyword> 不能为空', 'ARGS');
      }
      const ctx = parseNum(raw.ctx, '--ctx');
      if (ctx !== undefined && ctx <= 0) {
        return emitError('--ctx 必须为正数', 'ARGS');
      }
      const maxSnippets = parseNum(raw.maxSnippets, '--max-snippets');
      if (maxSnippets !== undefined && maxSnippets <= 0) {
        return emitError('--max-snippets 必须为正数', 'ARGS');
      }
      const maxSnippetsPerVideo = parseNum(raw.maxSnippetsPerVideo, '--max-snippets-per-video');
      if (maxSnippetsPerVideo !== undefined && maxSnippetsPerVideo <= 0) {
        return emitError('--max-snippets-per-video 必须为正数', 'ARGS');
      }
      const maxVideos = parseNum(raw.maxVideos, '--max-videos');
      if (maxVideos !== undefined && maxVideos <= 0) {
        return emitError('--max-videos 必须为正数', 'ARGS');
      }
      let fullFormat: SubtitleFormat | undefined;
      if (raw.fullFormat !== undefined && !(FULL_FORMATS as readonly string[]).includes(raw.fullFormat)) {
        return emitError(`非法 --full-format: ${raw.fullFormat}（可选: ${FULL_FORMATS.join('|')}）`, 'ARGS');
      }
      fullFormat = raw.fullFormat as SubtitleFormat | undefined;

      // 视频预筛 filter（复用 VideoFilter 子集，不含 subtitle_q）
      const videoFilter: VideoFilter = {
        creator: raw.creator,
        source: raw.source,
        tid: parseNum(raw.tid, '--tid'),
        tname: raw.tname,
        tag: raw.tag,
        lang: raw.lang,
        track_type: parseNum(raw.trackType, '--track-type'),
        has_subtitle: raw.hasSubtitle,
        since: parseTime(raw.since, '--since'),
        until: parseTime(raw.until, '--until'),
        min_view: parseNum(raw.minView, '--min-view'),
        max_view: parseNum(raw.maxView, '--max-view'),
        min_duration: parseNum(raw.minDuration, '--min-duration'),
        max_duration: parseNum(raw.maxDuration, '--max-duration'),
      };

      // 正则模式：matchBody 在 searchSubtitles 内部对非法正则抛错；这里兜底转 ARGS
      try {
        const ctxCfg = getCliContext();
        const db = openDbOrEmit(ctxCfg.dbPath);
        const data = searchSubtitles(db, makeDbPayloadSource(db), {
          keyword,
          regex: raw.regex,
          caseSensitive: raw.caseSensitive,
          ctxSec: ctx,
          maxSnippets,
          maxSnippetsPerVideo,
          maxVideos,
          allTracks: raw.allTracks,
          plain: raw.plain,
          full: raw.full,
          fullFormat,
          videoFilter,
        });
        emitResult(data, ctxCfg.format);
      } catch (err) {
        const msg = (err as Error).message;
        if (/非法正则/.test(msg)) {
          return emitError(msg, 'ARGS');
        }
        return emitError(msg, 'RUNTIME');
      }
    });

  return sub;
}
```

- [ ] **Step 3: 注册到 main.ts**

改 `apps/collector-server/src/cli/main.ts`：

(a) `main()` 内的解构 import 数组（约 L84-102）加一项——在 `{ buildCollectCommand },` 之后插：

```ts
      { buildSubCommand },
```

并在对应 `Promise.all` 数组（约 L93-102）末尾（`import('./commands/collect.js'),` 之后）插：

```ts
      import('./commands/sub.js'),
```

(b) `addCommand` 区（约 L103-110）末尾（`program.addCommand(buildCollectCommand());` 之后）插：

```ts
    program.addCommand(buildSubCommand());   // sub search（字幕正文片段检索）
```

- [ ] **Step 4: 手测命令注册 + 参数校验**

Run: `cd apps/collector-server && pnpm exec tsx src/cli/main.ts sub search --help`
Expected: 输出含 `Usage: collector-cli sub search [options] <keyword>` 及全部 option 列表。

Run: `cd apps/collector-server && pnpm exec tsx src/cli/main.ts sub search "" --format json; echo "exit=$?"`
Expected: stdout 含 `{"ok":false,"error":"<keyword> 不能为空"...}`，`exit=2`（ARGS）。

Run: `cd apps/collector-server && pnpm exec tsx src/cli/main.ts sub search x --ctx 0 --format json; echo "exit=$?"`
Expected: `--ctx 必须为正数`，`exit=2`。

Run: `cd apps/collector-server && pnpm exec tsx src/cli/main.ts sub search x --regex --max-snippets -1 --format json; echo "exit=$?"`
Expected: `--max-snippets 必须为正数`，`exit=2`。

- [ ] **Step 5: 全量回归**

Run: `pnpm -C apps/collector-server test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/collector-server/src/cli/commands/videos.ts apps/collector-server/src/cli/commands/sub.ts apps/collector-server/src/cli/main.ts
git commit -m "feat(cli): sub search 命令装配 + 注册（字幕正文片段检索入口）

复用 videos.ts 的 parseNum/parseTime（DRY export）；参数校验空 keyword /
ctx<=0 / max-*<=0 / 非法 full-format → ARGS；正则非法转 ARGS。注册到 main.ts。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: E2E 真实数据 + 省 token 对照 + 文档/验收同步

**Files:**
- Verify: 真实库 `apps/collector-server/bilibili-collector.db`
- Update: `docs/superpowers/specs/2026-07-05-subtitle-search-design.md`（验收清单 + 测试轮次记录表）

- [ ] **Step 1: 真实库 E2E——视频级（videos list --subtitle-q）**

Run: `cd apps/collector-server && pnpm exec tsx src/cli/main.ts videos list --subtitle-q 通胀 --format ndjson | head -5`
Expected: 输出若干命中视频的 ndjson 行（每行一个 JSON 对象，含 `source_vid`/`title`/`creator_name`，**不含** payload）。

> 若返回空：换一个真实库大概率有的关键词重试（如 `的`/`我们`/`今天`）。记录命中的关键词与命中数到验收表 F17。

- [ ] **Step 2: 真实库 E2E——片段级（sub search）**

Run: `cd apps/collector-server && pnpm exec tsx src/cli/main.ts sub search "通胀" --max-snippets 5 --format ndjson`
Expected: 输出若干 `SubtitleSearchItem` 的 ndjson 行，每行含 `video{source_vid,title,creator_name,...}`（**无 pic**）、`track`、`version{id,origin}`、`snippets[{from,to,content,context}]`。`context` 形如 `[0-2] 开场白 [3-5] ...通胀...`。

Run（省 token 极致姿势）: `cd apps/collector-server && pnpm exec tsx src/cli/main.ts sub search "通胀" --plain --max-snippets 5 --format ndjson`
Expected: 同上但 `context` 无 `[x-y]` 时间戳前缀，纯文本。

- [ ] **Step 3: 省 token 对照（F18）**

Run（片段模式，统计字符数）:
```bash
cd apps/collector-server
pnpm exec tsx src/cli/main.ts sub search "通胀" --plain --max-snippets 5 --format ndjson | wc -c
```

Run（对照——整条字幕 JSON，取一个上一步命中的 version id）:
```bash
pnpm exec tsx src/cli/main.ts versions get <versionId> --format json | wc -c
```

记录两者字符数到验收表 F18，确认片段模式显著小于整条（预期 1-2 个数量级）。

- [ ] **Step 4: 正则模式 E2E**

Run: `cd apps/collector-server && pnpm exec tsx src/cli/main.ts sub search "通胀|CPI" --regex --max-snippets 5 --format ndjson | head -3`
Expected: 返回非空结果（验证正则模式不漏召回——若错误地带 LIKE 预筛，此处会空）。

- [ ] **Step 5: 更新 spec 验收清单 + 测试轮次记录表**

编辑 `docs/superpowers/specs/2026-07-05-subtitle-search-design.md`：

(a) §7.1 验收清单：把 F1-F17 已通过项的 `⏳` 改为 `✅` 并补「对应测试/命令」实测结果（F18 填字符数对照）。

(b) §7.2 测试轮次记录表：把 R2-R6 的「（待填）」日期改为 `2026-07-05`，「结果」列填 PASS + 关键数据（如 R6 填命中的真实关键词与片段数、F18 的字符数对照）。

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-07-05-subtitle-search-design.md
git commit -m "docs(spec): 字幕正文检索验收清单与测试轮次记录同步（F1-F18 实测通过）

E2E 真实库 sub search / videos list --subtitle-q 跑通；省 token 对照
（片段 vs 整条）记录到 F18。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review（plan 作者自查，已完成）

**1. Spec coverage**：
- §2.1 `videos list --subtitle-q` → Task 1 ✓
- §2.2 `sub search` 全部 options → Task 5 buildSubCommand ✓（regex/case-sensitive/ctx/max-snippets/max-snippets-per-video/max-videos/all-tracks/full/full-format/plain + 视频预筛全覆盖）
- §3 流程①-⑤ → Task 4 searchSubtitles（①候选+预筛、②getPayloads、③matchBody、④extractSnippets、⑤累计截断）✓
- §4 纯函数 matchBody/extractSnippets/searchSubtitles + PayloadSource → Task 2/3/4 ✓
- §4 数据形状 SubtitleSearchItem（无 pic）→ Task 4 类型定义 + Task 4 测试断言 `'pic' in video === false` ✓
- §5 省 token 策略（不回全文/双截断/ctx/--plain/默认轨/ndjson/剔除媒体）→ Task 4/5 实现 + Task 6 对照 ✓
- §6 已知局限 F9b（正则不预筛）→ Task 4 专项测试 ✓
- §7 验收 F1-F18 → Task 1/2/3/4/6 覆盖（F15 参数校验在 Task 5，F16 format 在 Task 5/6，F17/F18 在 Task 6）✓
- §8 实现拆分 → Task 1-6 一一对应 ✓

**2. Placeholder scan**：无 TBD/TODO；每个 step 含完整代码或确切命令 + 预期输出。✓

**3. Type consistency**：
- `BodyItem`（Task 2 定义）→ matchBody/extractSnippets/payloadBody/searchSubtitles 一致用 ✓
- `PayloadEntry`（Task 4 定义）→ mockSource 测试 + makeDbPayloadSource 一致 ✓
- `SubtitleSearchItem.video` 字段与 `VideoListItemAdvanced`（id/source/source_vid/title/creator_name/duration/published_at）对齐 ✓
- `parseNum`/`parseTime` Task 5 export 后 sub.ts import 复用，签名一致 ✓
- `convertSubtitle(payload, format)` 签名与 subtitleFormat.ts:111 一致 ✓

（发现并修正：Task 4 初稿 `chosen` 未保留 payload 导致 `--full` 无法转文本——已在最终版给 `chosen` 加 `payload` 字段并在 full 分支用 `convertSubtitle(chosen.payload, ...)`。）
