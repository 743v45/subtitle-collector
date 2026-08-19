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
