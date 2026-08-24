// stats.ts commander 装配层测试：子进程跑真 CLI，覆盖 overview/count action 成功 +
// parseNum/parseTime/parseGroupBy 非法 + openDbOrEmit DB 缺失。纯函数（statsOverview/statsCount）见 stats.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | overview + count --by creator/lang 成功；--by/--top/--since 非法 ARGS；DB 缺失 DB_UNREADABLE | 通过 | |

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

const T = 1_700_000_000_000;

// 样本库（对齐 videos.cli.test.ts）：2 UP × 4 视频，3 轨（zh CC / en AI / en CC）。
function setup(): { db: Database.Database; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-stats-cli-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const ingest = (sv: string, title: string, uid: string, name: string, extra: Record<string, unknown>, dur: number,
    tracks: Array<{ lan?: string; track_type?: number; versions: Array<{ origin: string; payload: unknown }> }>) =>
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: sv, title, creator: { source_uid: uid, name }, extra, duration: dur, published_at: T },
      tracks,
    });
  ingest('BV1', '标题A', '1', 'Alpha UP', { tid: 17, tname: '单机游戏' }, 600, [
    { lan: 'zh-Hans', track_type: 2, versions: [{ origin: 'external', payload: { body: [] } }] },
    { lan: 'en', track_type: 1, versions: [{ origin: 'external', payload: { body: [] } }] },
  ]);
  ingest('BV2', '标题B', '1', 'Alpha UP', { tid: 122, tname: '科技' }, 300, [
    { lan: 'zh-Hans', track_type: 1, versions: [{ origin: 'external', payload: { body: [] } }] },
  ]);
  ingest('BV3', '标题C', '2', 'Beta UP', { tid: 17, tname: '单机游戏' }, 1200, [
    { lan: 'en', track_type: 2, versions: [{ origin: 'external', payload: { body: [] } }] },
  ]);
  ingest('BV4', '标题D', '2', 'Beta UP', {}, 60, []);
  const setSeen = (sv: string, ts: number) => db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(ts, sv);
  setSeen('BV1', T + 100);
  setSeen('BV2', T + 200);
  setSeen('BV3', T + 300);
  setSeen('BV4', T + 400);
  return { db, dbPath: join(dir, 'test.db'), dir };
}

// ── stats overview ──

test('stats overview：总览计数（total + by_source）+ first_seen 范围，退 0', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['stats', 'overview']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.total.videos, 4);
    assert.equal(data.total.tracks, 4); // BV1×2 + BV2×1 + BV3×1
    assert.equal(data.total.versions, 4); // 每轨 1 版本
    assert.equal(data.total.creators, 2);
    assert.equal(data.total.languages, 2); // zh-Hans + en
    assert.equal(data.total.first_seen_min, T + 100);
    assert.equal(data.total.first_seen_max, T + 400);
    // 单平台种子：by_source 只含 bilibili，数字与 total 一致
    assert.deepEqual(Object.keys(data.by_source), ['bilibili']);
    assert.equal(data.by_source.bilibili.videos, 4);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('stats overview：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const r = await cli(args(join(tmpdir(), 'cli-stats-no-such.db'), ['stats', 'overview']));
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
});

// ── stats count ──

test('stats count --by creator：分组计数（Alpha 2 / Beta 2），退 0', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['stats', 'count', '--by', 'creator']));
    assert.equal(r.code, 0);
    const rows = JSON.parse(r.out) as Array<{ key: string; count: number }>;
    const byKey = Object.fromEntries(rows.map((x) => [x.key, x.count]));
    assert.equal(byKey['Alpha UP'], 2);
    assert.equal(byKey['Beta UP'], 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stats count --by lang + --has-subtitle + --since：过滤透传成功', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['stats', 'count', '--by', 'lang', '--has-subtitle', '--since', '1699999999']));
    assert.equal(r.code, 0);
    const rows = JSON.parse(r.out) as Array<{ key: string; count: number }>;
    const byKey = Object.fromEntries(rows.map((x) => [x.key, x.count]));
    assert.equal(byKey['zh-Hans'], 2);
    assert.equal(byKey['en'], 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stats count --top 1：TopN 生效（只留 1 行）', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['stats', 'count', '--by', 'creator', '--top', '1']));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stats count：--by 非法取值 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['stats', 'count', '--by', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 --by: bogus/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stats count：--top 非数字 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['stats', 'count', '--by', 'creator', '--top', 'abc']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--top 不是合法数字: abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stats count：--since 非法时间 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['stats', 'count', '--by', 'tname', '--since', 'nope']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--since/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stats count：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const r = await cli(args(join(tmpdir(), 'cli-stats-no-such.db'), ['stats', 'count', '--by', 'creator']));
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
});
