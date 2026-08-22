// videos.ts commander 装配层测试：子进程跑真 CLI，覆盖 .action() 成功路径 + parseNum/parseSort/parseTime
// 非法参数 + openDbOrEmit DB 缺失。纯函数（videosList/videosGet/normalizeTimestamp）见 videos.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | list/get/get-by-id 三 action 成功 + ARGS（tid/since/sort/id 非数字）+ DB_UNREADABLE + NOT_FOUND | 通过 | |

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

function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, ...args], { cwd: APP_ROOT }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
}

const T = 1_700_000_000_000;

// 样本库：2 UP × 4 视频（数据形状对齐 videos.test.ts 的 setup）。
function setup(): { db: Database.Database; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-videos-cli-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const ingest = (sourceVid: string, title: string, uid: string, name: string, extra: Record<string, unknown>, dur: number, pub: number,
    tracks: Array<{ lan?: string; track_type?: number; versions: Array<{ origin: string; payload: unknown }> }>) =>
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: sourceVid, title, creator: { source_uid: uid, name }, extra, duration: dur, published_at: pub },
      tracks,
    });
  ingest('BV1', '标题A', '1', 'Alpha UP', { tid: 17, tname: '单机游戏' }, 600, T + 1000, [
    { lan: 'zh-Hans', track_type: 2, versions: [{ origin: 'external', payload: { body: [] } }] },
    { lan: 'en', track_type: 1, versions: [{ origin: 'external', payload: { body: [] } }] },
  ]);
  ingest('BV2', '标题B', '1', 'Alpha UP', { tid: 122, tname: '科技' }, 300, T + 2000, [
    { lan: 'zh-Hans', track_type: 1, versions: [{ origin: 'external', payload: { body: [] } }] },
  ]);
  ingest('BV3', '标题C', '2', 'Beta UP', { tid: 17, tname: '单机游戏' }, 1200, T + 3000, [
    { lan: 'en', track_type: 2, versions: [{ origin: 'external', payload: { body: [] } }] },
  ]);
  ingest('BV4', '标题D', '2', 'Beta UP', {}, 60, T + 4000, []);
  const setSeen = (sv: string, ts: number) => db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(ts, sv);
  setSeen('BV1', T + 100);
  setSeen('BV2', T + 200);
  setSeen('BV3', T + 300);
  setSeen('BV4', T + 400);
  return { db, dbPath: join(dir, 'test.db'), dir };
}

const NO_DB = join(tmpdir(), 'cli-videos-no-such.db');
// 统一：--db 显式传参（避开 env COLLECTOR_DB_PATH 干扰）+ 不可达 server + 假 token。
const args = (dbPath: string, rest: string[]): string[] =>
  ['--db', dbPath, '--server', 'http://127.0.0.1:1', '--token', 't', ...rest];

// ── videos list ──

test('videos list：默认 {total,page,size,items}，退 0', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['videos', 'list']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.total, 4);
    assert.equal(data.page, 1);
    assert.equal(data.size, 20);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videos list：--since 秒级时间戳规范化后过滤成功', async () => {
  const { dir, dbPath } = setup();
  try {
    // 1699999999 秒 → 1699999999000 ms < T+100 → 4 条全中
    const r = await cli(args(dbPath, ['videos', 'list', '--since', '1699999999']));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).total, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videos list：--tid 非数字 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['videos', 'list', '--tid', 'abc']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--tid 不是合法数字: abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videos list：--since 非法时间 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['videos', 'list', '--since', 'not-a-date']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--since/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videos list：--sort 非法键 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['videos', 'list', '--sort', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 --sort: bogus/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videos list：DB 文件不存在 → DB_UNREADABLE 退 4', async () => {
  const r = await cli(args(NO_DB, ['videos', 'list']));
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
  assert.match(r.err, /DB file not found/);
});

// ── videos get ──

test('videos get：按 source+source_vid 取详情，退 0', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['videos', 'get', 'bilibili', 'BV1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.video.source_vid, 'BV1');
    assert.equal(data.tracks.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videos get：视频不存在 → NOT_FOUND 退 5', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['videos', 'get', 'bilibili', 'NOPE']));
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
    assert.match(r.err, /video not found: bilibili\/NOPE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videos get：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const r = await cli(args(NO_DB, ['videos', 'get', 'bilibili', 'BV1']));
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
});

// ── videos get-by-id ──

test('videos get-by-id：合法 id 取详情，退 0', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const id = (db.prepare("SELECT id FROM videos WHERE source_vid = 'BV1'").get() as { id: number }).id;
    const r = await cli(args(dbPath, ['videos', 'get-by-id', String(id)]));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).video.source_vid, 'BV1');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('videos get-by-id：id 非数字 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['videos', 'get-by-id', 'abc']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /<id> 不是合法数字: abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videos get-by-id：id 不存在 → NOT_FOUND 退 5', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['videos', 'get-by-id', '99999']));
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
