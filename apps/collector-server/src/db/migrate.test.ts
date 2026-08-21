// migrate 幂等测试：验证 categories 表创建 + creators 两列追加（schema.sql + runMigrations 双轨）。
// 用 :memory: 库跑 migrate（执行 schema.sql）+ runMigrations（ALTER 旧库补列），第二次不报错。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, runMigrations, MIGRATIONS } from './migrate.js';

test('migrate + runMigrations 幂等：跑两次不报错且字段存在', () => {
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  // 第二次（模拟旧库已加列场景）
  runMigrations(db);

  // categories 表存在
  const cats = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='categories'").get();
  assert.ok(cats, 'categories 表应被创建');

  // creators 两列存在
  const cols = db.prepare("PRAGMA table_info(creators)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  assert.ok(names.includes('category_agent_id'), 'creators.category_agent_id 应存在');
  assert.ok(names.includes('category_human_id'), 'creators.category_human_id 应存在');

  // videos.paid 列存在（schema.sql 新建库 + runMigrations 旧库补列双轨）
  const vcols = db.prepare("PRAGMA table_info(videos)").all() as Array<{ name: string }>;
  assert.ok(vcols.map((c) => c.name).includes('paid'), 'videos.paid 应存在');
});

// ── 版本账本（PRAGMA user_version）+ paid 回填 ──

/** 最新迁移步骤的版本号（MIGRATIONS 尾元素），断言用——新增步骤时自动跟随 */
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * 模拟旧库：按当前 schema 建库后 DROP 掉 runMigrations 负责补的列
 * （collect_tasks.creator_client_id / creators 九列 / videos.paid）。
 * user_version 保持 0——旧库从未写过账本，首次启动会重放全部步骤。
 */
function oldDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  db.exec(`
    ALTER TABLE collect_tasks DROP COLUMN creator_client_id;
    ALTER TABLE creators DROP COLUMN sign;
    ALTER TABLE creators DROP COLUMN level;
    ALTER TABLE creators DROP COLUMN sex;
    ALTER TABLE creators DROP COLUMN official_type;
    ALTER TABLE creators DROP COLUMN official_title;
    ALTER TABLE creators DROP COLUMN fans;
    ALTER TABLE creators DROP COLUMN following;
    ALTER TABLE creators DROP COLUMN category_agent_id;
    ALTER TABLE creators DROP COLUMN category_human_id;
    ALTER TABLE videos DROP COLUMN paid;
  `);
  return db;
}

function userVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

test('版本账本：旧库（列缺失）跑 runMigrations → 列补齐 + user_version 写到最新', () => {
  const db = oldDb();
  runMigrations(db);
  try {
    // 列补齐（三张表各验代表列）
    const tcols = db.prepare('PRAGMA table_info(collect_tasks)').all() as Array<{ name: string }>;
    assert.ok(tcols.map((c) => c.name).includes('creator_client_id'), 'collect_tasks.creator_client_id 应补齐');
    const ccols = db.prepare('PRAGMA table_info(creators)').all() as Array<{ name: string }>;
    const cnames = ccols.map((c) => c.name);
    assert.ok(cnames.includes('sign') && cnames.includes('category_agent_id') && cnames.includes('category_human_id'), 'creators 新列应补齐');
    const vcols = db.prepare('PRAGMA table_info(videos)').all() as Array<{ name: string }>;
    assert.ok(vcols.map((c) => c.name).includes('paid'), 'videos.paid 应补齐');
    // 账本写入
    assert.equal(userVersion(db), LATEST, 'user_version 应写到最新步骤版本');
  } finally { db.close(); }
});

test('版本账本：新库（migrate + runMigrations）也写 user_version', () => {
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  try {
    assert.equal(userVersion(db), LATEST, '新库同样应由 runMigrations 记版本');
  } finally { db.close(); }
});

test('版本短路：已是最新版本时再跑 runMigrations 零 SQL 执行', () => {
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  try {
    // spy db.exec：全部步骤按版本跳过 → 一条 SQL 都不该执行
    let calls = 0;
    const orig = db.exec.bind(db);
    (db as any).exec = (sql: string) => { calls++; return orig(sql); };
    runMigrations(db);
    assert.equal(calls, 0, '版本短路下不应执行任何迁移 SQL');
    assert.equal(userVersion(db), LATEST, 'user_version 不变');
  } finally { db.close(); }
});

test('漂移检测：user_version 高于本代码已知版本 → 拒绝运行', () => {
  const db = new Database(':memory:');
  migrate(db);
  db.pragma(`user_version = ${LATEST + 1}`);
  try {
    assert.throws(() => runMigrations(db), /user_version/, '库版本超前应抛错而非静默运行');
  } finally { db.close(); }
});

test('paid 回填：extra.paid=true 的存量行 → paid=1；false/无键/NULL extra 不动', () => {
  const db = oldDb();
  try {
    // 旧库插行：paid 列尚未补，显式列清单不包含 paid（模拟加列前落库的存量数据）
    const ins = db.prepare('INSERT INTO videos (source, source_vid, title, extra, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run('bilibili', 'BV-true', '充电专属', JSON.stringify({ paid: true }), 1, 1);
    ins.run('bilibili', 'BV-false', '免费视频', JSON.stringify({ paid: false }), 1, 1);
    ins.run('bilibili', 'BV-nokey', '无 paid 键', JSON.stringify({ view: 100 }), 1, 1);
    ins.run('bilibili', 'BV-null', 'NULL extra', null, 1, 1);
    runMigrations(db);
    const rows = db.prepare('SELECT source_vid, paid FROM videos ORDER BY source_vid').all() as Array<{ source_vid: string; paid: number }>;
    const byVid = Object.fromEntries(rows.map((r) => [r.source_vid, r.paid]));
    assert.equal(byVid['BV-true'], 1, 'extra.paid=true 应回填为 1');
    assert.equal(byVid['BV-false'], 0, 'extra.paid=false 保持 0');
    assert.equal(byVid['BV-nokey'], 0, '无 paid 键保持 0');
    assert.equal(byVid['BV-null'], 0, 'NULL extra 保持 0');
  } finally { db.close(); }
});

test('v5：旧库 subtitle_versions 缺 body_hash → 补列', () => {
  // 建新库后模拟 v5 之前的旧结构：重建无 body_hash 的表
  const db = new Database(':memory:');
  migrate(db);
  db.exec('DROP TABLE subtitle_versions');
  db.exec(`CREATE TABLE subtitle_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    origin TEXT NOT NULL,
    payload TEXT NOT NULL,
    body_size INTEGER,
    source_url TEXT,
    asr_engine TEXT,
    captured_at INTEGER NOT NULL
  )`);
  db.pragma('user_version = 4'); // 模拟已到 v4 的存量库
  runMigrations(db);
  const cols = db.prepare('PRAGMA table_info(subtitle_versions)').all() as Array<{ name: string }>;
  assert.ok(cols.map((c) => c.name).includes('body_hash'), 'body_hash 应被补列');
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version);
});

// ── v6：videos extra tid/stat.view 表达式索引（筛选取代 json_extract 全表扫）──

test('v6：旧库（无表达式索引）跑 runMigrations → 两个索引补建', () => {
  const db = new Database(':memory:');
  migrate(db);
  // 模拟 v5 之前的存量库：schema 建出的索引先删掉
  db.exec('DROP INDEX idx_videos_extra_tid');
  db.exec('DROP INDEX idx_videos_extra_view');
  db.pragma('user_version = 5');
  runMigrations(db);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_videos_extra_tid','idx_videos_extra_view')")
    .all() as Array<{ name: string }>;
  assert.deepEqual(idx.map((i) => i.name).sort(), ['idx_videos_extra_tid', 'idx_videos_extra_view'], '两个表达式索引应被补建');
});

// ── v7：videos.status 单值死列删除（schema 默认 'online'，全库无其它写入/读取路径）──

/** 模拟 v6 之前的旧库结构：videos 带 status 列（旧 schema.sql 原样），账本停在 v6 */
function dbWithStatusColumn(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  db.exec("ALTER TABLE videos ADD COLUMN status TEXT DEFAULT 'online'");
  db.pragma('user_version = 6');
  return db;
}

test('v7：旧库 videos.status 列被 DROP，其余数据不动', () => {
  const db = dbWithStatusColumn();
  try {
    db.prepare("INSERT INTO videos (source, source_vid, title, status, first_seen_at, updated_at) VALUES ('bilibili', 'BV1', 't', 'online', 1, 1)").run();
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(videos)').all() as Array<{ name: string }>;
    assert.ok(!cols.map((c) => c.name).includes('status'), 'status 列应被 DROP');
    const row = db.prepare("SELECT source_vid, title FROM videos WHERE source_vid = 'BV1'").get() as { title: string } | undefined;
    assert.equal(row?.title, 't', 'DROP 列不应影响其余数据');
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version, '账本应写到最新');
  } finally { db.close(); }
});

test('v7：新库（schema.sql 已无 status 列）重放迁移不报错（DROP 容忍 no such column）', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    assert.doesNotThrow(() => runMigrations(db), '新库重放 v7 的 DROP COLUMN 应容忍列不存在');
    const cols = db.prepare('PRAGMA table_info(videos)').all() as Array<{ name: string }>;
    assert.ok(!cols.map((c) => c.name).includes('status'), '新库本就无 status 列');
  } finally { db.close(); }
});

// ── v9（2026-08-22）：collect_tasks 状态 CHECK 加 limited（单事务表重建）──
test('v9 迁移：旧 CHECK(4 值)库重建后可写 limited；重放幂等', () => {
  const db = new Database(':memory:');
  try {
    // 手工建 v8 形态旧表(CHECK 不含 limited)+ 存量行——模拟迁移前旧库
    db.exec(`CREATE TABLE collect_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN ('bilibili','youtube')),
      source_vid TEXT NOT NULL, url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','succeeded','failed')),
      client_id TEXT, creator_client_id TEXT, error TEXT, result TEXT, batch_id TEXT,
      created_at INTEGER NOT NULL, finished_at INTEGER)`);
    db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at) VALUES ('youtube', 'gaDdrDdczO4', 'https://x', 'succeeded', 1)").run();
    db.pragma('user_version = 8');

    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version);
    // 旧 CHECK 下这会抛 no-check 约束;重建后合法
    db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at) VALUES ('youtube', 'F3lL98Pj90o', 'https://x', 'limited', 2)").run();
    // 存量行保留
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM collect_tasks WHERE status='succeeded'").get() as any).n, 1);
    // 索引随重建恢复
    assert.ok((db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_status'").get() as any));
    // 重放幂等
    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version);
  } finally { db.close(); }
});
