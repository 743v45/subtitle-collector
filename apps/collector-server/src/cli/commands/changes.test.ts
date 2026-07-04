// changes.ts 纯处理函数单测：临时文件 DB + ingestVideo 样本，断言结构化输出。
// 跑法（不在 pnpm test glob 内）：cd apps/collector-server && node --test --import tsx src/cli/commands/changes.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | changesList 纯函数（entity/field/since-until/分页） | 通过 | 临时 DB 无副作用；样本对齐 db/advanced.test.ts |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { changesList } from './changes.js';

const T = 1_700_000_000_000; // 基准毫秒时间戳

// 样本库：1 视频 + 1 UP，3 条 change_log（确定性 changed_at，覆盖 entity/field/时间维度）。
function setup(): { db: Database.Database; dir: string; ids: Record<string, number> } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-changes-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);

  ingestVideo(db, {
    source: 'bilibili',
    video: {
      source_vid: 'BV1', title: '标题A',
      creator: { source_uid: '1', name: 'Alpha UP' },
      extra: { tid: 17, tname: '单机游戏' }, duration: 600, published_at: T + 1000,
    },
    tracks: [],
  });

  const idOf = (sv: string) => (db.prepare('SELECT id FROM videos WHERE source_vid = ?').get(sv) as { id: number }).id;
  const creatorId = (uid: string) => (db.prepare('SELECT id FROM creators WHERE source_uid = ?').get(uid) as { id: number }).id;
  const v1 = idOf('BV1');
  const alpha = creatorId('1');
  const ids = { v1, alpha };

  const logIns = db.prepare(
    'INSERT INTO change_log (entity, entity_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  // 3 条：video.title@T+50 / video.duration@T+150 / creator.name@T+10
  logIns.run('video', v1, 'title', '旧标题', '标题A', T + 50);
  logIns.run('video', v1, 'duration', '500', '600', T + 150);
  logIns.run('creator', alpha, 'name', null, 'Alpha UP', T + 10);

  return { db, dir, ids };
}

const fields = (items: Array<{ field: string }>) => items.map((i) => i.field);

test('changesList: 默认返回 {total,page,size,items}，按 changed_at desc + id desc', () => {
  const { db, dir } = setup();
  try {
    const r = changesList(db, {});
    assert.equal(r.total, 3);
    assert.equal(r.page, 1);
    assert.equal(r.size, 20);
    // changed_at desc：T+150(duration) > T+50(title) > T+10(name)
    assert.deepEqual(fields(r.items), ['duration', 'title', 'name']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changesList: entity / entity-id / field 过滤', () => {
  const { db, dir, ids } = setup();
  try {
    assert.equal(changesList(db, { entity: 'video' }).total, 2);
    assert.equal(changesList(db, { entity: 'creator' }).total, 1);
    assert.equal(changesList(db, { entity: 'video', entityId: ids.v1 }).total, 2);
    assert.equal(changesList(db, { field: 'title' }).total, 1);
    assert.deepEqual(fields(changesList(db, { field: 'title' }).items), ['title']);
    assert.ok(ids.v1 > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changesList: since/until 比对 changed_at（毫秒）', () => {
  const { db, dir } = setup();
  try {
    assert.equal(changesList(db, { since: T + 100 }).total, 1); // 仅 T+150 duration
    assert.deepEqual(fields(changesList(db, { since: T + 100 }).items), ['duration']);
    assert.equal(changesList(db, { until: T + 20 }).total, 1); // 仅 T+10 name
    assert.deepEqual(fields(changesList(db, { until: T + 20 }).items), ['name']);
    assert.equal(changesList(db, { since: T + 40, until: T + 100 }).total, 1); // T+50 title
    assert.deepEqual(fields(changesList(db, { since: T + 40, until: T + 100 }).items), ['title']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changesList: 分页 page/size', () => {
  const { db, dir } = setup();
  try {
    const p1 = changesList(db, { page: 1, size: 2 });
    assert.equal(p1.items.length, 2);
    assert.equal(p1.total, 3);
    assert.deepEqual(fields(p1.items), ['duration', 'title']);
    const p2 = changesList(db, { page: 2, size: 2 });
    assert.equal(p2.items.length, 1);
    assert.deepEqual(fields(p2.items), ['name']);
    const p3 = changesList(db, { page: 3, size: 2 });
    assert.equal(p3.items.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changesList: page/size 非正数或缺省 → 默认 1/20', () => {
  const { db, dir } = setup();
  try {
    const r = changesList(db, { page: 0, size: -1 });
    assert.equal(r.page, 1);
    assert.equal(r.size, 20);
    assert.equal(r.items.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
