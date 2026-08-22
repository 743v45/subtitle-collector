// versions.ts commander 装配层测试：子进程跑真 CLI，覆盖 get action 成功 / ARGS / NOT_FOUND / DB_UNREADABLE。
// 纯函数（versionsGet）见 versions.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | versions get 成功 + id 非数字 ARGS + id 不存在 NOT_FOUND + DB 缺失 DB_UNREADABLE | 通过 | |

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

function setup(): { db: Database.Database; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-versions-cli-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '甲', creator: { source_uid: '1', name: 'UP' }, extra: {}, duration: 60, published_at: 1 },
    tracks: [{ lan: 'zh-Hans', track_type: 2, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 2, content: '文本' }] } }] }],
  });
  return { db, dbPath: join(dir, 'test.db'), dir };
}

test('versions get：合法 id 返回 payload（含 body），退 0', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const id = (db.prepare('SELECT id FROM subtitle_versions LIMIT 1').get() as { id: number }).id;
    const r = await cli(args(dbPath, ['versions', 'get', String(id)]));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.id, id);
    assert.equal(data.origin, 'external');
    assert.ok(Array.isArray(data.payload.body));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('versions get：id 非数字 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['versions', 'get', 'abc']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /<id> 不是合法数字: abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('versions get：id 不存在 → NOT_FOUND 退 5', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['versions', 'get', '99999']));
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
    assert.match(r.err, /version not found: id=99999/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('versions get：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const r = await cli(args(join(tmpdir(), 'cli-versions-no-such.db'), ['versions', 'get', '1']));
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
});
