// backup 模块测试：VACUUM INTO 一致性快照 / 文件名 / 滚动清理 / 失败路径。
// 背景（2026-08-24 两次 SQLITE_CORRUPT）：备份空窗 14h 导致坏页数据不可恢复；内置容器内
// 定时备份把空窗压到 1h，且 VACUUM INTO 自带事务一致性（无需暂停写入）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from './migrate.js';
import { ingestVideo } from './ingest.js';
import { backupFileName, backupOnce, pruneBackups, attachBackupTimer } from './backup.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-backup-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return { db, dir };
}

test('backupOnce：VACUUM INTO 产物可独立打开、数据完整、integrity ok', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1', title: '甲', creator: { source_uid: '1', name: 'UP' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [{ lan: 'zh-CN', lan_doc: '中文', track_type: 0, versions: [{ origin: 'external', payload: { body: [] } }] }],
    });
    const r = backupOnce(db, join(dir, 'test.db'), new Date('2026-08-24T23:05:07'));
    assert.match(r.path, /backups[/]bilibili-collector-backup-20260824-230507\.db$/);
    assert.ok(r.sizeBytes > 0);
    // 产物独立可读：数据在、结构完整
    const snap = new Database(r.path, { readonly: true });
    try {
      assert.equal(snap.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal((snap.prepare("SELECT COUNT(*) c FROM videos WHERE source_vid = 'BV1'").get() as { c: number }).c, 1);
    } finally { snap.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backupFileName：时间各段补零、格式稳定（排序即时间序）', () => {
  assert.equal(backupFileName(new Date(2026, 0, 2, 3, 4, 5)), 'bilibili-collector-backup-20260102-030405.db');
  assert.equal(backupFileName(new Date(2026, 11, 31, 23, 59, 59)), 'bilibili-collector-backup-20261231-235959.db');
});

test('backupOnce：目标已存在（同秒重跑）→ 抛错可观察，不静默覆盖', () => {
  const { db, dir } = freshDb();
  try {
    const now = new Date('2026-08-24T23:05:07');
    backupOnce(db, join(dir, 'test.db'), now);
    assert.throws(() => backupOnce(db, join(dir, 'test.db'), now), /already exists|exists/i);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pruneBackups：保留最近 keep 份删旧；非备份文件不动；目录不存在静默', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-prune-'));
  try {
    for (let i = 1; i <= 30; i++) {
      writeFileSync(join(dir, `bilibili-collector-backup-20260824-2305${String(i).padStart(2, '0')}.db`), '');
    }
    writeFileSync(join(dir, 'unrelated.txt'), 'x'); // 非备份名：不删
    const pruned = pruneBackups(dir, 24);
    assert.equal(pruned.length, 6, '30 份保 24 删最旧 6');
    assert.match(pruned[0], /230501\.db$/);
    const rest = readdirSync(dir).filter((n) => n.endsWith('.db'));
    assert.equal(rest.length, 24);
    assert.equal(rest[0], 'bilibili-collector-backup-20260824-230507.db', '最旧的留存是第 7 新');
    assert.equal(rest[23], 'bilibili-collector-backup-20260824-230530.db', '最新保留');
    assert.ok(existsSync(join(dir, 'unrelated.txt')));
    // keep 大于存量：全留不炸
    assert.deepEqual(pruneBackups(dir, 100), []);
    // 目录不存在：静默空
    assert.deepEqual(pruneBackups(join(dir, 'nope'), 24), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('attachBackupTimer：启动即备一次 + interval 后再备（env 注入短间隔）', async () => {
  const { db, dir } = freshDb();
  process.env.COLLECTOR_BACKUP_INTERVAL_MS = '80';
  try {
    attachBackupTimer(db, join(dir, 'test.db'));
    await new Promise((r) => setTimeout(r, 30)); // 启动备份同步完成后
    let files = readdirSync(join(dir, 'backups')).filter((n) => n.endsWith('.db'));
    assert.equal(files.length, 1, '启动备份立即产生一份');
    // 文件名精确到秒：interval 触发若与启动备份同秒会撞已存在文件（VACUUM INTO 报错、文件不增）。
    // 等 1.1s 跨秒后必然产生新文件名的第二份。
    await new Promise((r) => setTimeout(r, 1100));
    files = readdirSync(join(dir, 'backups')).filter((n) => n.endsWith('.db'));
    assert.ok(files.length >= 2, '定时器触发追加备份');
  } finally {
    delete process.env.COLLECTOR_BACKUP_INTERVAL_MS;
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
