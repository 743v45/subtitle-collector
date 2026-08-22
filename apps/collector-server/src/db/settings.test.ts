import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from './migrate.js';
import { getTagPriority, setTagPriority } from './settings.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-settings-test-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return { db, dir };
}

test('getTagPriority：缺行回落默认 manual>batch>bili>season>ai', () => {
  const { db, dir } = freshDb();
  try {
    assert.deepEqual(getTagPriority(db), ['manual', 'batch', 'bili', 'season', 'ai']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setTagPriority：写读往返 + 持久化', () => {
  const { db, dir } = freshDb();
  try {
    const custom = ['ai', 'manual', 'bili', 'season', 'batch'];
    setTagPriority(db, custom);
    assert.deepEqual(getTagPriority(db), custom);
    // 重复写覆盖（upsert）
    setTagPriority(db, ['batch', 'ai', 'manual', 'season', 'bili']);
    assert.deepEqual(getTagPriority(db), ['batch', 'ai', 'manual', 'season', 'bili']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setTagPriority：非五档精确排列抛错', () => {
  const { db, dir } = freshDb();
  try {
    assert.throws(() => setTagPriority(db, ['manual', 'batch', 'bili', 'season']));          // 少一档
    assert.throws(() => setTagPriority(db, ['manual', 'batch', 'bili', 'season', 'ai', 'x'])); // 多一项
    assert.throws(() => setTagPriority(db, ['manual', 'batch', 'bili', 'season', 'season'])); // 重复
    assert.throws(() => setTagPriority(db, 'manual'));                                         // 非数组
    assert.throws(() => setTagPriority(db, ['manual', 'batch', 'bili', 'season', 'nope']));   // 非法档名
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('getTagPriority：DB 值损坏/非法 → 回落默认不炸', () => {
  const { db, dir } = freshDb();
  try {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tag_priority', '{broken json');
    assert.deepEqual(getTagPriority(db), ['manual', 'batch', 'bili', 'season', 'ai']);
    // 合法 JSON 但非排列
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('["only","manual"]', 'tag_priority');
    assert.deepEqual(getTagPriority(db), ['manual', 'batch', 'bili', 'season', 'ai']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('getTagPriority：四档时代存量（无 season）→ 回落新默认（自动升级）', () => {
  const { db, dir } = freshDb();
  try {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tag_priority', '["ai","manual","bili","batch"]');
    assert.deepEqual(getTagPriority(db), ['manual', 'batch', 'bili', 'season', 'ai']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 采集超时配置（2026-08-22，按平台分档）──
import { getCollectTimeout, setCollectTimeout, DEFAULT_COLLECT_TIMEOUT_MS } from './settings.js';

test('getCollectTimeout：缺行回落默认 {bilibili:90s, youtube:45s}', () => {
  const { db, dir } = freshDb();
  try {
    assert.deepEqual(getCollectTimeout(db), DEFAULT_COLLECT_TIMEOUT_MS);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setCollectTimeout：写读往返 + 覆盖（upsert）', () => {
  const { db, dir } = freshDb();
  try {
    const custom = { bilibili: 120_000, youtube: 90_000 };
    setCollectTimeout(db, custom);
    assert.deepEqual(getCollectTimeout(db), custom);
    setCollectTimeout(db, { bilibili: 90_000, youtube: 180_000 });
    assert.deepEqual(getCollectTimeout(db), { bilibili: 90_000, youtube: 180_000 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setCollectTimeout：缺键/非整数/越界（<15s 或 >600s）抛错', () => {
  const { db, dir } = freshDb();
  try {
    assert.throws(() => setCollectTimeout(db, { bilibili: 90_000 }));                    // 缺 youtube
    assert.throws(() => setCollectTimeout(db, { bilibili: 10_000, youtube: 45_000 }));  // < 15s
    assert.throws(() => setCollectTimeout(db, { bilibili: 90_000, youtube: 601_000 })); // > 600s
    assert.throws(() => setCollectTimeout(db, { bilibili: '90s', youtube: 45_000 }));   // 非数字
    assert.throws(() => setCollectTimeout(db, null));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('getCollectTimeout：DB 值损坏/单项越界 → 逐项回落默认不炸', () => {
  const { db, dir } = freshDb();
  try {
    db.prepare("INSERT INTO settings (key, value) VALUES ('collect_timeout_ms', 'not-json')").run();
    assert.deepEqual(getCollectTimeout(db), DEFAULT_COLLECT_TIMEOUT_MS);
    // 单项越界：该项回落默认,另一项保留
    db.prepare("UPDATE settings SET value = ? WHERE key = 'collect_timeout_ms'")
      .run(JSON.stringify({ bilibili: 120_000, youtube: 999_999 }));
    assert.deepEqual(getCollectTimeout(db), { bilibili: 120_000, youtube: 45_000 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
