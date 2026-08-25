// changes.ts commander 装配层测试：子进程跑真 CLI，覆盖 list action 成功 + parseNum/parseTime 非法 +
// openDbOrEmit DB 缺失。纯函数（changesList）见 changes.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | changes list 成功（entity 过滤）+ ARGS（entity-id/since）+ DB_UNREADABLE | 通过 | ingest 自带 change_log 种子 |
// | R2 | 排序：--desc=false 升序断言 + 非法 --sort ARGS 退 2 | 通过 | 2026-08-25 全端点排序；pnpm qa 全绿 |

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
  const dir = mkdtempSync(join(tmpdir(), 'cli-changes-cli-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  // ingest 会写 change_log：creator created + video created（作为天然种子数据）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '甲', creator: { source_uid: '1', name: 'UP' }, extra: {}, duration: 60, published_at: 1 },
    tracks: [],
  });
  return { db, dbPath: join(dir, 'test.db'), dir };
}

test('changes list：返回 {total,page,size,items}（ingest 产生的 change_log），退 0', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['changes', 'list']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.ok(data.total >= 2, `应含 creator/video created 记录: ${JSON.stringify(data)}`);
    assert.equal(data.page, 1);
    assert.equal(data.size, 20);
    const entities = data.items.map((i: { entity: string }) => i.entity);
    assert.ok(entities.includes('creator') && entities.includes('video'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// --source 平台过滤（2026-08-24）：经实体行判定；items 带派生 source 列
test('changes list --source：平台过滤命中 + items 带 source 列', async () => {
  const { db, dir, dbPath } = setup();
  try {
    // 追加 YouTube 种子：bilibili 2 条 + youtube 2 条
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'yt1', title: 'yt', creator: { source_uid: 'UC1', name: 'ch' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [],
    });
    const all = await cli(args(dbPath, ['changes', 'list', '--size', '50']));
    const allData = JSON.parse(all.out);
    assert.equal(allData.total, 4);
    assert.ok(allData.items.every((i: { source: string }) => i.source === 'bilibili' || i.source === 'youtube'), '派生 source 列随行带出');

    const bili = await cli(args(dbPath, ['changes', 'list', '--source', 'bilibili']));
    const biliData = JSON.parse(bili.out);
    assert.equal(biliData.total, 2);
    assert.ok(biliData.items.every((i: { source: string }) => i.source === 'bilibili'));

    const yt = await cli(args(dbPath, ['changes', 'list', '--source', 'youtube']));
    assert.equal(JSON.parse(yt.out).total, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('changes list：--entity 过滤命中', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['changes', 'list', '--entity', 'video']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.ok(data.total >= 1);
    assert.ok(data.items.every((i: { entity: string }) => i.entity === 'video'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changes list：--entity-id 非数字 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['changes', 'list', '--entity-id', 'abc']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--entity-id 不是合法数字: abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changes list：--since 非法时间 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['changes', 'list', '--since', 'bad-date']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--since/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changes list：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const r = await cli(args(join(tmpdir(), 'cli-changes-no-such.db'), ['changes', 'list']));
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
});

// ── 2026-08-25 全端点排序：--sort/--desc 透传 + 非法 --sort ARGS ──
test('changes list：--desc=false 升序（changed_at 最旧在前）；--sort 非法 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, ['changes', 'list', '--desc=false']));
    assert.equal(r.code, 0);
    const items = JSON.parse(r.out).items as Array<{ changed_at: number }>;
    assert.ok(items.length >= 2);
    // 升序：changed_at 非降
    for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].changed_at <= items[i].changed_at, '升序 changed_at 非降');
    // 非法 sort 键 → ARGS 退 2（单键端点）
    const bad = await cli(args(dbPath, ['changes', 'list', '--sort', 'bogus']));
    assert.equal(bad.code, 2);
    assert.match(bad.err, /非法 --sort: bogus（可选: changed_at）/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
