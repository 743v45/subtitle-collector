// settings.ts 单测：标签优先级（六档精确排列）+ 采集超时三平台分档（缺行/损坏/单项越界逐项回落）。
// 夹具：freshDb 临时库（真实迁移）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | tag_priority 读写/回落 | 通过 | |
// | R2 | collect_timeout_ms 三键化（douyin 档 + 两键存量行回落默认） | 通过 | 2026-08-29 S2 抖音平台化 |

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
    assert.deepEqual(getTagPriority(db), ['manual', 'batch', 'bili', 'season', 'ai', 'system']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setTagPriority：写读往返 + 持久化', () => {
  const { db, dir } = freshDb();
  try {
    const custom = ['ai', 'manual', 'bili', 'season', 'batch', 'system'];
    setTagPriority(db, custom);
    assert.deepEqual(getTagPriority(db), custom);
    // 重复写覆盖（upsert）
    setTagPriority(db, ['batch', 'ai', 'manual', 'season', 'system', 'bili']);
    assert.deepEqual(getTagPriority(db), ['batch', 'ai', 'manual', 'season', 'system', 'bili']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setTagPriority：非六档精确排列抛错', () => {
  const { db, dir } = freshDb();
  try {
    assert.throws(() => setTagPriority(db, ['manual', 'batch', 'bili', 'season', 'ai']));          // 少一档
    assert.throws(() => setTagPriority(db, ['manual', 'batch', 'bili', 'season', 'ai', 'system', 'x'])); // 多一项
    assert.throws(() => setTagPriority(db, ['manual', 'batch', 'bili', 'season', 'system', 'system'])); // 重复
    assert.throws(() => setTagPriority(db, 'manual'));                                         // 非数组
    assert.throws(() => setTagPriority(db, ['manual', 'batch', 'bili', 'season', 'ai', 'nope']));   // 非法档名
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('getTagPriority：DB 值损坏/非法 → 回落默认不炸', () => {
  const { db, dir } = freshDb();
  try {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tag_priority', '{broken json');
    assert.deepEqual(getTagPriority(db), ['manual', 'batch', 'bili', 'season', 'ai', 'system']);
    // 合法 JSON 但非排列
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('["only","manual"]', 'tag_priority');
    assert.deepEqual(getTagPriority(db), ['manual', 'batch', 'bili', 'season', 'ai', 'system']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('getTagPriority：四档时代存量（无 season）→ 回落新默认（自动升级）', () => {
  const { db, dir } = freshDb();
  try {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tag_priority', '["ai","manual","bili","batch"]');
    assert.deepEqual(getTagPriority(db), ['manual', 'batch', 'bili', 'season', 'ai', 'system']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 采集超时配置（2026-08-22，按平台分档；2026-08-29 加 douyin 档）──
import { getCollectTimeout, setCollectTimeout, DEFAULT_COLLECT_TIMEOUT_MS } from './settings.js';

test('getCollectTimeout：缺行回落默认 {bilibili:90s, youtube:45s, douyin:45s（窗口式对齐 youtube）}', () => {
  const { db, dir } = freshDb();
  try {
    assert.deepEqual(getCollectTimeout(db), DEFAULT_COLLECT_TIMEOUT_MS);
    assert.equal(DEFAULT_COLLECT_TIMEOUT_MS.douyin, 45_000); // douyin 与 youtube 同为 navigate 无进展窗口
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setCollectTimeout：写读往返 + 覆盖（upsert，三键）', () => {
  const { db, dir } = freshDb();
  try {
    const custom = { bilibili: 120_000, youtube: 90_000, douyin: 60_000 };
    setCollectTimeout(db, custom);
    assert.deepEqual(getCollectTimeout(db), custom);
    setCollectTimeout(db, { bilibili: 90_000, youtube: 180_000, douyin: 45_000 });
    assert.deepEqual(getCollectTimeout(db), { bilibili: 90_000, youtube: 180_000, douyin: 45_000 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setCollectTimeout：缺键（含缺 douyin）/非整数/越界（<15s 或 >600s）抛错', () => {
  const { db, dir } = freshDb();
  try {
    assert.throws(() => setCollectTimeout(db, { bilibili: 90_000 }));                                  // 缺 youtube/douyin
    assert.throws(() => setCollectTimeout(db, { bilibili: 90_000, youtube: 45_000 }));                // 缺 douyin（两平台时代旧调用可见失败）
    assert.throws(() => setCollectTimeout(db, { bilibili: 10_000, youtube: 45_000, douyin: 45_000 }));  // < 15s
    assert.throws(() => setCollectTimeout(db, { bilibili: 90_000, youtube: 601_000, douyin: 45_000 })); // > 600s
    assert.throws(() => setCollectTimeout(db, { bilibili: '90s', youtube: 45_000, douyin: 45_000 }));   // 非数字
    assert.throws(() => setCollectTimeout(db, null));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('getCollectTimeout：DB 值损坏/单项越界 → 逐项回落默认不炸', () => {
  const { db, dir } = freshDb();
  try {
    db.prepare("INSERT INTO settings (key, value) VALUES ('collect_timeout_ms', 'not-json')").run();
    assert.deepEqual(getCollectTimeout(db), DEFAULT_COLLECT_TIMEOUT_MS);
    // 单项越界：该项回落默认,其余项保留
    db.prepare("UPDATE settings SET value = ? WHERE key = 'collect_timeout_ms'")
      .run(JSON.stringify({ bilibili: 120_000, youtube: 999_999 }));
    assert.deepEqual(getCollectTimeout(db), { bilibili: 120_000, youtube: 45_000, douyin: 45_000 });
    // 反向单项越界：bilibili 越界回落、youtube 保留
    db.prepare("UPDATE settings SET value = ? WHERE key = 'collect_timeout_ms'")
      .run(JSON.stringify({ bilibili: 9_999, youtube: 180_000 }));
    assert.deepEqual(getCollectTimeout(db), { bilibili: 90_000, youtube: 180_000, douyin: 45_000 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('getCollectTimeout：两平台时代存量行（无 douyin 键）→ douyin 回落默认 45s，其余保留', () => {
  const { db, dir } = freshDb();
  try {
    // S2 升级时线上 settings 里存的是两键形态——读取不炸，douyin 补默认（一次性自动升级）
    db.prepare("INSERT INTO settings (key, value) VALUES ('collect_timeout_ms', ?)")
      .run(JSON.stringify({ bilibili: 120_000, youtube: 90_000 }));
    assert.deepEqual(getCollectTimeout(db), { bilibili: 120_000, youtube: 90_000, douyin: 45_000 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
