// migrate 幂等测试：验证 categories 表创建 + creators 两列追加（schema.sql + runMigrations 双轨）。
// 用 :memory: 库跑 migrate（执行 schema.sql）+ runMigrations（ALTER 旧库补列），第二次不报错。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 版本账本/幂等/v5-v16 各步骤 | 通过 | |
// | R2 | v18 collect_tasks.source CHECK 放行 douyin（旧库重建/新库重放） | 通过 | 2026-08-29 S2 抖音平台化 |
// | R3 | v19 ASR 轨按引擎改名（有 engine 改名/无 engine 回落 unknown/幂等重放/新库重放） | 通过 | 2026-08-29 多引擎版本比对 |
// | R4 | v21 jobs 表建表（v19 旧库升级/列清单/CHECK/索引/重放幂等/新库重放） | 通过 | 2026-10-04 CLI 全功能 web 化 Phase 4 |
// | R5 | v23 comments 补 parent_reply_name（新库 duplicate 容忍/旧库 ALTER 补列/结构化双写比对）——专项在 comments.test.ts | 通过 | 2026-10-08 媒体信息轻量增强(合并重排) |

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

  // v16 值域合一后 categories 无 scope 列（新库重放路径防回归——Hazard A 见 v16 专项测试）
  const cacols = db.prepare("PRAGMA table_info(categories)").all() as Array<{ name: string }>;
  assert.ok(!cacols.map((c) => c.name).includes('scope'), 'categories.scope 应不存在（值域合一）');
  // 新库重放 v16 后不留脏事务、FK 恢复开启（PRAGMA OFF/ON 包裹正确执行的直接证据）
  assert.equal(db.inTransaction, false, '迁移后不应残留打开的事务');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, '迁移后 foreign_keys 应恢复开启');
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
    // 模拟 v8 形态旧库：完整 schema 建库后把 collect_tasks 重建为旧 CHECK（不含 limited）+ 存量行。
    // （须先 migrate 建全表——后续 v10 步骤引用 subtitle_tracks/videos，极简库会 no such table）
    migrate(db);
    db.exec('DROP TABLE collect_tasks');
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

// ── v10：YouTube 翻译轨 track_type 2→3（判据：type2 + video.source=youtube + 版本 source_url 含 tlang=）──

/** 模拟 v9 形态存量库：手工插 youtube/bilibili 视频与各类轨（source_url 带/不带 tlang=），账本停在 v9 */
function dbWithLegacyYoutubeTracks(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  const insV = db.prepare("INSERT INTO videos (source, source_vid, title, first_seen_at, updated_at) VALUES (?, ?, ?, 1, 1)");
  const yt = Number(insV.run('youtube', 'yt1', 'T').lastInsertRowid);
  const bl = Number(insV.run('bilibili', 'BV1', 'T').lastInsertRowid);
  const insT = db.prepare('INSERT INTO subtitle_tracks (video_id, lan, lan_doc, track_type) VALUES (?, ?, ?, ?)');
  const insVer = db.prepare("INSERT INTO subtitle_versions (track_id, origin, payload, captured_at, source_url) VALUES (?, 'external', '{}', 1, ?)");
  // 命中迁移：youtube + type2 + 版本 source_url 含 tlang=（机翻翻译轨）
  const ytTlang = Number(insT.run(yt, 'zh-Hans', '中文(机翻)', 2).lastInsertRowid);
  insVer.run(ytTlang, 'https://www.youtube.com/api/timedtext?lang=en&tlang=zh-Hans&signature=x');
  // 不命中：youtube 原文人工 CC（source_url 无 tlang=）
  const ytCc = Number(insT.run(yt, 'en', 'English CC', 2).lastInsertRowid);
  insVer.run(ytCc, 'https://www.youtube.com/api/timedtext?lang=en&signature=x');
  // 不命中：youtube type2 但无版本行（无 tlang 证据）
  const ytNoVer = Number(insT.run(yt, 'ja', 'Japanese', 2).lastInsertRowid);
  // 不命中：bilibili + type2（source_url 即使含 tlang= 也不迁——判据须 youtube）
  const blTlang = Number(insT.run(bl, 'zh-Hans', 'CC中文', 2).lastInsertRowid);
  insVer.run(blTlang, 'https://example.com/sub?tlang=zh');
  // 不命中：youtube type1（ASR 轨，本就不是翻译轨形态）
  const ytAsr = Number(insT.run(yt, 'en', 'English ASR', 1).lastInsertRowid);
  insVer.run(ytAsr, 'https://www.youtube.com/api/timedtext?lang=en&tlang=zh-Hans&asr');
  db.pragma('user_version = 9');
  return db;
}

const trackTypeOf = (db: Database.Database, videoSource: string, lan: string): number | null =>
  (db.prepare(`
    SELECT st.track_type AS tt FROM subtitle_tracks st
    JOIN videos v ON v.id = st.video_id
    WHERE v.source = ? AND st.lan = ?`).get(videoSource, lan) as { tt: number | null }).tt;

test('v10：youtube 翻译轨(type2+tlang=) 改 type=3；bilibili/无tlang/无版本/ASR 轨不动', () => {
  const db = dbWithLegacyYoutubeTracks();
  try {
    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version, '账本应写到最新');
    assert.equal(trackTypeOf(db, 'youtube', 'zh-Hans'), 3, 'youtube 翻译轨应改为 3');
    assert.equal(trackTypeOf(db, 'youtube', 'ja'), 2, 'youtube type2 无版本行不动（无 tlang 证据）');
    assert.equal(trackTypeOf(db, 'bilibili', 'zh-Hans'), 2, 'bilibili 轨即使 source_url 含 tlang= 也不迁（判据须 source=youtube）');
    // youtube en 有两条轨（CC=2 / ASR=1），分别断言：
    const enTypes = (db.prepare(`
      SELECT st.track_type AS tt FROM subtitle_tracks st JOIN videos v ON v.id = st.video_id
      WHERE v.source = 'youtube' AND st.lan = 'en' ORDER BY st.track_type`).all() as Array<{ tt: number }>).map((r) => r.tt);
    assert.deepEqual(enTypes, [1, 2], 'youtube en 的 ASR(1) 与 CC(2) 轨均不受迁移影响');
    // 重放幂等：再跑一次不改任何行（已是 3 的不命中 type=2 条件）
    runMigrations(db);
    assert.equal(trackTypeOf(db, 'youtube', 'zh-Hans'), 3);
  } finally { db.close(); }
});

test('v10：同 (video_id, lan) 已有 type=3 轨时跳过旧 type=2 行（防 UNIQUE 冲突，过渡期双写防御）', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const yt = Number(db.prepare("INSERT INTO videos (source, source_vid, title, first_seen_at, updated_at) VALUES ('youtube', 'ytD', 'T', 1, 1)").run().lastInsertRowid);
    // 新扩展已写 (yt, zh-Hans, 3)，旧扩展又留下 (yt, zh-Hans, 2)（tlang URL）
    const t3 = Number(db.prepare("INSERT INTO subtitle_tracks (video_id, lan, lan_doc, track_type) VALUES (?, 'zh-Hans', '中文(机翻)', 3)").run(yt).lastInsertRowid);
    const t2 = Number(db.prepare("INSERT INTO subtitle_tracks (video_id, lan, lan_doc, track_type) VALUES (?, 'zh-Hans', '中文(机翻)', 2)").run(yt).lastInsertRowid);
    db.prepare("INSERT INTO subtitle_versions (track_id, origin, payload, captured_at, source_url) VALUES (?, 'external', '{}', 1, 'https://tt?lang=en&tlang=zh-Hans')").run(t2);
    db.pragma('user_version = 9');
    assert.doesNotThrow(() => runMigrations(db), '已有 type3 孪生轨时 UPDATE 不得撞 UNIQUE(video_id, lan, track_type)');
    const tt = db.prepare('SELECT track_type FROM subtitle_tracks WHERE id = ?').get(t2) as { track_type: number };
    assert.equal(tt.track_type, 2, '冲突行跳过不改（留待重采自然去留）');
    const t3row = db.prepare('SELECT track_type FROM subtitle_tracks WHERE id = ?').get(t3) as { track_type: number };
    assert.equal(t3row.track_type, 3, '既有 type=3 轨不受影响');
  } finally { db.close(); }
});

// ---- v15：creators.blocked 屏蔽标记（2026-08-24；v14 已被 clients 登录态迁移占用）----

test('v15：旧库（creators 无 blocked 列）跑 runMigrations → 列补齐且存量行默认 0', () => {
  const db = new Database(':memory:');
  migrate(db);
  db.exec('ALTER TABLE creators DROP COLUMN blocked');
  db.exec("INSERT INTO creators (source, source_uid, first_seen_at, updated_at) VALUES ('bilibili', '9', 1, 1)");
  runMigrations(db);
  const cols = db.prepare('PRAGMA table_info(creators)').all() as Array<{ name: string }>;
  assert.ok(cols.map((c) => c.name).includes('blocked'), 'creators.blocked 应被 v15 补齐');
  const row = db.prepare('SELECT blocked FROM creators WHERE source_uid = 9').get() as { blocked: number };
  assert.equal(row.blocked, 0, '存量行 blocked 默认 0');
  db.close();
});

// ---- v16（2026-08-25）：categories 去 scope 值域合一（单事务表重建 + FK 前后包裹）----

/**
 * 模拟 v15 形态旧库：完整 schema 建库后把 categories 重建为带 scope 的旧 DDL（scope 参与 UNIQUE，
 * 无法用 DROP COLUMN 模拟——DROP COLUMN 不能删被 UNIQUE 约束引用的列），种入跨 scope 数据，账本停在 v15。
 */
function dbWithScopedCategories(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  db.exec('DROP TABLE categories');
  db.exec(`CREATE TABLE categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    scope       TEXT NOT NULL CHECK(scope IN ('agent','human')),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    UNIQUE(name, scope)
  )`);
  db.exec('CREATE INDEX idx_categories_scope ON categories(scope, sort_order)');
  const ins = db.prepare('INSERT INTO categories (name, scope, sort_order, created_at) VALUES (?, ?, 0, ?)');
  // id 1=agent 财经；id 2=human 财经（跨 scope 同名，id 大 → 被丢，引用需重定向到 1）；
  // id 3=human 关注（非重名 human 行，id 保留）；id 4=agent 科技
  ins.run('财经', 'agent', 1); ins.run('财经', 'human', 1); ins.run('关注', 'human', 1); ins.run('科技', 'agent', 1);
  const insCr = db.prepare('INSERT INTO creators (source, source_uid, category_agent_id, category_human_id, first_seen_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)');
  // u1：agent→1 自映射 + human→2 重定向对象；u2：双列自映射（4/3）；u3：双列 NULL 保持
  insCr.run('bilibili', 'u1', 1, 2); insCr.run('bilibili', 'u2', 4, 3); insCr.run('bilibili', 'u3', null, null);
  db.pragma('user_version = 15');
  return db;
}

test('v16：带 scope 旧库重建 → scope 列删除、同名行小 id 保留、双列引用按名重定向', () => {
  const db = dbWithScopedCategories();
  try {
    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version, '账本应写到最新');
    // scope 列删除 + 表形态
    const cols = db.prepare('PRAGMA table_info(categories)').all() as Array<{ name: string }>;
    assert.ok(!cols.map((c) => c.name).includes('scope'), 'scope 列应被删除');
    // 数据：同名行小 id 保留（id1 agent 财经留下、id2 human 财经被丢），非重名行 id 原样
    const rows = db.prepare('SELECT id, name FROM categories ORDER BY id').all() as Array<{ id: number; name: string }>;
    assert.deepEqual(rows, [
      { id: 1, name: '财经' }, { id: 3, name: '关注' }, { id: 4, name: '科技' },
    ], '同名行小 id 保留、非重名行 id 不变');
    // 引用：u1 的 human 列从被丢的 2 重定向到同名保留行 1；u2 双列自映射；u3 NULL 保持
    const crs = db.prepare('SELECT source_uid AS u, category_agent_id AS a, category_human_id AS h FROM creators ORDER BY source_uid').all() as Array<{ u: string; a: number | null; h: number | null }>;
    assert.deepEqual(crs, [
      { u: 'u1', a: 1, h: 1 }, { u: 'u2', a: 4, h: 3 }, { u: 'u3', a: null, h: null },
    ], '双列引用按名重定向（NULL 保持、自映射不变）');
    // 新约束生效：UNIQUE(name) 拦截同名、旧索引消失新索引在
    assert.throws(() => db.prepare("INSERT INTO categories (name, sort_order, created_at) VALUES ('财经', 0, 1)").run(), /UNIQUE/, '同名应撞 UNIQUE(name)');
    assert.ok(!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_categories_scope'").get(), '旧 scope 索引应随表重建消失');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_categories_sort'").get(), '新 sort 索引应存在');
    // FK 完整性 + 无脏事务 + FK 恢复开启
    assert.deepEqual(db.pragma('foreign_key_check'), [], '迁移后外键检查应干净');
    assert.equal(db.inTransaction, false, '不应残留打开的事务');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys 应恢复开启');
    // 重放幂等
    runMigrations(db);
    assert.deepEqual(
      db.prepare('SELECT id, name FROM categories ORDER BY id').all(),
      [{ id: 1, name: '财经' }, { id: 3, name: '关注' }, { id: 4, name: '科技' }],
      '重放不再改数据',
    );
  } finally { db.close(); }
});

test('v16：新库（schema.sql 无 scope 表）重放迁移不残留脏事务且表可用（Hazard A 防回归）', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    assert.doesNotThrow(() => runMigrations(db), '新库重放 v16 应完整执行不报错');
    // 若 v16 语句引用 scope 列：no such column 被容忍吞掉会留下打开的事务 + FK 关闭——两者都在此暴露
    assert.equal(db.inTransaction, false, '不应残留打开的事务');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys 应为开启');
    assert.equal(db.prepare("INSERT INTO categories (name, sort_order, created_at) VALUES ('新库行', 0, 1)").run().changes, 1, 'categories 应可写（写入未滞留在未提交事务）');
  } finally { db.close(); }
});

// ── v18（2026-08-29 douyin 平台化）：collect_tasks.source CHECK 放行 douyin（单事务表重建）──
test('v18 迁移：旧 CHECK(2 平台)库重建后可写 douyin；存量数据/索引完整；重放幂等', () => {
  const db = new Database(':memory:');
  try {
    // 模拟 v17 形态旧库：重建为旧 CHECK（不含 douyin；列集 = v11 后全量，含 creator_uid）+ 存量行
    migrate(db);
    db.exec('DROP TABLE collect_tasks');
    db.exec(`CREATE TABLE collect_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN ('bilibili','youtube')),
      source_vid TEXT NOT NULL, url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','succeeded','failed','limited')),
      client_id TEXT, creator_client_id TEXT, error TEXT, result TEXT, batch_id TEXT, creator_uid TEXT,
      created_at INTEGER NOT NULL, finished_at INTEGER)`);
    const ins = db.prepare(
      "INSERT INTO collect_tasks (source, source_vid, url, status, creator_uid, batch_id, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    ins.run('youtube', 'gaDdrDdczO4', 'https://y1', 'succeeded', 'UC1', 'batch-a', 1, 2);
    ins.run('bilibili', 'BV1xx411c7mD', 'https://b1', 'failed', '42', null, 3, 4);
    db.pragma('user_version = 17');

    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version, '账本应写到最新');
    // 旧 CHECK 下这会抛约束；重建后 douyin 合法可写
    db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at) VALUES ('douyin', '7123456789012345678', 'https://dy', 'pending', 5)").run();
    // 存量行完整迁移（id/终态/冗余列逐字段比对——表重建丢列是最需要盯的回归面）
    const rows = db.prepare(
      'SELECT id, source, source_vid, status, creator_uid, batch_id, finished_at FROM collect_tasks ORDER BY id',
    ).all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { id: 1, source: 'youtube', source_vid: 'gaDdrDdczO4', status: 'succeeded', creator_uid: 'UC1', batch_id: 'batch-a', finished_at: 2 },
      { id: 2, source: 'bilibili', source_vid: 'BV1xx411c7mD', status: 'failed', creator_uid: '42', batch_id: null, finished_at: 4 },
      { id: 3, source: 'douyin', source_vid: '7123456789012345678', status: 'pending', creator_uid: null, batch_id: null, finished_at: null },
    ]);
    // 索引随重建恢复；重放幂等（版本短路，不动数据）
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_status'").get(), 'idx_tasks_status 应随重建恢复');
    runMigrations(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM collect_tasks').get() as { n: number }).n, 3, '重放不增不减');
  } finally { db.close(); }
});

test('v18 迁移：新库（schema.sql 已带 douyin CHECK）全量重放安全，不留脏事务（scope-free 写法）', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    assert.doesNotThrow(() => runMigrations(db), '新库重放 v18 表重建应完整执行不报错');
    assert.equal(db.inTransaction, false, '不应残留打开的事务');
    // 新库 CHECK 本就含 douyin，重放后仍可写
    assert.equal(db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at) VALUES ('douyin', '7123456789012345678', 'https://dy', 'pending', 1)").run().changes, 1);
  } finally { db.close(); }
});

// ── v19（2026-08-29 多引擎版本比对）：存量 asr-zh 轨按引擎改名（纯 UPDATE 单事务）──
// 场景矩阵：有 engine 改名 / 多版本取最新 / engine 为 NULL 回落 unknown / 无版本回落 unknown / 非 asr-zh 轨不动
test('v19 迁移：lan=asr-zh 存量按 asr 版本 engine 改名，无 engine 回落 unknown；重放幂等', () => {
  const db = new Database(':memory:');
  try {
    // 模拟 v18 形态旧库：全量 schema + 账本拨回 18
    migrate(db);
    db.pragma('user_version = 18');

    // 存量视频 + 各形态 asr-zh 轨（track_type=1，与 http/asr.ts 写入口径一致；UNIQUE(video_id,lan,track_type)
    // 决定每视频至多一条 asr-zh 轨——各形态分散在不同视频上）
    db.prepare("INSERT INTO videos (source, source_vid, title, extra, first_seen_at, updated_at) VALUES ('bilibili', 'BV1', 't', '{}', 1, 1)").run();
    db.prepare("INSERT INTO videos (source, source_vid, title, extra, first_seen_at, updated_at) VALUES ('bilibili', 'BV2', 't', '{}', 1, 1)").run();
    db.prepare("INSERT INTO videos (source, source_vid, title, extra, first_seen_at, updated_at) VALUES ('bilibili', 'BV3', 't', '{}', 1, 1)").run();
    const insTrack = db.prepare('INSERT INTO subtitle_tracks (video_id, lan, lan_doc, track_type) VALUES (?, ?, ?, ?)');
    const insVer = db.prepare('INSERT INTO subtitle_versions (track_id, origin, payload, body_hash, source_url, asr_engine, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

    // BV1：两条 asr 版本（旧引擎 e-old 在前、新引擎 fireredasr-aed-l 在后）→ 取最新改名
    const t1 = Number(insTrack.run(1, 'asr-zh', '中文（ASR 转写）', 1).lastInsertRowid);
    insVer.run(t1, 'asr', '{"body":[]}', 'h1', 'asr://e-old', 'e-old', 1);
    insVer.run(t1, 'asr', '{"body":[]}', 'h2', 'asr://fireredasr-aed-l', 'fireredasr-aed-l', 2);
    // BV2：asr 版本但 asr_engine 为 NULL（早期写入）→ 回落 unknown
    const t2 = Number(insTrack.run(2, 'asr-zh', '中文（ASR 转写）', 1).lastInsertRowid);
    insVer.run(t2, 'asr', '{"body":[]}', 'h3', 'asr://x', null, 3);
    // BV3：lan=asr-zh 但零版本（孤立轨）→ 回落 unknown；同视频普通 zh CC 轨（非 asr-zh）→ 不动
    const t3 = Number(insTrack.run(3, 'asr-zh', '中文（ASR 转写）', 1).lastInsertRowid);
    const t4 = Number(insTrack.run(3, 'zh', '中文', 2).lastInsertRowid);

    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version, '账本应写到最新');
    const rows = db.prepare('SELECT id, lan, lan_doc FROM subtitle_tracks ORDER BY id').all() as Array<{ id: number; lan: string; lan_doc: string }>;
    assert.deepEqual(rows, [
      { id: t1, lan: 'asr-zh-fireredasr-aed-l', lan_doc: '中文（ASR·fireredasr-aed-l）' }, // 多版本取最新 engine
      { id: t2, lan: 'asr-zh-unknown', lan_doc: '中文（ASR·unknown）' },                    // engine NULL 回落
      { id: t3, lan: 'asr-zh-unknown', lan_doc: '中文（ASR·unknown）' },                    // 零版本回落
      { id: t4, lan: 'zh', lan_doc: '中文' },                                               // 非 asr-zh 不动
    ], '改名结果逐行比对');
    // 版本行原样保留（改名只动 subtitle_tracks，版本出处 asr_engine 不丢）
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM subtitle_versions').get() as { n: number }).n, 3, '版本行不增不减');

    // 重放幂等（版本短路，且 UPDATE WHERE lan=asr-zh 已无命中行）
    runMigrations(db);
    const rows2 = db.prepare('SELECT id, lan, lan_doc FROM subtitle_tracks ORDER BY id').all() as Array<{ id: number; lan: string; lan_doc: string }>;
    assert.deepEqual(rows2, rows, '重放不增不减不改');
  } finally { db.close(); }
});

test('v19 迁移：新库（无 asr-zh 存量）全量重放安全，不留脏事务', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    assert.doesNotThrow(() => runMigrations(db), '新库重放 v19 纯 UPDATE 应完整执行不报错');
    assert.equal(db.inTransaction, false, '不应残留打开的事务');
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version, '账本写到最新（随新增步骤自动跟随）');
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version, '账本写到最新');
  } finally { db.close(); }
});

// ── v21（2026-10-04 CLI 全功能 web 化 Phase 4；v20 编号让位 comments 迁移，2026-10-07 改号）：jobs 通用任务台账（新建表/索引，IF NOT EXISTS 重放安全）──
test('v21 迁移：v19 旧库升级建 jobs 表（列齐全 + status CHECK + 两索引），重放幂等', () => {
  const db = new Database(':memory:');
  try {
    // 模拟 v19 形态旧库：全量 schema（尚无 jobs）+ 账本拨回 19
    migrate(db);
    db.prepare('DROP TABLE jobs').run(); // schema.sql 已双写 v21 的 jobs——摘掉才等价 v19 时代的真实旧库
    db.pragma('user_version = 19');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get(), undefined, '升级前无 jobs 表');

    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version, '账本应写到最新');

    // 列齐全（与 schema.sql 双写一致）
    const cols = (db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(cols, [
      'id', 'type', 'params_json', 'status', 'progress_json', 'result_json',
      'error', 'created_at', 'updated_at', 'started_at', 'finished_at',
    ], 'jobs 列清单逐列比对');

    // status CHECK 约束：五种合法状态可写，非法值被拒
    const ins = db.prepare("INSERT INTO jobs (type, params_json, status, created_at, updated_at) VALUES ('asr-backfill', '{}', ?, 1, 1)");
    for (const s of ['pending', 'running', 'done', 'failed', 'cancelled']) {
      assert.doesNotThrow(() => ins.run(s), `合法状态 ${s} 应可写`);
    }
    assert.throws(() => ins.run('bogus'), /CHECK/, '非法 status 应被 CHECK 拒绝');

    // 两索引在场
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs'").all() as Array<{ name: string }>).map((r) => r.name);
    assert.ok(idx.includes('idx_jobs_status'), 'idx_jobs_status 应存在');
    assert.ok(idx.includes('idx_jobs_created'), 'idx_jobs_created 应存在');

    // 重放幂等（IF NOT EXISTS 短路；runMigrations 只容忍特定 duplicate 错误，非 IF NOT EXISTS 建表会直接炸）
    assert.doesNotThrow(() => runMigrations(db), '重放应因 IF NOT EXISTS 幂等');
  } finally { db.close(); }
});

test('v21 迁移：新库（schema.sql 已带 jobs）全量重放安全，不留脏事务', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    assert.doesNotThrow(() => runMigrations(db), '新库重放 v21 建表应完整执行不报错');
    assert.equal(db.inTransaction, false, '不应残留打开的事务');
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version, '账本写到最新');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get(), 'jobs 表在场');
  } finally { db.close(); }
});
