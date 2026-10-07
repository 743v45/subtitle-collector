// danmaku 持久层测试（2026-10-07 弹幕采集解冻，PLAN docs/plans/danmaku/PLAN.md §3/§5/§7.1）：
// v22 迁移（新库/旧库/双写漂移）、upsert 幂等（观测列刷新/首采列保留/空批不开事务/同批重复吸收）、
// 多 P 共存与 count 聚合、timeline 排序、verifyDanmaku R1-R5（直方图/峰值/负进度/mode/weight/ctime）、索引断言。
// 夹具：:memory: 库 + migrate + runMigrations 种子；视频行手插（danmaku.video_id 外键引用 videos.id）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | v22 迁移/双写/upsert 幂等/多 P/timeline/verify R1-R5/索引 | 待首次 pnpm qa | 2026-10-07 首写 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, runMigrations, MIGRATIONS } from './migrate.js';
import { upsertDanmaku, danmakuCount, danmakuTimeline } from './danmaku.js';
import type { DanmakuUpsertRow, DanmakuRecord } from './danmaku.js';
import { verifyDanmaku } from './danmaku-verify.js';

/** 最新迁移步骤版本号（MIGRATIONS 尾元素）。danmaku 是 v22——LATEST 随最新迁移走，新追加步骤时本文件对应用例同步跟随 */
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  return db;
}

function insertVideo(db: Database.Database, sourceVid = 'BV1D1'): number {
  return Number(db.prepare(
    "INSERT INTO videos (source, source_vid, title, first_seen_at, updated_at) VALUES ('bilibili', ?, '测试视频', 1, 1)",
  ).run(sourceVid).lastInsertRowid);
}

let seq = 0;
/** 构造归一化弹幕行：缺省为普通滚动弹幕形态（mode=1、单 P、非空观测列） */
function row(over: Partial<DanmakuUpsertRow> = {}): DanmakuUpsertRow {
  seq++;
  return {
    id_str: over.id_str ?? `d${seq}`,
    cid: 100,
    page: 1,
    progress_ms: 1000 * seq,
    mode: 1,
    fontsize: 25,
    color: 16777215,
    mid_hash: 'abc',
    content: `弹幕${seq}`,
    ctime_s: 1600000000 + seq,
    weight: 6,
    pool: 0,
    action: null,
    ...over,
  };
}

const getRow = (db: Database.Database, idStr: string): DanmakuRecord =>
  db.prepare('SELECT * FROM danmaku WHERE id_str = ?').get(idStr) as DanmakuRecord;

const countAll = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM danmaku').get() as { n: number }).n;

// ── v22 迁移与双写 ──

test('v22 迁移：新库建 danmaku 表 + user_version 写到最新 + 重放幂等', () => {
  const db = freshDb();
  try {
    assert.equal(LATEST, 22, 'MIGRATIONS 尾元素应为最新迁移（v22 danmaku）');
    assert.equal(db.pragma('user_version', { simple: true }), LATEST, '新库账本应写到 22');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='danmaku'").all();
    assert.equal(tables.length, 1, 'danmaku 表应存在');
    // 重放幂等（CREATE IF NOT EXISTS 全量重放安全，PLAN §3.2）
    assert.doesNotThrow(() => runMigrations(db));
    assert.equal(db.inTransaction, false, '不应残留打开的事务');
  } finally { db.close(); }
});

test('v22 迁移：旧库（账本 v21、无 danmaku 表）补建且可写；重放幂等', () => {
  const db = freshDb();
  try {
    db.exec('DROP TABLE danmaku');
    db.pragma('user_version = 21');
    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), 22, '账本应补到 v22');
    const videoId = insertVideo(db);
    const r = upsertDanmaku(db, videoId, [row({ id_str: 'old1' })], { fetchedAt: 1000, batchId: 'b1' });
    assert.deepEqual(r, { inserted: 1, updated: 0 }, '补建后的表应可正常写入');
    assert.doesNotThrow(() => runMigrations(db), '重放不报错');
  } finally { db.close(); }
});

test('双写一致性：schema.sql 与 v22 statements 产出的 sqlite_master DDL 逐字一致', () => {
  const db = freshDb();
  try {
    const capture = () =>
      db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'danmaku' ORDER BY name").all();
    const before = capture();
    assert.equal(before.length, 3, '应为 表 + 2 索引 共 3 个对象');
    db.exec('DROP TABLE danmaku'); // 表级索引随表删
    const v22 = MIGRATIONS.find((m) => m.version === 22)!;
    for (const s of v22.statements) db.exec(s);
    // sqlite_master.sql 保存建表/建索引原文：两路（schema.sql exec / v22 statements exec）
    // 文本不一致会在此暴露（防双写漂移）
    assert.deepEqual(capture(), before);
  } finally { db.close(); }
});

// ── upsert 幂等（PLAN §3.3：观测列刷新、首采列保留）──

test('upsert 幂等：同 id_str 二次入库刷新观测列、保留首采列，返回 inserted/updated 计数', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    let res = upsertDanmaku(db, videoId, [
      row({ id_str: 'idem', cid: 100, page: 1, progress_ms: 1000, mode: 1, content: '旧内容', weight: 6 }),
    ], { fetchedAt: 1000, batchId: 'batch-1' });
    assert.deepEqual(res, { inserted: 1, updated: 0 });

    // 重采：id_str 相同、观测列全变、cid/page 也变（B 站侧不应发生，防御性保留首采值）
    res = upsertDanmaku(db, videoId, [
      row({
        id_str: 'idem', cid: 999, page: 9, progress_ms: 2000, mode: 5, fontsize: 36, color: 16711680,
        mid_hash: 'def', content: '新内容', weight: 9, pool: 1, action: '["admin"]',
      }),
    ], { fetchedAt: 2000, batchId: 'batch-2' });
    assert.deepEqual(res, { inserted: 0, updated: 1 }, '二次入库是 UPDATE 非新行');

    const got = getRow(db, 'idem');
    // 观测列已刷新（弹幕发送后理论不变，刷新是防御 B 站侧修正，§3.3）
    assert.equal(got.progress_ms, 2000, 'progress_ms 刷新');
    assert.equal(got.mode, 5, 'mode 刷新');
    assert.equal(got.fontsize, 36, 'fontsize 刷新');
    assert.equal(got.color, 16711680, 'color 刷新');
    assert.equal(got.mid_hash, 'def', 'mid_hash 刷新');
    assert.equal(got.content, '新内容', 'content 刷新');
    assert.equal(got.weight, 9, 'weight 刷新');
    assert.equal(got.pool, 1, 'pool 刷新');
    assert.equal(got.action, '["admin"]', 'action 刷新');
    assert.equal(got.last_seen_at, 2000, 'last_seen_at 刷到本次 fetchedAt');
    // 首采列保留
    assert.equal(got.cid, 100, 'cid 保留首采值');
    assert.equal(got.page, 1, 'page 保留首采值');
    assert.equal(got.first_seen_at, 1000, 'first_seen_at 保留首采值');
    assert.equal(got.batch_id, 'batch-1', 'batch_id 保留首采批次');
    assert.equal(got.video_id, videoId, 'video_id 不改写');
    assert.equal(countAll(db), 1, '不产生新行');
  } finally { db.close(); }
});

test('upsert：空数组不开事务直接返回零计数；非空批恰开一次事务', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    // spy 包一层 db.transaction 计数（自身有效性由后半段非空批恰 1 次对照）
    let txOpened = 0;
    const raw = db.transaction.bind(db) as (fn: () => unknown) => () => unknown;
    (db as unknown as { transaction: unknown }).transaction = (fn: () => unknown) => {
      txOpened++;
      return raw(fn);
    };
    assert.deepEqual(
      upsertDanmaku(db, videoId, [], { fetchedAt: 1000, batchId: 'b1' }),
      { inserted: 0, updated: 0 },
      '空批零计数',
    );
    assert.equal(txOpened, 0, '空批不应开事务（判停段 0 条无需空事务）');
    upsertDanmaku(db, videoId, [row({ id_str: 'tx1' })], { fetchedAt: 1000, batchId: 'b1' });
    assert.equal(txOpened, 1, '非空批恰开一次事务（spy 有效性对照）');
    assert.equal(countAll(db), 1, 'spy 未破坏写入');
  } finally { db.close(); }
});

test('upsert：同批重复 id_str（跨段池快照重叠）幂等吸收为单行', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    const res = upsertDanmaku(db, videoId, [
      row({ id_str: 'dup', content: '前段版本' }),
      row({ id_str: 'dup', content: '后段版本' }),
    ], { fetchedAt: 1000, batchId: 'b1' });
    assert.deepEqual(res, { inserted: 1, updated: 1 }, '同批第二次出现走 UPDATE');
    const rows = db.prepare('SELECT id_str, content FROM danmaku').all() as Array<{ id_str: string; content: string }>;
    assert.deepEqual(rows, [{ id_str: 'dup', content: '后段版本' }], '后值生效、仅单行');
  } finally { db.close(); }
});

// ── 多 P 共存与 count 聚合（PLAN §3.4）──

test('多 P 共存：两 cid 两 page 并存互不干扰，danmakuCount 按 cid/page 聚合', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    const res = upsertDanmaku(db, videoId, [
      row({ id_str: 'p1a', cid: 100, page: 1 }),
      row({ id_str: 'p1b', cid: 100, page: 1 }),
      row({ id_str: 'p2a', cid: 200, page: 1 }),
      row({ id_str: 'p2b', cid: 200, page: 2 }),
      row({ id_str: 'p2c', cid: 200, page: 2 }),
    ], { fetchedAt: 1000, batchId: 'b1' });
    assert.deepEqual(res, { inserted: 5, updated: 0 });
    const count = danmakuCount(db, videoId);
    assert.equal(count.rows, 5, '总行数跨 P 汇总');
    assert.deepEqual(count.pages, [
      { cid: 100, page: 1, rows: 2 },
      { cid: 200, page: 1, rows: 1 },
      { cid: 200, page: 2, rows: 2 },
    ], '按 cid,page 分组、升序');
  } finally { db.close(); }
});

test('danmakuCount：0 行全空形态；有数据时 progress 跨度取非空原值口径（含 -1）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    assert.deepEqual(danmakuCount(db, videoId), {
      rows: 0, pages: [], max_ctime_s: null, min_progress_ms: null, max_progress_ms: null,
    }, '0 行：pages 空数组、聚合值全 null');

    upsertDanmaku(db, videoId, [
      row({ id_str: 'adv', progress_ms: -1, ctime_s: 100 }),
      row({ id_str: 'nul', progress_ms: null, ctime_s: 200 }),
      row({ id_str: 'pos', progress_ms: 5000, ctime_s: 300 }),
    ], { fetchedAt: 1000, batchId: 'b1' });
    const count = danmakuCount(db, videoId);
    assert.equal(count.rows, 3);
    assert.equal(count.max_ctime_s, 300, 'ctime 最大值');
    assert.equal(count.min_progress_ms, -1, 'min 取非空原值（-1 高级弹幕原值保留，§2.3）');
    assert.equal(count.max_progress_ms, 5000);
  } finally { db.close(); }
});

// ── danmakuTimeline（供 bundle 正文，PLAN §3.4）──

test('danmakuTimeline：按 (cid, progress_ms) 升序（NULL 最前、-1 次之）；同刻按 id 升序；全列返回', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertDanmaku(db, videoId, [
      row({ id_str: 'b-cid200', cid: 200, page: 1, progress_ms: 3000 }),
      row({ id_str: 'a-neg', cid: 100, page: 1, progress_ms: -1 }),
      row({ id_str: 'a-first', cid: 100, page: 1, progress_ms: 1000 }),
      row({ id_str: 'a-second', cid: 100, page: 1, progress_ms: 1000 }),
      row({ id_str: 'a-null', cid: 100, page: 1, progress_ms: null }),
      row({ id_str: 'a-late', cid: 100, page: 1, progress_ms: 2000 }),
    ], { fetchedAt: 1000, batchId: 'b1' });
    const tl = danmakuTimeline(db, videoId);
    assert.deepEqual(tl.map((r) => r.id_str), [
      'a-null',   // SQLite ASC：NULL 排最前（消费端按 §2.3 处置）
      'a-neg',    // 负值（-1 高级弹幕）排 NULL 之后、正点之前
      'a-first',  // 同 (cid, progress_ms)：先插者 id 小在前
      'a-second',
      'a-late',
      'b-cid200', // cid 升序在最后
    ], '全量行按 (cid, progress_ms, id) 升序');
    assert.deepEqual(Object.keys(tl[0]).sort(), [
      'action', 'batch_id', 'cid', 'color', 'content', 'ctime_s', 'first_seen_at', 'fontsize',
      'id', 'id_str', 'last_seen_at', 'mid_hash', 'mode', 'page', 'pool', 'progress_ms',
      'video_id', 'weight',
    ], '行含全部 18 列（含 batch_id/video_id）');
    const got = tl.find((r) => r.id_str === 'a-first')!;
    assert.equal(got.batch_id, 'b1');
    assert.equal(got.video_id, videoId);
    assert.equal(got.content, row0Content(db, 'a-first'), 'content 原样');
  } finally { db.close(); }
});

/** 从库里取该行 content（ timeline 行与库行一致性 spot check 用） */
function row0Content(db: Database.Database, idStr: string): string {
  return (db.prepare('SELECT content FROM danmaku WHERE id_str = ?').get(idStr) as { content: string }).content;
}

// ── verifyDanmaku（PLAN §5.1 R1-R5 / §5.3 回执结构）──

test('verifyDanmaku：60s 直方图按整分钟分桶升序，峰值分钟并列取更早分钟', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertDanmaku(db, videoId, [
      row({ id_str: 'h0', progress_ms: 59000 }),  // 桶 0
      row({ id_str: 'h1', progress_ms: 60000 }),  // 桶 60000
      row({ id_str: 'h2', progress_ms: 61000 }),  // 桶 60000
      row({ id_str: 'h3', progress_ms: 119999 }), // 桶 60000
      row({ id_str: 'h4', progress_ms: 120000 }), // 桶 120000
      row({ id_str: 'h5', progress_ms: 129999 }), // 桶 120000
    ], { fetchedAt: 1000, batchId: 'b1' });
    const v = verifyDanmaku(db, videoId);
    assert.deepEqual(v.timeline.histogram_60s, [
      { from_ms: 0, rows: 1 },
      { from_ms: 60000, rows: 3 },
      { from_ms: 120000, rows: 2 },
    ], 'progress_ms 整除 60000 分桶、from_ms 升序');
    assert.deepEqual(v.timeline.peak_minute, { from_ms: 60000, rows: 3 }, '峰值分钟取 rows 最大桶');
    assert.deepEqual(v.counts, {
      rows: 6, pages: 1, by_page: [{ cid: 100, page: 1, rows: 6 }],
    }, 'counts 段复用 danmakuCount 聚合');

    // 峰值并列：两桶同 rows，取 from_ms 小者（确定性）
    const v2id = insertVideo(db, 'BV1DTIE');
    upsertDanmaku(db, v2id, [
      row({ id_str: 't1', progress_ms: 1000 }),
      row({ id_str: 't2', progress_ms: 2000 }),
      row({ id_str: 't3', progress_ms: 61000 }),
      row({ id_str: 't4', progress_ms: 62000 }),
    ], { fetchedAt: 1000, batchId: 'b1' });
    assert.deepEqual(verifyDanmaku(db, v2id).timeline.peak_minute, { from_ms: 0, rows: 2 }, '并列取更早分钟');
  } finally { db.close(); }
});

test('verifyDanmaku：负 progress 不进直方图；negative_progress 只计 mode<7（NULL mode 三值逻辑排除）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertDanmaku(db, videoId, [
      row({ id_str: 'n1', progress_ms: -1, mode: 1 }),    // 非高级弹幕负点：计入 R1，不进直方图
      row({ id_str: 'n2', progress_ms: -5, mode: 7 }),    // 高级弹幕负点：不计 R1（原值保留）
      row({ id_str: 'n3', progress_ms: -3, mode: null }), // NULL mode：三值逻辑自动排除
      row({ id_str: 'n4', progress_ms: null, mode: 1 }),  // NULL progress：R1 要求 IS NOT NULL
      row({ id_str: 'n5', progress_ms: 1000, mode: 1 }),  // 正点：直方图桶 0
    ], { fetchedAt: 1000, batchId: 'b1' });
    const v = verifyDanmaku(db, videoId);
    assert.equal(v.integrity.negative_progress, 1, 'R1 逐字条件：progress<0 AND mode<7');
    assert.deepEqual(v.timeline.histogram_60s, [{ from_ms: 0, rows: 1 }], '负值/NULL 不进直方图');
    assert.deepEqual(v.timeline.peak_minute, { from_ms: 0, rows: 1 });
    assert.equal(v.timeline.min_progress_ms, -5, 'min 仍取全部非空原值（§2.3 原值保留）');
    assert.equal(v.timeline.max_progress_ms, 1000);
  } finally { db.close(); }
});

test('verifyDanmaku：mode 分布（NULL 不入）；weight 分位 nearest-rank、无值回落 null', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertDanmaku(db, videoId, [
      row({ id_str: 'm1', mode: 1, weight: 1 }),
      row({ id_str: 'm2', mode: 1, weight: 5 }),
      row({ id_str: 'm3', mode: 1, weight: 9 }),
      row({ id_str: 'm4', mode: 5, weight: null }),
      row({ id_str: 'm5', mode: 4, weight: null }),
      row({ id_str: 'm6', mode: null, weight: 6 }), // NULL mode 不入分布；weight 仍入分位
    ], { fetchedAt: 1000, batchId: 'b1' });
    const v = verifyDanmaku(db, videoId);
    assert.deepEqual(v.mode, { '1': 3, '4': 1, '5': 1 }, 'mode 值分布（键为十进制字符串，NULL mode 不入）');
    assert.deepEqual(v.weight, { p50: 5, p90: 9, max: 9 }, '权重集 [1,5,6,9]：p50=ceil(2)-1→5，p90=ceil(3.6)-1→9');

    // 无任何 weight 值 → 全 null（0 是合法权重不作占位）
    const v2id = insertVideo(db, 'BV1DNULL');
    upsertDanmaku(db, v2id, [row({ id_str: 'w1', weight: null })], { fetchedAt: 1000, batchId: 'b1' });
    assert.deepEqual(verifyDanmaku(db, v2id).weight, { p50: null, p90: null, max: null }, '无 weight 行全 null');
  } finally { db.close(); }
});

test('verifyDanmaku：dup_id 防御断言恒 0 + ctime 范围；空视频全空形态', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    assert.deepEqual(verifyDanmaku(db, videoId), {
      counts: { rows: 0, pages: 0, by_page: [] },
      timeline: { min_progress_ms: null, max_progress_ms: null, histogram_60s: [], peak_minute: null },
      mode: {},
      weight: { p50: null, p90: null, max: null },
      integrity: { dup_id: 0, negative_progress: 0 },
      ctime: { min_s: null, max_s: null },
    }, '空视频：各段空形态（§5.3 结构完整不缺键）');

    upsertDanmaku(db, videoId, [
      row({ id_str: 'c1', ctime_s: 1593092327 }),
      row({ id_str: 'c2', ctime_s: 1791348874 }),
    ], { fetchedAt: 1000, batchId: 'b1' });
    const v = verifyDanmaku(db, videoId);
    assert.equal(v.integrity.dup_id, 0, 'UNIQUE(id_str) 下 dup_id 恒 0（COUNT vs COUNT DISTINCT 防御断言，触发即库损坏）');
    assert.deepEqual(v.ctime, { min_s: 1593092327, max_s: 1791348874 }, 'ctime 范围（B 站原值 unix 秒）');
  } finally { db.close(); }
});

// ── 索引断言（comments.test.ts 先例）──

test('索引存在性：danmaku 两索引齐全（sqlite_master）', () => {
  const db = freshDb();
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='danmaku' ORDER BY name").all() as Array<{ name: string }>)
      .map((r) => r.name);
    assert.deepEqual(names, ['idx_danmaku_id', 'idx_danmaku_video']);
  } finally { db.close(); }
});
