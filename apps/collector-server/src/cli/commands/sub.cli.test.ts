// sub.ts commander 装配层测试：子进程跑真 CLI，覆盖 search action 成功（--full/--all-tracks/--plain/预筛）
// + 各数值选项 ARGS 校验 + 非法正则 ARGS + --full-format 非法 + 空关键词 + DB_UNREADABLE。
// 纯函数（matchBody/extractSnippets/searchSubtitles）见 sub.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | search 成功路径 5 态 + ARGS（ctx/max-* ×3/full-format/空关键词/非法正则）+ DB_UNREADABLE | 通过 | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/cli/commands
const MAIN_TS = join(HERE, '..', 'main.ts');
const APP_ROOT = resolve(HERE, '../../..');

function cli(args_: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, ...args_], { cwd: APP_ROOT }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
}

const args = (dbPath: string, rest: string[]): string[] =>
  ['--db', dbPath, '--server', 'http://127.0.0.1:1', '--token', 't', ...rest];

// 样本库：BV9 带正文字幕（前两段「通胀」相邻命中 → cluster 合并，第三段远距独立）；
// BV7 双轨（zh 正常 payload + xx 空版本轨，--all-tracks 时空轨走 continue 分支）；
// BV8 有轨无版本；BV4 无轨。候选池默认含全部视频（LIKE 预筛按 payload 命中）。
function setup(): { db: Database.Database; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-sub-cli-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV9', title: '通胀专题', creator: { source_uid: '9', name: '经济UP' }, extra: {}, duration: 100, published_at: 1 },
    tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { body: [
      { from: 0, to: 2, content: '今天聊通胀' },
      { from: 3, to: 5, content: '通胀与CPI' },
      { from: 100, to: 102, content: '通胀率再创新高' },
    ] } }] }],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV7', title: '双轨视频', creator: { source_uid: '7', name: '双轨UP' }, extra: {}, duration: 80, published_at: 1 },
    tracks: [
      { lan: 'zh-Hans', track_type: 2, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 3, content: '通胀语境' }] } }] },
      { lan: 'xx', track_type: 1, versions: [] }, // 空版本轨：--all-tracks 轮询到时无默认版本 → 跳过
    ],
  });
  // 有轨无版本：搜索时进入候选但 getPayloads 跳过（无默认版本）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV8', title: '空轨视频', creator: { source_uid: '8', name: '空轨UP' }, extra: {}, duration: 50, published_at: 1 },
    tracks: [{ lan: 'xx', track_type: 1, versions: [] }],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV4', title: '无轨视频', creator: { source_uid: '4', name: '路人' }, extra: {}, duration: 60, published_at: 1 },
    tracks: [],
  });
  return { db, dbPath: join(dir, 'test.db'), dir };
}

// ── 成功路径 ──

test('sub search：命中字幕正文 → {keyword,items,matched_videos}，退 0', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['sub', 'search', '通胀', '--creator', '经济UP']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.keyword, '通胀');
    assert.equal(data.regex, false);
    assert.equal(data.matched_videos, 1);
    assert.equal(data.total_snippets, 2); // 相邻命中 [0,1] 合并 1 片段 + 远距 [100] 独立 1 片段
    assert.equal(data.items[0].video.source_vid, 'BV9');
    assert.equal(data.items[0].snippets[0].content, '今天聊通胀通胀与CPI', '相邻命中 cluster 合并：content 顺序拼接');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('sub search --full：item.full 含整条字幕文本', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['sub', 'search', '通胀', '--full', '--creator', '经济UP']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.match(data.items[0].full, /CPI/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub search --all-tracks --plain：context 为纯文本（无 [from-to] 前缀）', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['sub', 'search', '通胀', '--all-tracks', '--plain', '--creator', '经济UP']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.matched_videos, 1);
    assert.ok(!/\[\d/.test(data.items[0].snippets[0].context), 'plain 模式 context 不应含时间戳前缀');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub search --regex：正则命中 + 视频预筛（--creator）', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['sub', 'search', '通[胀货]', '--regex', '--creator', '经济UP']));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).matched_videos, 1);
    // 预筛排除掉目标 UP → 0 命中
    const r2 = await cli(args(dbPath, ['sub', 'search', '通[胀货]', '--regex', '--creator', '路人']));
    assert.equal(r2.code, 0);
    assert.equal(JSON.parse(r2.out).matched_videos, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub search --ctx 1 --max-snippets-per-video 1：参数生效', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['sub', 'search', '通胀', '--ctx', '1', '--max-snippets-per-video', '1', '--creator', '经济UP']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.items[0].snippets.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── ARGS 校验 ──

test('sub search：空关键词 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['sub', 'search', '']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /<keyword> 不能为空/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub search --ctx 0 / --ctx abc → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r0 = await cli(args(dbPath, ['sub', 'search', 'x', '--ctx', '0']));
    assert.equal(r0.code, 2);
    assert.match(r0.err, /--ctx 必须为正数/);
    const rAbc = await cli(args(dbPath, ['sub', 'search', 'x', '--ctx', 'abc']));
    assert.equal(rAbc.code, 2);
    assert.match(rAbc.err, /--ctx 不是合法数字: abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub search --max-snippets 0 / --max-snippets-per-video 0 / --max-videos 0 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    for (const flag of ['--max-snippets', '--max-snippets-per-video', '--max-videos']) {
      const r = await cli(args(dbPath, ['sub', 'search', 'x', flag, '0']));
      assert.equal(r.code, 2, `${flag} 0 应 ARGS`);
      assert.equal(JSON.parse(r.out).code, 'ARGS');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub search --full-format bogus → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['sub', 'search', '通胀', '--full-format', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 --full-format: bogus/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sub search --regex '['：非法正则 → ARGS 退 2", async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['sub', 'search', '[', '--regex']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法正则/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub search --tid abc：预筛数值参数非法 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['sub', 'search', '通胀', '--tid', 'abc']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--tid 不是合法数字: abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── DB 缺失 ──

test('sub search：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const r = await cli(args(join(tmpdir(), 'cli-sub-no-such.db'), ['sub', 'search', '通胀']));
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
});

test('sub search --all-tracks：候选带空版本轨时跳过该轨（无默认版本），命中正常轨', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['sub', 'search', '通胀', '--all-tracks', '--creator', '双轨UP']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.matched_videos, 1);
    assert.equal(data.items[0].video.source_vid, 'BV7');
    assert.equal(data.items[0].track.lan, 'zh-Hans');
    assert.equal(data.items[0].snippets[0].content, '通胀语境');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub search --max-snippets 1：全局配额截断 + truncated 标记', async () => {
  const { dir, dbPath } = setup();
  try {
    // BV9 有 2 个片段（相邻合并 1 + 远距 1）；配额 1 → 截到 1 并标记 truncated
    const r = await cli(args(dbPath, ['sub', 'search', '通胀', '--max-snippets', '1', '--creator', '经济UP']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.total_snippets, 1);
    assert.equal(data.truncated, true);
    assert.equal(data.items[0].snippets.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
