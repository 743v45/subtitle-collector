// creator_uid 过滤（/api/videos?creator_uid=X）：popup/web 按 B 站 mid 直查 UP 已采集合。
// 设计依据：docs/superpowers/specs/2026-08-19-upper-all-videos-batch-design.md §阶段一。
// db 层（listVideosFiltered）+ query 解析层（parseVideoFilter）双层验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from './migrate.js';
import { listVideosFiltered } from './advanced.js';
import { parseVideoFilter } from '../http/filter.js';

function setupDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'collector-creator-uid-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const now = Date.now();
  const ins = db.prepare(
    "INSERT INTO creators (source, source_uid, name, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  ins.run('bilibili', '296399504', 'UP甲', now, now);
  ins.run('bilibili', '1296399504', 'UP乙', now, now); // 前缀包含陷阱：LIKE '%296399504%' 会误命中
  ins.run('youtube', '296399504', '同uid跨源', now, now); // 跨源同 uid：不 source 收窄应命中，source=bilibili 应排除
  const vid = db.prepare(
    "INSERT INTO videos (source, source_vid, creator_id, title, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const byUid = db.prepare('SELECT id FROM creators WHERE source = ? AND source_uid = ?');
  const a = (byUid.get('bilibili', '296399504') as { id: number }).id;
  const b = (byUid.get('bilibili', '1296399504') as { id: number }).id;
  const y = (byUid.get('youtube', '296399504') as { id: number }).id;
  vid.run('bilibili', 'BV1aa411c7mD', a, '甲的视频1', now, now);
  vid.run('bilibili', 'BV1bb411c7mD', a, '甲的视频2', now, now);
  vid.run('bilibili', 'BV1cc411c7mD', b, '乙的视频', now, now);
  vid.run('youtube', 'dQw4w9WgXcQ', y, '跨源视频', now, now);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('creator_uid 精确过滤：命中 UP 甲两条，不误命中前缀包含的 UP 乙', () => {
  const { db, cleanup } = setupDb();
  try {
    const r = listVideosFiltered(db, { creator_uid: '296399504' });
    assert.equal(r.total, 3); // 甲×2 + youtube 同 uid×1（未按 source 收窄）
    const bvids = r.items.map((x) => x.source_vid).sort();
    assert.deepEqual(bvids, ['BV1aa411c7mD', 'BV1bb411c7mD', 'dQw4w9WgXcQ']);
  } finally { cleanup(); }
});

test('creator_uid + source 联合：只命中 B 站该 UP 的视频', () => {
  const { db, cleanup } = setupDb();
  try {
    const r = listVideosFiltered(db, { creator_uid: '296399504', source: 'bilibili' });
    assert.equal(r.total, 2);
    assert.ok(r.items.every((x) => x.source_vid.startsWith('BV')));
  } finally { cleanup(); }
});

test('creator_uid 无此 UP：空结果不报错', () => {
  const { db, cleanup } = setupDb();
  try {
    const r = listVideosFiltered(db, { creator_uid: '999' });
    assert.equal(r.total, 0);
  } finally { cleanup(); }
});

test('parseVideoFilter：creator_uid 解析（空串忽略）', () => {
  const f = parseVideoFilter(new URLSearchParams('creator_uid=296399504&source=bilibili'));
  assert.equal(f.creator_uid, '296399504');
  assert.equal(f.source, 'bilibili');
  const fEmpty = parseVideoFilter(new URLSearchParams('creator_uid='));
  assert.equal(fEmpty.creator_uid, undefined);
});
