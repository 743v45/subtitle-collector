# export bundle 原料包导出 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI 新增 `export bundle`：按过滤条件批量导出分析原料包（manifest.json + videos/*.txt + ANALYZE.md），打通消费端第一块。

**Architecture:** 复用 `videosList`（选视频集）与 `resolveSubtitle`（默认轨解析，扩展返回轨信息），新增 `cli/bundle.ts` 纯函数层（`buildBundle` 组装 manifest + 文件列表，不落盘），commander 装配在现有 `buildExportCommand()` 内。分析在 Claude Code 会话做，系统零 AI 集成。

**Tech Stack:** TypeScript ESM、better-sqlite3（只读）、commander、node:test + tsx。

**Spec:** [docs/superpowers/specs/2026-08-19-export-bundle-design.md](../specs/2026-08-19-export-bundle-design.md)

## Global Constraints

- 措辞红线：**字幕（subtitle）**，代码/注释/文案严禁出现"弹幕/danmaku"。
- CLI 永不写库：一律 `openReadonlyDb`（[cli/db.ts](../../apps/collector-server/src/cli/db.ts)）。
- 测试跑法：`cd apps/collector-server && pnpm test`（= `node --test --import tsx "src/**/*.test.ts"`，新测试文件自动被 glob 收录）。
- **对 spec 的一处修正（已在 plan 定案）**：spec §4.3 正文用 `convertSubtitle 'txt'`（无时间戳），与 §4.4 模板「出处必须带 `[分:秒]`」矛盾——正文格式改为 bundle 专属**行格式 `[分:秒] 字幕内容`**（新纯函数 `stampedTxt`），既保可读性又可溯源。
- resolveSubtitle 返回值扩展为**加可选字段**（向后兼容，`export subtitle` 命令行为不变）。
- commit message 用中文、`feat(cli):`/`refactor(cli):` 前缀。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/collector-server/src/cli/subtitleFormat.ts` | Modify | `extractBody` 从私有改导出（bundle 复用校验） |
| `apps/collector-server/src/cli/commands/export.ts` | Modify | ① resolveSubtitle ok 分支加轨信息 ② `export bundle` 子命令装配 |
| `apps/collector-server/src/cli/bundle.ts` | Create | ANALYZE.md 模板常量、`stampedTxt`、`buildBundle` 纯函数、类型 |
| `apps/collector-server/src/cli/bundle.test.ts` | Create | stampedTxt / ANALYZE_MD / buildBundle 单测 |
| `apps/collector-server/src/cli/commands/export.test.ts` | Modify | resolveSubtitle 扩展断言 + bundle 端到端装配测试 |
| `README.md` / spec / `CHANGELOG.md` | Modify | Task 5 统一回填 |

---

### Task 1: extractBody 导出 + resolveSubtitle 返回轨信息

**Files:**
- Modify: `apps/collector-server/src/cli/subtitleFormat.ts`（`function extractBody` → `export function extractBody`，注释同步）
- Modify: `apps/collector-server/src/cli/commands/export.ts:38-85`
- Test: `apps/collector-server/src/cli/commands/export.test.ts`

**Interfaces:**
- Produces: `resolveSubtitle` ok 分支新增可选字段 `trackLan?: string | null; trackLanDoc?: string | null; trackType?: number | null; versionOrigin?: string`（仅在走 getVideo 的路径填充；显式 `--version` 路径不填）。Task 3 的 `buildBundle` 消费这些字段。
- Produces: `extractBody(payload): BodyItem[]`（导出，`BodyItem = { from: number; to: number; content: string }`）。Task 2 的 `stampedTxt` 消费。

- [ ] **Step 1: 写失败测试**

在 `export.test.ts` 现有 resolveSubtitle 测试块后追加（fixture `setup()` 已含 BV1 双轨视频，直接复用）：

```ts
// ── resolveSubtitle：轨信息扩展（bundle 消费）──

test('resolveSubtitle: 默认轨路径返回轨信息 lan/lan_doc/track_type/origin', () => {
  const { db, dir } = setup();
  try {
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', format: 'json' });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    assert.equal(r.trackLan, 'zh-Hans');
    assert.equal(r.trackLanDoc, 'CC中文');
    assert.equal(r.trackType, 2);
    assert.equal(r.versionOrigin, 'external');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveSubtitle: --track en 路径返回 en 轨信息', () => {
  const { db, dir } = setup();
  try {
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', track: 'en', format: 'json' });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    assert.equal(r.trackLan, 'en');
    assert.equal(r.trackType, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveSubtitle: 显式 --version 路径不填轨信息（可选字段缺省）', () => {
  const { db, dir, ids } = setup();
  try {
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', versionId: ids.zhVer, format: 'json' });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    assert.equal(r.trackLan, undefined);
    assert.equal(r.versionOrigin, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/collector-server && node --test --import tsx src/cli/commands/export.test.ts
```
预期：新增 3 个用例 FAIL（`r.trackLan` 为 `undefined`，`assert.equal(undefined, 'zh-Hans')` 不等）。

- [ ] **Step 3: 最小实现**

`subtitleFormat.ts`：`function extractBody` 改 `export function extractBody`，其上方 JSDoc 补一行「bundle.ts 复用（stamped txt 行格式）」。

`export.ts` 类型与实现：

```ts
export type SubtitleResolveResult =
  | { kind: 'ok'; payload: unknown; text: string; format: SubtitleFormat; versionId: number;
      // 轨信息（bundle 消费）：仅走 getVideo 的路径填充；显式 --version 直取时不填（可选，向后兼容）
      trackLan?: string | null; trackLanDoc?: string | null; trackType?: number | null; versionOrigin?: string }
  | { kind: 'not_found'; message: string };
```

`resolveSubtitle` 路径 4（选到轨/版本后、return 前）填充：

```ts
  const v = getVersionPayload(db, ver.id);
  if (!v) return { kind: 'not_found', message: `subtitle_version not found: id=${ver.id}` };
  return {
    kind: 'ok', payload: v.payload, text: convertSubtitle(v.payload, fmt), format: fmt, versionId: v.id,
    trackLan: track.lan, trackLanDoc: track.lan_doc, trackType: track.track_type, versionOrigin: ver.origin,
  };
```

（路径 1 显式 versionId 的 return 不动。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/collector-server && node --test --import tsx src/cli/commands/export.test.ts && pnpm test
```
预期：全部 PASS（含既有用例——向后兼容无回归）。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/cli/subtitleFormat.ts apps/collector-server/src/cli/commands/export.ts apps/collector-server/src/cli/commands/export.test.ts
git commit -m "refactor(cli): resolveSubtitle 返回轨信息（lan/lan_doc/track_type/origin，bundle 消费）"
```

---

### Task 2: bundle.ts — 类型 + stampedTxt + ANALYZE.md 模板

**Files:**
- Create: `apps/collector-server/src/cli/bundle.ts`
- Test: `apps/collector-server/src/cli/bundle.test.ts`

**Interfaces:**
- Consumes: `extractBody`（Task 1 导出）。
- Produces（Task 3/4 消费）:
  - `secsToClock(seconds: number): string` — 导出（Task 3 的视频头部复用）
  - `stampedTxt(payload: unknown): string` — `[分:秒] 字幕` 行格式，payload 结构不符**抛错**（调用方 catch 记 errors）
  - `ANALYZE_MD: string` — 常量
- 测试 fixture 结构（Task 3 复用本文件 `setup()`）。

- [ ] **Step 1: 写失败测试**

`bundle.test.ts`：

```ts
// bundle.ts 纯函数单测：stampedTxt 行格式 + ANALYZE.md 模板锚点。
// 跑法：cd apps/collector-server && node --test --import tsx src/cli/bundle.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secsToClock, stampedTxt, ANALYZE_MD } from './bundle.js';

const PAYLOAD = {
  body: [
    { from: 5.2, to: 8, content: ' 观点一 ' },
    { from: 65, to: 70, content: '观点二' },
    { from: 3661, to: 3665, content: '一小时后' },
    { from: 71, to: 72, content: '   ' }, // 纯空白，应跳过
  ],
};

test('secsToClock: 秒→分:秒 / 时:分:秒', () => {
  assert.equal(secsToClock(0), '00:00');
  assert.equal(secsToClock(5.2), '00:05');
  assert.equal(secsToClock(65), '01:05');
  assert.equal(secsToClock(3661), '1:01:01');
});

test('stampedTxt: 行格式 [分:秒] 字幕，跳过空白行，末尾换行', () => {
  const out = stampedTxt(PAYLOAD);
  assert.equal(out, '[00:05] 观点一\n[01:05] 观点二\n[1:01:01] 一小时后\n');
});

test('stampedTxt: payload 结构不符时抛错', () => {
  assert.throws(() => stampedTxt({ noBody: true }), /结构不符/);
});

test('ANALYZE_MD: 含三类产物模板锚点 + 产物写回约定', () => {
  for (const anchor of ['观点汇总.md', '面试题库.md', '理念整理.md', 'manifest.json', 'videos/', '来源:']) {
    assert.ok(ANALYZE_MD.includes(anchor), `ANALYZE_MD 缺锚点: ${anchor}`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/collector-server && node --test --import tsx src/cli/bundle.test.ts
```
预期：FAIL（`Cannot find module './bundle.js'`）。

- [ ] **Step 3: 写 bundle.ts（本任务只到模板为止，buildBundle 留 Task 3）**

```ts
// export bundle 原料包：ANALYZE.md 模板 + 字幕行格式化 + buildBundle 组装。
// 设计：[export bundle 设计文档](../../docs/superpowers/specs/2026-08-19-export-bundle-design.md)。
// 措辞：字幕（subtitle），非弹幕。分析在 Claude Code 会话完成，本模块只产原料。
import { extractBody } from './subtitleFormat.js';

// ── 时间格式化 ──

/** 秒 → `分:秒`（<1h，两位补零）或 `时:分:秒`。负值归零，四舍五入。 */
export function secsToClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ── 字幕正文行格式 ──

/**
 * 字幕 payload → `[分:秒] 字幕内容` 行格式（bundle 正文专用）。
 * 与 convertSubtitle 'txt'（纯文本无时间戳）不同：行首轻量时间戳供分析产物引用出处。
 * payload 结构不符时抛错（extractBody），调用方 catch 后记 manifest errors[]。
 */
export function stampedTxt(payload: unknown): string {
  const lines = extractBody(payload)
    .map((item) => ({ at: secsToClock(item.from), text: item.content.trim() }))
    .filter((l) => l.text.length > 0)
    .map((l) => `[${l.at}] ${l.text}`);
  return `${lines.join('\n')}\n`;
}

// ── ANALYZE.md 模板（随每个 bundle 生成；产物规范单一来源，勿在他处复制）──

export const ANALYZE_MD = `# 分析指引（bundle 自述）

本目录是**分析原料包**：\`manifest.json\`（视频清单与导出条件）+ \`videos/*.txt\`（每视频字幕正文，行格式 \`[分:秒] 字幕\`）。

**分析产物写回本目录**（与原料同级）。按用途选模板，产物文件名固定：

| 用途 | 产物文件 |
|---|---|
| 某话题多 UP 观点聚合 | \`观点汇总.md\` |
| 面试题整理 | \`面试题库.md\` |
| 单 UP 理念提炼 | \`理念整理.md\` |

**硬性要求**：
1. 每条观点/题目/金句必须附出处：\`> 来源: <视频标题> [分:秒]\`，时间戳取自 \`videos/<BV号>.txt\` 行首，可回溯。
2. \`manifest.json\` 中 \`subtitle: null\` 的视频无正文（采集盲区），在「覆盖盲区」如实列出，勿假装看过。
3. 结论只用原料支持的说法，区分「视频里明说」与「分析者推断」。

---

## 模板一：观点汇总.md（多 UP 同话题）

\`\`\`markdown
# <主题> 观点汇总

> 原料：N 个视频 / M 位 UP（见 manifest.json）；生成：<日期>

## 共识（多方一致）
- <观点>
  > 来源: 视频A [12:34]、视频B [03:21]

## 分歧（说法相左）
### <议题>
- 立场甲：<观点>
  > 来源: 视频A [12:34]
- 立场乙：<观点>
  > 来源: 视频C [45:06]

## 值得追的线索
- <待验证 / 延伸阅读>

## 覆盖盲区
- <subtitle:null 视频 / 主题未覆盖的流派>
\`\`\`

## 模板二：面试题库.md（面试内容整理）

\`\`\`markdown
# <主题> 面试题库

> 原料：N 个视频；生成：<日期>

## <子主题>
### Q1. <题目>
- **考点**：
- **参考答案**（从字幕提炼）：
  > 来源: 视频A [12:34]
- **常见追问**：
\`\`\`

## 模板三：理念整理.md（单 UP 系列）

\`\`\`markdown
# <UP 主名> 理念整理

> 原料：N 个视频（<最早发布> ~ <最晚发布>）；生成：<日期>

## 核心理念（一句话）

## 方法论 / 原则
- <原则>
  > 来源: 视频A [12:34]

## 理念演变（按发布时间）

## 金句
- 「<原话>」
  > 来源: 视频B [05:00]
\`\`\`
`;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/collector-server && node --test --import tsx src/cli/bundle.test.ts
```
预期：4 个用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/cli/bundle.ts apps/collector-server/src/cli/bundle.test.ts
git commit -m "feat(cli): bundle 模块——stamped 行格式 + ANALYZE.md 三类分析模板"
```

---

### Task 3: buildBundle 纯函数（manifest + 文件列表组装）

**Files:**
- Modify: `apps/collector-server/src/cli/bundle.ts`（追加）
- Test: `apps/collector-server/src/cli/bundle.test.ts`（追加）

**Interfaces:**
- Consumes: `videosList(db, opts)`（[videos.ts:68](../../apps/collector-server/src/cli/commands/videos.ts#L68)，`VideosListOpts`）；`resolveSubtitle`（Task 1 扩展后的 ok 分支轨信息）。
- Produces（Task 4 消费）:

```ts
export interface BuildBundleOpts {
  filters: VideosListOpts;  // 不含 page/size（buildBundle 内部固定 page=1, size=limit）
  track?: string;           // 统一覆盖默认轨
  limit: number;            // >0
  now: number;              // generated_at（毫秒，注入保持纯函数）
}
export interface BundleFile { path: string; content: string; }  // path 相对 bundle 根（如 'videos/BV1.txt'）
export function buildBundle(db: Database.Database, opts: BuildBundleOpts): BundleResult;
// BundleResult = { manifest: BundleManifest; files: BundleFile[] }，files 含 manifest.json / ANALYZE.md / videos/*.txt
```

- [ ] **Step 1: 写失败测试**

`bundle.test.ts` 追加（fixture 参照 [export.test.ts setup()](../../apps/collector-server/src/cli/commands/export.test.ts) 的 ingestVideo 模式）：

```ts
// ── buildBundle（内存库 fixture）──
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { buildBundle } from './bundle.js';
import type { VideosListOpts } from './commands/videos.js';

const ZH = { body: [{ from: 0.36, to: 2.56, content: 'AI 编程工程化' }] };
const EN = { body: [{ from: 0, to: 1, content: 'hello' }] };

function setupDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: {
      source_vid: 'BV1', title: '标题A',
      creator: { source_uid: '1', name: 'Alpha UP' },
      extra: { tid: 23, tname: '科技', stat: { view: 1000 } }, duration: 600, published_at: 1724000000000,
    },
    tracks: [
      { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: ZH, source_url: 'https://cc' }] },
      { lan: 'en', lan_doc: 'English', track_type: 1, versions: [{ origin: 'asr', payload: EN, source_url: 'https://en' }] },
    ],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: {
      source_vid: 'BV2', title: '标题B（无字幕）',
      creator: { source_uid: '1', name: 'Alpha UP' },
      extra: { tid: 23, tname: '科技', stat: { view: 2000 } }, duration: 300, published_at: null,
    },
    tracks: [],
  });
  return { db, dir };
}

test('buildBundle: 有字幕视频出正文文件，无字幕视频 subtitle:null 不出文件', () => {
  const { db, dir } = setupDb();
  try {
    const r = buildBundle(db, { filters: {}, limit: 100, now: 1724059200000 });
    assert.equal(r.manifest.total_matched, 2);
    assert.equal(r.manifest.exported, 2);
    assert.equal(r.manifest.generated_at, 1724059200000);
    const bv1 = r.manifest.videos.find((v) => v.source_vid === 'BV1')!;
    assert.equal(bv1.subtitle?.file, 'videos/BV1.txt');
    assert.equal(bv1.subtitle?.lan, 'zh-Hans');
    assert.equal(bv1.subtitle?.track_type, 2);
    assert.equal(bv1.subtitle?.origin, 'external');
    const bv2 = r.manifest.videos.find((v) => v.source_vid === 'BV2')!;
    assert.equal(bv2.subtitle, null);
    // 文件：manifest.json + ANALYZE.md + 仅 BV1 正文
    assert.deepEqual(r.files.map((f) => f.path).sort(), ['ANALYZE.md', 'manifest.json', 'videos/BV1.txt']);
    // BV1 正文：头部元信息 + 行格式正文
    const txt = r.files.find((f) => f.path === 'videos/BV1.txt')!.content;
    assert.ok(txt.includes('# 标题A'));
    assert.ok(txt.includes('UP: Alpha UP'));
    assert.ok(txt.includes('BV: BV1'));
    assert.ok(txt.includes('轨: CC中文(zh-Hans, CC)'));
    assert.ok(txt.includes('[00:00] AI 编程工程化'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: --track en 覆盖默认轨', () => {
  const { db, dir } = setupDb();
  try {
    const r = buildBundle(db, { filters: { hasSubtitle: true }, track: 'en', limit: 100, now: 0 });
    const bv1 = r.manifest.videos.find((v) => v.source_vid === 'BV1')!;
    assert.equal(bv1.subtitle?.lan, 'en');
    assert.equal(bv1.subtitle?.origin, 'asr');
    assert.ok(r.files.find((f) => f.path === 'videos/BV1.txt')!.content.includes('轨: English(en, AI)'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: limit 截断（total_matched > exported）且 filters 回显', () => {
  const { db, dir } = setupDb();
  try {
    const filters: VideosListOpts = { creator: 'Alpha' };
    const r = buildBundle(db, { filters, limit: 1, now: 0 });
    assert.equal(r.manifest.total_matched, 2);
    assert.equal(r.manifest.exported, 1);
    assert.equal(r.manifest.limit, 1);
    assert.deepEqual(r.manifest.filters, { creator: 'Alpha' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: payload 损坏 → errors[] 记录、subtitle:null、整包不中断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BVX', title: '损坏', creator: { source_uid: '9', name: 'X' }, extra: {}, duration: 60, published_at: null },
    tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { broken: true }, source_url: null }] }],
  });
  try {
    const r = buildBundle(db, { filters: {}, limit: 10, now: 0 });
    const bvx = r.manifest.videos.find((v) => v.source_vid === 'BVX')!;
    assert.equal(bvx.subtitle, null);
    assert.equal(r.manifest.errors!.length, 1);
    assert.ok(r.manifest.errors![0].message.includes('结构不符'));
    assert.ok(r.files.some((f) => f.path === 'manifest.json'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: 空命中正常产出（exported=0，仍含 manifest+ANALYZE）', () => {
  const { db, dir } = setupDb();
  try {
    const r = buildBundle(db, { filters: { creator: '不存在的人' }, limit: 10, now: 0 });
    assert.equal(r.manifest.total_matched, 0);
    assert.equal(r.manifest.exported, 0);
    assert.deepEqual(r.files.map((f) => f.path).sort(), ['ANALYZE.md', 'manifest.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

注意断言 `轨: CC中文(zh-Hans, CC)` 对应头部格式（见 Step 3 `videoHeader`）；`track_type` 1 显示 `AI`、2 显示 `CC`。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/collector-server && node --test --import tsx src/cli/bundle.test.ts
```
预期：新用例 FAIL（`buildBundle` 未定义）。

- [ ] **Step 3: 实现 buildBundle（追加到 bundle.ts）**

```ts
import type Database from 'better-sqlite3';
import { videosList, type VideosListOpts } from './commands/videos.js';
import { resolveSubtitle } from './commands/export.js';

// ── 类型 ──

export interface BundleSubtitleMeta {
  file: string;                 // 相对 bundle 根
  lan: string | null;
  lan_doc: string | null;
  track_type: number | null;    // 1=AI 2=CC
  version_id: number;
  origin: string;               // external | manual | asr
}

export interface BundleVideoEntry {
  id: number; source: string; source_vid: string;
  title: string; creator_name: string | null; creator_source_uid: string | null;
  duration: number | null; published_at: number | null; first_seen_at: number;
  track_count: number;
  subtitle: BundleSubtitleMeta | null;  // null = 无字幕/轨缺失/payload 损坏
}

export interface BundleManifest {
  generated_at: number;
  filters: VideosListOpts;      // camelCase 原样回显（since/until 为毫秒数）
  total_matched: number;
  exported: number;
  limit: number;
  videos: BundleVideoEntry[];
  errors?: Array<{ source_vid: string; message: string }>;
}

export interface BundleResult { manifest: BundleManifest; files: BundleFile[]; }
export interface BundleFile { path: string; content: string; }
export interface BuildBundleOpts { filters: VideosListOpts; track?: string; limit: number; now: number; }

// ── 视频正文头部（元信息两行 + 轨一行 + 空行 + 正文）──

function videoHeader(v: BundleVideoEntry, sub: BundleSubtitleMeta): string {
  const dur = v.duration != null ? secsToClock(v.duration) : '未知';
  const pub = v.published_at != null ? new Date(v.published_at).toISOString().slice(0, 10) : '未知';
  const trackTypeLabel = sub.track_type === 2 ? 'CC' : sub.track_type === 1 ? 'AI' : '?';
  const trackLabel = sub.lan_doc && sub.lan ? `${sub.lan_doc}(${sub.lan}, ${trackTypeLabel})` : `${sub.lan ?? '(无lan)'}`;
  return [
    `# ${v.title}`,
    `UP: ${v.creator_name ?? '未知UP'}  时长: ${dur}  发布: ${pub}  BV: ${v.source_vid}`,
    `轨: ${trackLabel}  版本来源: ${sub.origin}`,
    '',
  ].join('\n');
}

// ── 组装（纯函数：只读 db，不落盘；时间由 opts.now 注入）──

export function buildBundle(db: Database.Database, opts: BuildBundleOpts): BundleResult {
  const page = videosList(db, { ...opts.filters, page: 1, size: opts.limit });
  const videos: BundleVideoEntry[] = [];
  const files: BundleFile[] = [{ path: 'ANALYZE.md', content: ANALYZE_MD }];
  const errors: Array<{ source_vid: string; message: string }> = [];

  for (const v of page.items) {
    const entry: BundleVideoEntry = {
      id: v.id, source: v.source, source_vid: v.source_vid,
      title: v.title, creator_name: v.creator_name, creator_source_uid: v.creator_source_uid,
      duration: v.duration, published_at: v.published_at, first_seen_at: v.first_seen_at,
      track_count: v.track_count, subtitle: null,
    };
    const r = resolveSubtitle(db, { source: v.source, sourceVid: v.source_vid, track: opts.track, format: 'json' });
    if (r.kind === 'ok') {
      try {
        const body = stampedTxt(r.payload);
        const sub: BundleSubtitleMeta = {
          file: `videos/${v.source_vid}.txt`,
          lan: r.trackLan ?? null, lan_doc: r.trackLanDoc ?? null,
          track_type: r.trackType ?? null, version_id: r.versionId, origin: r.versionOrigin ?? '?',
        };
        entry.subtitle = sub;
        files.push({ path: sub.file, content: `${videoHeader(entry, sub)}${body}` });
      } catch (err) {
        // payload 损坏：记 errors、subtitle 保持 null，不中断整包
        errors.push({ source_vid: v.source_vid, message: (err as Error).message });
      }
    }
    videos.push(entry);
  }

  const manifest: BundleManifest = {
    generated_at: opts.now, filters: opts.filters,
    total_matched: page.total, exported: page.items.length, limit: opts.limit,
    videos, ...(errors.length > 0 ? { errors } : {}),
  };
  files.unshift({ path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
  return { manifest, files };
}
```

（import 语句合并到文件头部既有 import 区；`Database` 类型 import 补 `import type Database from 'better-sqlite3'`。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/collector-server && node --test --import tsx src/cli/bundle.test.ts
```
预期：全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/cli/bundle.ts apps/collector-server/src/cli/bundle.test.ts
git commit -m "feat(cli): buildBundle 纯函数——manifest + 文件列表组装（无字幕 null/limit 截断/errors 容错）"
```

---

### Task 4: commander 装配 `export bundle` + 端到端测试

**Files:**
- Modify: `apps/collector-server/src/cli/commands/export.ts`（`buildExportCommand()` 内追加子命令）
- Test: `apps/collector-server/src/cli/commands/export.test.ts`（追加端到端用例）

**Interfaces:**
- Consumes: `buildBundle` / `BundleResult`（Task 3）；`parseNum` / `parseTime` / `parseSort` / `openDbOrEmit`（export.ts 既有）；`getCliContext` / `emitResult` / `emitError`。
- Produces: CLI 命令 `collector-cli export bundle --out <dir> [--track <lan>] [--limit <n>] [--force] [过滤器…]`。

- [ ] **Step 1: 写失败测试（端到端，spawn 真 CLI 进程）**

`export.test.ts` 追加（照文件内 R2 的 spawn 端到端模式）：

```ts
// ── export bundle 端到端（spawn 真 CLI：装配/落盘/回执）──
import { mkdirSync, readdirSync } from 'node:fs';

test('export bundle: 端到端导出目录结构 + 回执', () => {
  const { db, dir } = setup();  // 复用 fixture（BV1 双轨）
  const out = join(dir, 'bundle-out');
  try {
    const p = spawnSync('npx', [
      'tsx', 'src/cli/main.ts', '--db', join(dir, 'test.db'),
      'export', 'bundle', '--creator', 'Alpha UP', '--out', out,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(p.status, 0, `stderr: ${p.stderr}`);
    const receipt = JSON.parse(p.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.exported, 1);
    assert.equal(receipt.with_subtitle, 1);
    assert.equal(receipt.without_subtitle, 0);
    assert.deepEqual(readdirSync(out).sort(), ['ANALYZE.md', 'manifest.json', 'videos']);
    assert.ok(readdirSync(join(out, 'videos')).includes('BV1.txt'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export bundle: --out 已存在且非空且无 --force → ARGS(2)', () => {
  const { db, dir } = setup();
  const out = join(dir, 'occupied');
  mkdirSync(out);
  writeFileSync(join(out, 'old.txt'), 'x');
  try {
    const p = spawnSync('npx', [
      'tsx', 'src/cli/main.ts', '--db', join(dir, 'test.db'),
      'export', 'bundle', '--creator', 'Alpha UP', '--out', out,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(p.status, 2);
    const receipt = JSON.parse(p.stdout);
    assert.ok(receipt.error.message.includes('--force'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

（若现有 R2 测试的 spawn 目标/写法略有出入——如直接 spawn `node --import tsx`——**以文件内既有写法为准**对齐，断言不变。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/collector-server && node --test --import tsx src/cli/commands/export.test.ts
```
预期：新用例 FAIL（`export bundle` 未知子命令，非 0 退出）。

- [ ] **Step 3: 装配实现（export.ts）**

文件头 import 区追加：

```ts
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBundle } from '../bundle.js';
```

`buildExportCommand()` 内、`export videos` 块之后追加（描述与过滤器说明完整给出）：

```ts
  // export bundle（分析原料包：manifest.json + videos/*.txt + ANALYZE.md；分析在会话完成，产物写回 --out）
  interface BundleRawOpts extends Omit<VideosRawOpts, 'page' | 'size' | 'output'> {
    out?: string;
    track?: string;
    limit?: string;
    force?: boolean;
  }
  exp
    .command('bundle')
    .description('按条件批量导出分析原料包（manifest.json + videos/*.txt + ANALYZE.md）；过滤器同 videos list（无分页）')
    .requiredOption('--out <dir>', '输出目录（已存在且非空时需 --force；同名文件覆盖，不清理多余旧文件）')
    .option('--track <lan>', '统一覆盖字幕轨（默认各视频默认轨：CC中文>AI中文>en）')
    .option('--limit <n>', '最多导出视频数（默认 500）')
    .option('--force', '允许写入已存在且非空的 --out 目录')
    // —— 过滤器（同 export videos，去分页去 -o）——
    .option('--q <text>', '标题 / UP 名模糊匹配')
    .option('--creator <name>', 'UP 名模糊匹配')
    .option('--source <src>', '视频来源（精确）')
    .option('--tid <id>', '分区 tid（精确）')
    .option('--tname <name>', '分区名模糊匹配')
    .option('--tag <tag>', '标签名模糊匹配')
    .option('--subtitle-q <text>', '字幕正文关键词模糊匹配')
    .option('--lang <lang>', '字幕语言模糊匹配')
    .option('--track-type <type>', '字幕轨类型（1=AI 2=CC），精确')
    .option('--has-subtitle', '仅含至少一条字幕版本的视频')
    .option('--paid', '仅付费视频')
    .option('--since <ts>', '起始时间（Unix 秒/毫秒 或 ISO8601），比对 first_seen_at')
    .option('--until <ts>', '结束时间，比对 first_seen_at')
    .option('--min-duration <s>', '最小时长（秒）')
    .option('--max-duration <s>', '最大时长（秒）')
    .option('--min-view <n>', '最小播放量')
    .option('--max-view <n>', '最大播放量')
    .option('--sort <key>', '排序键：first_seen|published_at|title|duration|view')
    .option('--desc', '降序（默认升序）')
    .action((raw: BundleRawOpts) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      if (!raw.out) return emitError('--out 必填', 'ARGS');
      if (existsSync(raw.out) && readdirSync(raw.out).length > 0 && !raw.force) {
        return emitError(`--out 目录已存在且非空: ${raw.out}（覆盖请加 --force）`, 'ARGS');
      }
      const filters: VideosListOpts = {
        q: raw.q, creator: raw.creator, source: raw.source,
        tid: parseNum(raw.tid, '--tid'), tname: raw.tname, tag: raw.tag,
        subtitleQ: raw.subtitleQ, lang: raw.lang,
        trackType: parseNum(raw.trackType, '--track-type'),
        hasSubtitle: raw.hasSubtitle, paid: raw.paid,
        since: parseTime(raw.since, '--since'), until: parseTime(raw.until, '--until'),
        minDuration: parseNum(raw.minDuration, '--min-duration'), maxDuration: parseNum(raw.maxDuration, '--max-duration'),
        minView: parseNum(raw.minView, '--min-view'), maxView: parseNum(raw.maxView, '--max-view'),
        sort: parseSort(raw.sort), desc: raw.desc,
      };
      const built = buildBundle(db, { filters, track: raw.track, limit: parseNum(raw.limit, '--limit') ?? 500, now: Date.now() });
      mkdirSync(join(raw.out, 'videos'), { recursive: true });
      for (const f of built.files) writeFileSync(join(raw.out, f.path), f.content);
      emitResult({
        ok: true, path: raw.out,
        videos_total: built.manifest.total_matched, exported: built.manifest.exported,
        with_subtitle: built.manifest.videos.filter((v) => v.subtitle).length,
        without_subtitle: built.manifest.videos.filter((v) => !v.subtitle).length,
        files: built.files.length,
      }, ctx.format);
    });
```

注意：`BundleRawOpts` 类型定义放 `buildExportCommand()` 外（与 `VideosRawOpts` 并列，文件顶部 raw-opts 区），此处展示为省篇幅写在了一起——实现时放文件顶部。`VideosListOpts` 需要 import（`import { videosList, normalizeTimestamp, type VideosListOpts } from './videos.js'`，现有 import 行补 type）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

```bash
cd apps/collector-server && node --test --import tsx src/cli/commands/export.test.ts && pnpm test
```
预期：全部 PASS（含既有 export/subtitle、export/videos 用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/cli/commands/export.ts apps/collector-server/src/cli/commands/export.test.ts
git commit -m "feat(cli): export bundle 命令装配——原料包一条命令导出（端到端测试覆盖）"
```

---

### Task 5: 真库冒烟验收 + 文档回填

**Files:**
- Modify: `README.md`（feature 列表 🚧→✅）、`docs/superpowers/specs/2026-08-19-export-bundle-design.md`（测试轮次记录表回填）、`CHANGELOG.md`（新增条目）

**Interfaces:** 无代码改动；纯验收 + 文档同步（CLAUDE.md §6 纪律）。

- [ ] **Step 1: 真库冒烟（只读）**

```bash
cd apps/collector-server && pnpm cli --db ~/Code/yawyd/subtitle-collector/data/bilibili-collector.db \
  export bundle --limit 5 --has-subtitle --sort published_at --desc --out /tmp/bundle-smoke --force
```
预期：exit 0；回执 `exported: 5`；`ls /tmp/bundle-smoke` 出 `ANALYZE.md manifest.json videos`；抽查 1 个 txt：头部四行（标题/UP/时长/BV/轨）+ `[分:秒]` 行正文。

- [ ] **Step 2: 修复冒烟暴露的问题（若有）**

冒烟发现的问题按 superpowers:systematic-debugging 处理，修复后重跑 Step 1 + `pnpm test`。

- [ ] **Step 3: 文档回填**

- `README.md` §批量提取分析：`🚧 **原料包导出** \`export bundle\`` → `✅ **原料包导出** \`export bundle\`（manifest.json + videos/*.txt + ANALYZE.md 三件套，分析产物写回 bundle 目录）`
- spec 测试轮次记录表回填：

```markdown
| 1 | 2026-08-19 | 单测（stampedTxt/buildBundle/装配端到端）+ 真库冒烟（yawyd 库 limit=5） | 通过 | <实测 exported/with_subtitle 数字回填> |
```

- `CHANGELOG.md` 顶部新增条目（对齐现有格式）：

```markdown
## v0.x —— export bundle 原料包导出（消费端第一块）

- CLI `export bundle`：按任意过滤器（UP 主/搜索/标签/付费/时间…）批量导出分析原料包——`manifest.json`（清单+盲区标记）+ `videos/*.txt`（`[分:秒] 字幕` 行格式正文）+ `ANALYZE.md`（观点汇总/面试题库/理念整理三类产物模板）。
- 分析在 Claude Code 会话完成，产物写回 bundle 目录；无字幕视频记 `subtitle: null`；payload 损坏记 `errors[]` 不中断整包。
```

- [ ] **Step 4: 终验 + Commit**

```bash
cd apps/collector-server && pnpm test && pnpm build
```
预期：全绿 + tsc 编译通过。

```bash
git add README.md CHANGELOG.md docs/superpowers/specs/2026-08-19-export-bundle-design.md
git commit -m "feat(cli): export bundle 真库冒烟验收 + README/spec/CHANGELOG 回填"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 需求表逐项 → Task 3（limit/null/track/空命中）、Task 4（过滤器/force/回执）、Task 2（ANALYZE 模板+产物落点）；§4.6 错误表 → Task 3 Step1 第4/5用例 + Task 4 Step1 第2用例；§5 测试 → Task 1-4 单测 + Task 5 真库。✅
- **类型一致性**：`trackLan/trackLanDoc/trackType/versionOrigin`（Task 1 产出 = Task 3 `BundleSubtitleMeta` 消费）；`stampedTxt`/`secsToClock`/`ANALYZE_MD`（Task 2 产出 = Task 3/4 消费）；`buildBundle(files: BundleFile[])`（Task 3 产出 = Task 4 落盘消费）。✅
- **占位符扫描**：无 TBD/TODO；所有代码块完整可写。✅
- **已知留白（有意）**：Task 4 测试的 spawn 写法标注「以文件内既有 R2 写法为准」——既有模式优先于 plan 内代码，避免双维护。
