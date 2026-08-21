import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { amendLateResult } from './amend.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-amend-'));
  const db = openDb(join(dir, 't.db'));
  migrate(db);
  return { db, dir };
}

function seedTask(db: ReturnType<typeof openDb>, source: 'bilibili' | 'youtube', vid: string, status: string, error: string | null): number {
  const info = db.prepare(
    'INSERT INTO collect_tasks (source, source_vid, url, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(source, vid, 'https://x', status, error, Date.now());
  return Number(info.lastInsertRowid);
}

// 迟到回执改判：命令超时落 failed 后扩展实际完成（result 迟到/INGEST 可能已落库）→ 改判 succeeded。
// 不改判的：迟到失败回执、非超时失败、已 succeeded 的任务。

test('amendLateResult：ok 迟到回执 → 超时 failed 改判 succeeded 并带 result', () => {
  const { db, dir } = freshDb();
  try {
    const id = seedTask(db, 'youtube', 'gaDdrDdczO4', 'failed', '扩展执行超时');
    const amended = amendLateResult(db, { videoId: 'gaDdrDdczO4' }, { ok: true, data: { captured: 2 } });
    assert.equal(amended, id); // 返回改判任务 id（调用方据此推送 task-update）
    const t = db.prepare('SELECT status, result, error FROM collect_tasks WHERE id = ?').get(id) as any;
    assert.equal(t.status, 'succeeded');
    assert.equal(t.error, null);
    assert.equal(JSON.parse(t.result).captured, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('amendLateResult：B 站 bvid 定位；仅匹配最近一条超时失败', () => {
  const { db, dir } = freshDb();
  try {
    seedTask(db, 'bilibili', 'BV1aa411c7mD', 'failed', '扩展离线');
    const recent = seedTask(db, 'bilibili', 'BV1aa411c7mD', 'failed', '扩展执行超时');
    assert.equal(amendLateResult(db, { bvid: 'BV1aa411c7mD' }, { ok: true, data: {} }), recent);
    const rows = db.prepare('SELECT id, status FROM collect_tasks ORDER BY id').all() as Array<{ id: number; status: string }>;
    const old = rows.find((r) => r.id !== recent)!;
    assert.equal(old.status, 'failed'); // 非超时失败（离线）不改判
    assert.equal(rows.find((r) => r.id === recent)!.status, 'succeeded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('amendLateResult：error 含「超时」子串但非超时失败文案 → 不改判', () => {
  const { db, dir } = freshDb();
  try {
    // 普通失败回执的扩展原文（如「请求超时」）恰含「超时」二字，不得被子串匹配误改判成功
    const id = seedTask(db, 'youtube', 'gaDdrDdczO4', 'failed', '请求超时');
    assert.equal(amendLateResult(db, { videoId: 'gaDdrDdczO4' }, { ok: true, data: { captured: 1 } }), null);
    const t = db.prepare('SELECT status, result FROM collect_tasks WHERE id = ?').get(id) as any;
    assert.equal(t.status, 'failed'); // 别人的失败行保持 failed
    assert.equal(t.result, null);     // 也不写入他人的 result
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('amendLateResult：迟到失败回执 / 无匹配任务 / 无定位参数 → 不改判', () => {
  const { db, dir } = freshDb();
  try {
    const id = seedTask(db, 'youtube', 'gaDdrDdczO4', 'failed', '扩展执行超时');
    assert.equal(amendLateResult(db, { videoId: 'gaDdrDdczO4' }, { ok: false, error: 'x' }), null); // 迟到失败
    assert.equal(amendLateResult(db, { videoId: 'zzzzzzzzzzz' }, { ok: true }), null); // 无匹配
    assert.equal(amendLateResult(db, {}, { ok: true }), null); // 无法定位
    const t = db.prepare('SELECT status FROM collect_tasks WHERE id = ?').get(id) as any;
    assert.equal(t.status, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
