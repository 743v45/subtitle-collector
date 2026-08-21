import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { amendLateResult, amendLateIngest } from './amend.js';

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

// 直插 videos + subtitle_tracks（不经 ingestVideo）：改判只关心库里已有的轨数（COUNT），不走入库逻辑
function seedVideoWithTracks(db: ReturnType<typeof openDb>, source: 'bilibili' | 'youtube', vid: string, nTracks: number): void {
  const info = db.prepare(
    'INSERT INTO videos (source, source_vid, title, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(source, vid, 't', Date.now(), Date.now());
  const ins = db.prepare('INSERT INTO subtitle_tracks (video_id, lan, track_type) VALUES (?, ?, 2)');
  for (let i = 0; i < nTracks; i++) ins.run(Number(info.lastInsertRowid), `lan${i}`);
}

// 迟到回执改判：命令超时落 failed 后扩展实际完成（result 迟到/INGEST 可能已落库）→ 改判 succeeded。
// 不改判的：迟到失败回执、非超时失败、已 succeeded 的任务。
// 迟到 INGEST 改判：扩展自限超时落 failed 后无回执可等，被动 INGEST 落库证明实际完成 → 改判。

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

test('amendLateIngest：扩展自限超时文案（秒数可变）→ 改判 succeeded 并写回执形 result', () => {
  const { db, dir } = freshDb();
  try {
    seedVideoWithTracks(db, 'youtube', 'hX7yG1KVYhI', 3);
    // 秒数随 timeoutMs 变（无进展窗口调整后不再是 45），前缀匹配须吃住任意秒数
    const id = seedTask(db, 'youtube', 'hX7yG1KVYhI', 'failed', 'YouTube 采集超时（120s）');
    const amended = amendLateIngest(db, { source: 'youtube', source_vid: 'hX7yG1KVYhI', inserted_tracks: 3 });
    assert.equal(amended, id);
    const t = db.prepare('SELECT status, result, error, finished_at FROM collect_tasks WHERE id = ?').get(id) as any;
    assert.equal(t.status, 'succeeded');
    assert.equal(t.error, null);
    assert.ok(t.finished_at != null);
    const r = JSON.parse(t.result);
    assert.equal(r.videoId, 'hX7yG1KVYhI'); // 与 YouTube 真实回执同键（resultSummary 读 captured/tracks）
    assert.equal(r.captured, 3);            // 本次 inserted_tracks
    assert.equal(r.tracks, 3);              // 该视频库内当前总轨数
    assert.equal(r.navigated, true);
    assert.equal(r.reused, false);
    assert.equal(r.amended, 'late-ingest'); // 来源标记，区别于真实回执
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('amendLateIngest：命令超时文案同样可改判（bilibili 用 bvid 键）', () => {
  const { db, dir } = freshDb();
  try {
    seedVideoWithTracks(db, 'bilibili', 'BV1aa411c7mD', 1);
    const id = seedTask(db, 'bilibili', 'BV1aa411c7mD', 'failed', '扩展执行超时');
    assert.equal(amendLateIngest(db, { source: 'bilibili', source_vid: 'BV1aa411c7mD', inserted_tracks: 1 }), id);
    const r = JSON.parse((db.prepare('SELECT result FROM collect_tasks WHERE id = ?').get(id) as any).result);
    assert.equal(r.bvid, 'BV1aa411c7mD'); // B 站真实回执是 bvid 键
    assert.equal(r.captured, 1);
    assert.equal(r.tracks, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('amendLateIngest：普通失败文案（请求超时）不改判——不以「YouTube 采集超时（」开头，LIKE 不误中', () => {
  const { db, dir } = freshDb();
  try {
    seedVideoWithTracks(db, 'youtube', 'gaDdrDdczO4', 2);
    // 恰含「超时」二字的普通业务失败文案：若用子串匹配会误改判，前缀匹配不会
    const id = seedTask(db, 'youtube', 'gaDdrDdczO4', 'failed', '请求超时');
    assert.equal(amendLateIngest(db, { source: 'youtube', source_vid: 'gaDdrDdczO4', inserted_tracks: 2 }), null);
    const t = db.prepare('SELECT status, result FROM collect_tasks WHERE id = ?').get(id) as any;
    assert.equal(t.status, 'failed'); // 别人的失败行保持 failed
    assert.equal(t.result, null);     // 也不写入他人的 result
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('amendLateIngest：succeeded/limited 任务不被动；无产出（inserted_tracks=0）不触发', () => {
  const { db, dir } = freshDb();
  try {
    seedVideoWithTracks(db, 'youtube', 'gaDdrDdczO4', 1);
    // succeeded：已终态，迟到 INGEST 不得覆写其 result
    const okId = seedTask(db, 'youtube', 'gaDdrDdczO4', 'succeeded', null);
    // limited：非 failed 终态（受限），即使 error 恰为超时文案也不改判——受限 ≠ 采集完成
    const limitedId = seedTask(db, 'youtube', 'hX7yG1KVYhI', 'limited', 'YouTube 采集超时（45s）');
    assert.equal(amendLateIngest(db, { source: 'youtube', source_vid: 'gaDdrDdczO4', inserted_tracks: 2 }), null);
    assert.equal(amendLateIngest(db, { source: 'youtube', source_vid: 'hX7yG1KVYhI', inserted_tracks: 2 }), null);
    assert.equal((db.prepare('SELECT status FROM collect_tasks WHERE id = ?').get(okId) as any).status, 'succeeded');
    assert.equal((db.prepare('SELECT status FROM collect_tasks WHERE id = ?').get(limitedId) as any).status, 'limited');
    // 无产出：仅元信息入库 / 轨全部已存在，不证明任务实际完成
    const id = seedTask(db, 'youtube', 'zzzzzzzzzzz', 'failed', 'YouTube 采集超时（45s）');
    assert.equal(amendLateIngest(db, { source: 'youtube', source_vid: 'zzzzzzzzzzz', inserted_tracks: 0 }), null);
    assert.equal((db.prepare('SELECT status FROM collect_tasks WHERE id = ?').get(id) as any).status, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
