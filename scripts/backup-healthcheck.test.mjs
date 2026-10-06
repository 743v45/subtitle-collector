// 覆盖 backup-healthcheck.mjs 的纯函数层：.db 识别、ls 输出解析、mtime 阈值判定、
// 目录扫描（无 .db/目录缺失的 fail 信号）、最新副本选取、快照盘点、告警文案。
// 巡检脚本是「备份链路活着」的守门员，判定逻辑必须被测试保护（CLAUDE.md 测试质量政策）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDbFileName,
  parseLsNames,
  checkAge,
  pickNewestFile,
  scanDbDir,
  summarizeSnapshots,
  buildWebhookText,
  formatDuration,
  formatStamp,
} from './backup-healthcheck.mjs';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ── 时新性判定 ──

test('checkAge:mtime 距今 2 天内（47.5h）→ 过 48h 阈值', () => {
  const now = Date.now();
  const ageMs = 2 * DAY - 0.5 * HOUR; // 2 天前但留 30min 余量——恰 48h 整落在边界上算超龄（严格 <）
  const verdict = checkAge(now - ageMs, now, 48 * HOUR);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ageMs, ageMs);
});

test('checkAge:mtime 距今 49h → 超 48h 阈值 fail', () => {
  const now = Date.now();
  const verdict = checkAge(now - 49 * HOUR, now, 48 * HOUR);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.maxAgeMs, 48 * HOUR);
});

test('checkAge:恰在阈值上（age === max）→ 判超龄（严格小于,宁误报不漏报）', () => {
  const now = 1_000_000_000_000;
  const verdict = checkAge(now - 30 * 60 * 1000, now, 30 * 60 * 1000);
  assert.equal(verdict.ok, false);
});

test('checkAge:mtime 在未来（时钟偏斜）→ 负 age 视为时新', () => {
  const now = Date.now();
  const verdict = checkAge(now + 60 * 1000, now, 30 * 60 * 1000);
  assert.equal(verdict.ok, true);
});

// ── 最新文件选取 ──

test('pickNewestFile:多条目按 mtime 选最新', () => {
  const newest = pickNewestFile([
    { name: 'a.db', mtimeMs: 100, path: '/x/a.db' },
    { name: 'c.db', mtimeMs: 300, path: '/x/c.db' },
    { name: 'b.db', mtimeMs: 200, path: '/x/b.db' },
  ]);
  assert.equal(newest.name, 'c.db');
  assert.equal(newest.mtimeMs, 300);
});

test('pickNewestFile:空数组返回 null（目录无 .db 的 fail 信号）', () => {
  assert.equal(pickNewestFile([]), null);
});

// ── 目录扫描（临时目录夹具）──

/** 建临时目录,写假 .db 文件并回拨 mtime（utimesSync 模拟老备份,不需真 sqlite 内容——扫描只 stat）。 */
function makeTempDirWithFiles(specs) {
  const dir = mkdtempSync(join(tmpdir(), 'bhc-test-'));
  const now = Date.now();
  for (const [name, ageMs] of specs) {
    const p = join(dir, name);
    writeFileSync(p, 'fake');
    if (ageMs !== undefined) {
      const t = new Date(now - ageMs);
      utimesSync(p, t, t);
    }
  }
  return dir;
}

test('scanDbDir:只收 .db,按新→旧排序,附 path 与 size', () => {
  const dir = makeTempDirWithFiles([
    ['old.db', 10 * DAY],
    ['newer.db', 1 * DAY],
    ['notes.txt'],
  ]);
  try {
    const entries = scanDbDir(dir);
    assert.deepEqual(entries.map((e) => e.name), ['newer.db', 'old.db']);
    assert.equal(entries[0].path, join(dir, 'newer.db'));
    assert.ok(entries[0].sizeBytes > 0);
    assert.ok(entries[0].mtimeMs > entries[1].mtimeMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanDbDir:目录存在但无 .db → 返回空数组（与目录缺失区分）', () => {
  const dir = makeTempDirWithFiles([['readme.md']]);
  try {
    const entries = scanDbDir(dir);
    assert.deepEqual(entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanDbDir:目录不存在 → 返回 null（fail 信号,区别于「存在但空」）', () => {
  assert.equal(scanDbDir(join(tmpdir(), `bhc-not-exist-${Date.now()}`)), null);
});

test('scanDbDir 端到端:假 .db mtime 2 天内 → 过 48h 阈值判定', () => {
  const dir = makeTempDirWithFiles([['bilibili-collector-backup-fresh.db', 2 * DAY - 0.5 * HOUR]]);
  try {
    const newest = pickNewestFile(scanDbDir(dir));
    const verdict = checkAge(newest.mtimeMs, Date.now(), 48 * HOUR);
    assert.equal(verdict.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanDbDir 端到端:假 .db mtime 49h → 48h 阈值判 fail(异地导出停跑的实跑场景)', () => {
  const dir = makeTempDirWithFiles([['bilibili-collector-backup-stale.db', 49 * HOUR]]);
  try {
    const newest = pickNewestFile(scanDbDir(dir));
    const verdict = checkAge(newest.mtimeMs, Date.now(), 48 * HOUR);
    assert.equal(verdict.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanDbDir 端到端:8 天前旧份(2026-10-04 实跑时群晖唯一现存份的形态)→ fail', () => {
  const dir = makeTempDirWithFiles([['bilibili-collector-backup-20260824-231240.db', 8 * DAY]]);
  try {
    const newest = pickNewestFile(scanDbDir(dir));
    const verdict = checkAge(newest.mtimeMs, Date.now(), 48 * HOUR);
    assert.equal(verdict.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 快照盘点（信息项）──

test('summarizeSnapshots:份数/最老 mtime/总字节', () => {
  const sum = summarizeSnapshots([
    { name: 'a.db', mtimeMs: 500, sizeBytes: 100 },
    { name: 'b.db', mtimeMs: 900, sizeBytes: 250 },
  ]);
  assert.deepEqual(sum, { count: 2, oldestMtimeMs: 500, totalBytes: 350 });
});

test('summarizeSnapshots:空目录 → 零值形态（不抛错,信息项恒不 fail）', () => {
  assert.deepEqual(summarizeSnapshots([]), { count: 0, oldestMtimeMs: null, totalBytes: 0 });
});

// ── 解析与文案 ──

test('parseLsNames:docker ls -t 输出按行拆分,滤空行/尾换行/首尾空白', () => {
  assert.deepEqual(
    parseLsNames('/data/backups/b-2.db\n/data/backups/b-1.db\n\n'),
    ['/data/backups/b-2.db', '/data/backups/b-1.db'],
  );
});

test('isDbFileName:.db 后缀才认（.db-wal 这类伴生文件不算副本）', () => {
  assert.equal(isDbFileName('x.db'), true);
  assert.equal(isDbFileName('x.db-wal'), false);
  assert.equal(isDbFileName('x.txt'), false);
});

test('buildWebhookText:飞书告警文案格式——[backup-healthcheck] 检查名: 原因', () => {
  assert.equal(
    buildWebhookText('offsite-freshness', '超 48h 阈值'),
    '[backup-healthcheck] offsite-freshness: 超 48h 阈值',
  );
});

test('formatDuration:三段位——秒/分/时', () => {
  assert.equal(formatDuration(500), '0.5s');
  assert.equal(formatDuration(90_000), '1.5min');
  assert.equal(formatDuration(49 * HOUR), '49.0h');
});

test('formatStamp:ISO 戳转 YYYY-MM-DD HH:mm:SSZ(日志可读形态)', () => {
  assert.equal(formatStamp(Date.UTC(2026, 9, 4, 3, 52, 10)), '2026-10-04 03:52:10Z');
});
