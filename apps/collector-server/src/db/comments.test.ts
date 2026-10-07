// comments 持久层测试（2026-10-03 评论采集解冻，C1，PLAN docs/plans/comments/PLAN.md §3/§5/§7.1）：
// v20 迁移（新库/旧库/双写漂移）、upsert 幂等（观测列更新/首采列保留/R0 三元组修正）、
// 置顶先清后打、missing 两轮对账四态（仅根）、verifyTree R0-R9 违例夹具、count 水位、索引断言。
// 夹具：:memory: 库 + migrate + runMigrations 种子；视频行手插（comments.video_id 外键引用 videos.id）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | v20 迁移/双写/upsert/pins/missing 四态/R0-R9/count/索引/树查询 | 通过 | 2026-10-04 C1 |
// | R2 | v21 parent_reply_name 迁移(新旧库重放/双写结构化比对)/upsert 回填/with_pictures 计数 | 通过 | 2026-10-07 媒体信息轻量增强 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, runMigrations, MIGRATIONS } from './migrate.js';
import {
  upsertComments,
  clearAndSetPins,
  reconcileMissing,
  commentsCount,
  treeByVideo,
} from './comments.js';
import type { CommentUpsertRow, CommentRecord } from './comments.js';
import { verifyTree, coverageOfRoots } from './comments-verify.js';

/** 最新迁移步骤版本号（MIGRATIONS 尾元素）。comments 是 v20；其后有 v21 jobs、v22 danmaku——LATEST 随最新迁移走，不再恒等于 comments 版本号 */
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  return db;
}

function insertVideo(db: Database.Database, sourceVid = 'BV1C1'): number {
  return Number(db.prepare(
    "INSERT INTO videos (source, source_vid, title, first_seen_at, updated_at) VALUES ('bilibili', ?, '测试视频', 1, 1)",
  ).run(sourceVid).lastInsertRowid);
}

let seq = 0;
/** 构造归一化评论行：缺省为根评论形态（root/parent/dialog='0'） */
function row(over: Partial<CommentUpsertRow> = {}): CommentUpsertRow {
  seq++;
  return {
    rpid_str: over.rpid_str ?? `r${seq}`,
    root_rpid: '0',
    parent_rpid: '0',
    dialog_rpid: '0',
    mid_str: '100',
    uname: '用户A',
    parent_reply_name: null,
    member: '{"name":"用户A"}',
    message: '正文',
    content: '{}',
    like_count: 5,
    rcount: 0,
    reply_total: 0,
    ctime_s: 1000,
    ip_location: '上海',
    state: 0,
    invisible: 0,
    folded: 0,
    up_like: 0,
    up_reply: 0,
    ...over,
  };
}

/** 楼中楼直接回复根（§2.4：root=楼根、parent=楼根、dialog=自身） */
function replyToRoot(rpid: string, root: string, over: Partial<CommentUpsertRow> = {}): CommentUpsertRow {
  return row({ rpid_str: rpid, root_rpid: root, parent_rpid: root, dialog_rpid: rpid, ...over });
}

const getRow = (db: Database.Database, rpid: string): CommentRecord =>
  db.prepare('SELECT * FROM comments WHERE rpid_str = ?').get(rpid) as CommentRecord;

// ── v20/v21 迁移与双写 ──

test('v20 迁移：新库建 comments 表 + user_version 写到最新 + 重放幂等', () => {
  const db = freshDb();
  try {
    assert.equal(LATEST, 23, 'MIGRATIONS 尾元素应为最新迁移（主线 v21 jobs/v22 danmaku + v23 comments 补列）');
    assert.equal(db.pragma('user_version', { simple: true }), LATEST, '新库账本应写到最新');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='comments'").all();
    assert.equal(tables.length, 1, 'comments 表应存在');
    // 重放幂等
    assert.doesNotThrow(() => runMigrations(db));
    assert.equal(db.inTransaction, false, '不应残留打开的事务');
  } finally { db.close(); }
});

test('v23 迁移：新库（schema.sql 直建已带列）重放 ALTER 撞 duplicate 被容忍，列在且数据不丢', () => {
  // 新库逐版重放路径（v23 双写策略的另一半）：schema.sql 的 CREATE 已含 parent_reply_name（列位殿后），
  // 把账本拨回 v20 模拟「逐版重放到 v20 刚建完表」的中间态 → v23 ALTER 报 duplicate column name
  // → 账本双保险容忍（migrate.ts 账本规则），账本记到最新，列不重复。
  const db = new Database(':memory:');
  migrate(db); // 仅 schema.sql，账本还是 0
  try {
    const videoId = insertVideo(db);
    db.prepare(`INSERT INTO comments (rpid_str, video_id, parent_reply_name, first_seen_at, last_seen_at)
                VALUES ('legacy1', ?, '拾月晨光', 1, 1)`).run(videoId);
    db.pragma('user_version = 20');
    assert.doesNotThrow(() => runMigrations(db), '新库重放 v21 的 duplicate column 应被容忍');
    assert.equal(db.pragma('user_version', { simple: true }), LATEST, '账本应记到最新');
    const cols = (db.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.equal(cols.filter((n) => n === 'parent_reply_name').length, 1, '列恰好一个（ADD 未重复执行）');
    assert.equal(cols[cols.length - 1], 'parent_reply_name', '列位殿后（与 v23 ALTER 追加序一致，双路 table_info 同序的前提）');
    assert.equal((getRow(db, 'legacy1') as { parent_reply_name: string | null }).parent_reply_name, '拾月晨光', '重放不丢数据');
    assert.doesNotThrow(() => runMigrations(db), '再跑一遍幂等');
  } finally { db.close(); }
});

test('v20 迁移：旧库（账本 v19、无 comments 表）逐版重放 v20+v21 补建且可写；重放幂等', () => {
  const db = freshDb();
  try {
    db.exec('DROP TABLE comments');
    db.pragma('user_version = 19');
    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), LATEST, '账本应补到最新（v20 comments + v21 jobs + v22 danmaku + v23 comments 补列，均幂等）');
    const cols = (db.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('parent_reply_name'), 'v20 建表（无该列）→ v23 ALTER 追加，终态带列');
    const videoId = insertVideo(db);
    const r = upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b1',
      replies: [row({ rpid_str: 'old1' })],
    });
    assert.deepEqual(r, { inserted: 1, updated: 0 }, '补建后的表应可正常写入');
    assert.doesNotThrow(() => runMigrations(db), '重放不报错');
  } finally { db.close(); }
});

test('v21 迁移：旧库（账本 v20、无该列）ALTER 补列且存量行 NULL；重放幂等', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    // 先落一行再模拟旧库：DROP 列后账本拨回 v20（v20 生产库的真实形态：有表无列）
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b1',
      replies: [row({ rpid_str: 'oldv21', parent_reply_name: '会被删掉的值' })],
    });
    db.exec('ALTER TABLE comments DROP COLUMN parent_reply_name');
    db.pragma('user_version = 20');
    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), LATEST, '账本应补到最新');
    const r = getRow(db, 'oldv21') as { parent_reply_name: string | null };
    assert.equal(r.parent_reply_name, null, '存量行补列后为 NULL（等重采回填）');
    assert.doesNotThrow(() => runMigrations(db), '重放不报错（ALTER 幂等容忍）');
    // 补列后写入通路完好（parent_reply_name 走 INSERT/UPDATE 全链）
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 2000, batchId: 'b1',
      replies: [row({ rpid_str: 'oldv21', parent_reply_name: '回填者' })],
    });
    assert.equal((getRow(db, 'oldv21') as { parent_reply_name: string | null }).parent_reply_name, '回填者', '补列后 upsert 可写该列');
  } finally { db.close(); }
});

test('双写一致性：schema.sql 与 v20+v23 statements 产出的 comments 结构一致（列结构 table_info + 索引 DDL）', () => {
  // ALTER 加列步骤（主线编号 v23；原 v21）起双写比对从 sqlite_master.sql 逐字退化为结构化：
  // ALTER 加列后 SQLite 会重写 CREATE 原文（实测把 ", parent_reply_name TEXT)" 拼接在末列行后），
  // 与 schema.sql 直建的行内格式（含行尾注释）不可逐字重合——故 CREATE TABLE 文本只比结构
  // （PRAGMA table_info 五元组），索引仍可逐字（CREATE INDEX 语句 ALTER 不触碰）。
  // 双写策略结论登记于 migrate.ts v23 注释。
  const db = freshDb();
  try {
    const capture = () => ({
      columns: db.prepare('PRAGMA table_info(comments)').all() as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>,
      indexes: db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='comments' ORDER BY name").all(),
    });
    const before = capture();
    assert.equal(before.indexes.length, 4, '应为 4 个索引');
    assert.equal(before.columns.at(-1)!.name, 'parent_reply_name', '新列殿后');
    db.exec('DROP TABLE comments'); // 表级索引随表删
    for (const s of MIGRATIONS.filter((m) => m.version === 20 || m.version === 23)) {
      for (const stmt of s.statements) db.exec(stmt);
    }
    const after = capture();
    assert.deepEqual(after.columns, before.columns, '两路建库的列结构（cid/name/type/notnull/dflt/pk）逐项一致');
    assert.deepEqual(after.indexes, before.indexes, '两路建库的索引 DDL 逐字一致');
  } finally { db.close(); }
});

// ── upsert 幂等（§7.1：同 rpid 二次：like 更新、first_seen_at/batch_id 保留）──

test('upsert 幂等：同 rpid 二次入库更新观测列、保留首采列，返回 inserted/updated 计数', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    const r1 = row({ rpid_str: 'idem', like_count: 5, ctime_s: 1000, uname: '旧名' });
    let res = upsertComments(db, {
      videoId, upperMid: '100', fetchedAt: 1000, batchId: 'batch-1', page: 2, sort: 'time',
      replies: [r1],
    });
    assert.deepEqual(res, { inserted: 1, updated: 0 });

    res = upsertComments(db, {
      videoId, upperMid: '100', fetchedAt: 2000, batchId: 'batch-2', page: 9, sort: 'hot',
      replies: [row({ rpid_str: 'idem', like_count: 9, ctime_s: 1000, uname: '新名', ip_location: '北京' })],
    });
    assert.deepEqual(res, { inserted: 0, updated: 1 }, '二次入库是 UPDATE 非新行');

    const got = getRow(db, 'idem');
    // 观测列已更新
    assert.equal(got.like_count, 9, 'like_count 更新');
    assert.equal(got.uname, '新名', 'uname 随 member 快照刷新');
    assert.equal(got.ip_location, '北京');
    assert.equal(got.last_seen_at, 2000, 'last_seen_at 刷到本次 fetchedAt');
    // 首采列保留
    assert.equal(got.first_seen_at, 1000, 'first_seen_at 保留首采值');
    assert.equal(got.batch_id, 'batch-1', 'batch_id 保留首采批次');
    assert.equal(got.first_page, 2, 'first_page 保留首采页序');
    assert.equal(got.first_sort, 'time', 'first_sort 保留首采排序');
    assert.equal(got.video_id, videoId, 'video_id 不改写');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n, 1, '不产生新行');
  } finally { db.close(); }
});

test('upsert：parent_reply_name 首采落值、重采回填/改写（存量行 NULL → 有值 → 换值全链）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    // 首采缺 parent_reply_member（如楼中楼专翻前的旧形态/直回根）→ NULL
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b1',
      replies: [row({ rpid_str: 'prn', parent_reply_name: null })],
    });
    assert.equal(getRow(db, 'prn').parent_reply_name, null, '缺失首采落 NULL');
    // 重采带快照 → 回填（零重采政策的例外入口：upsert 更新列含该列）
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 2000, batchId: 'b1',
      replies: [row({ rpid_str: 'prn', parent_reply_name: '拾月晨光' })],
    });
    assert.equal(getRow(db, 'prn').parent_reply_name, '拾月晨光', '重采回填非 NULL 值');
    // 再采对方改名 → 整体替换（与 uname/member 快照同语义）
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 3000, batchId: 'b1',
      replies: [row({ rpid_str: 'prn', parent_reply_name: '拾月新名' })],
    });
    assert.equal(getRow(db, 'prn').parent_reply_name, '拾月新名', '重采改写为新快照值');
    // upperMid 缺省分支（楼中楼批）同样更新该列
    upsertComments(db, {
      videoId, fetchedAt: 4000, batchId: 'b1',
      replies: [row({ rpid_str: 'prn', parent_reply_name: '无名批也可回填' })],
    });
    assert.equal(getRow(db, 'prn').parent_reply_name, '无名批也可回填', 'upperMid=null 的 UPDATE 分支含该列');
  } finally { db.close(); }
});

test('upsert：is_up 按本请求 upper_mid 重算（String 直读防御）；upperMid 缺省时保留库内值', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    // upper.mid 数值形态传入（number），mid_str 字符串 '100' → String() 比较命中
    upsertComments(db, { videoId, upperMid: 100, fetchedAt: 1000, batchId: 'b1', replies: [row({ rpid_str: 'up1', mid_str: '100' })] });
    assert.equal(getRow(db, 'up1').is_up, 1, 'UP 主自己的评论 is_up=1（number→String 归一）');
    // 重采 upper_mid 变化 → 重算为 0
    upsertComments(db, { videoId, upperMid: '999', fetchedAt: 2000, batchId: 'b2', replies: [row({ rpid_str: 'up1', mid_str: '100' })] });
    assert.equal(getRow(db, 'up1').is_up, 0, 'upper_mid 不再匹配 → 重算为 0');
    // upperMid 缺省（楼中楼批无主接口上下文）→ 保留库内 is_up
    upsertComments(db, { videoId, fetchedAt: 3000, batchId: 'b3', replies: [row({ rpid_str: 'up1', mid_str: '100' })] });
    assert.equal(getRow(db, 'up1').is_up, 0, 'upperMid 缺省不改写 is_up');
    // 首采即无 upperMid → 落 0
    upsertComments(db, { videoId, fetchedAt: 4000, batchId: 'b4', replies: [row({ rpid_str: 'up2', mid_str: '100' })] });
    assert.equal(getRow(db, 'up2').is_up, 0, '无 upper_mid 的首采行 is_up=0');
  } finally { db.close(); }
});

test('upsert：同批重复 rpid（置顶+列表双出现）幂等吸收为单行', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    const res = upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b1',
      replies: [row({ rpid_str: 'dup', like_count: 5 }), row({ rpid_str: 'dup', like_count: 7 })],
    });
    assert.deepEqual(res, { inserted: 1, updated: 1 }, '同批第二次出现走 UPDATE');
    const rows = db.prepare('SELECT rpid_str, like_count FROM comments').all() as Array<{ rpid_str: string; like_count: number }>;
    assert.deepEqual(rows, [{ rpid_str: 'dup', like_count: 7 }], '后值生效、仅单行');
  } finally { db.close(); }
});

// ── 关联三元组：防御性保留 + R0 违例修正（§3.3）──

test('upsert：关联三元组防御性保留——库内自洽时不被新值改写', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b1',
      replies: [row({ rpid_str: 'root1' })], // 自洽根行（0/0/0）
    });
    // 新值形态自洽（楼行 999/999/999）但与首采不同 → 首采值防御性保留
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 2000, batchId: 'b2',
      replies: [row({ rpid_str: 'root1', root_rpid: '999', parent_rpid: '999', dialog_rpid: '999' })],
    });
    const got = getRow(db, 'root1');
    assert.equal(got.root_rpid, '0', 'root_rpid 保留首采值');
    assert.equal(got.parent_rpid, '0', 'parent_rpid 保留首采值');
    assert.equal(got.dialog_rpid, '0', 'dialog_rpid 保留首采值');
    assert.equal(got.is_root, 1);
  } finally { db.close(); }
});

test('upsert：R0 违例修正——库内现值违反 R0 且新值自洽 → 以新值修正并打 [store] 日志', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, { videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b1', replies: [row({ rpid_str: 'fix1' })] });
    // 直接 SQL 造库内脏数据：根行 parent 指向他人（违反 R0——root='0' 而 parent!=='0'）
    db.prepare("UPDATE comments SET parent_rpid = 'p999', dialog_rpid = 'p999' WHERE rpid_str = 'fix1'").run();
    assert.equal(getRow(db, 'fix1').parent_rpid, 'p999', '夹具就位：库内已是脏三元组');

    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
    let res;
    try {
      res = upsertComments(db, {
        videoId, upperMid: '1', fetchedAt: 2000, batchId: 'b2',
        replies: [row({ rpid_str: 'fix1', root_rpid: '0', parent_rpid: '0', dialog_rpid: '0' })],
      });
    } finally { console.error = orig; }

    assert.deepEqual(res, { inserted: 0, updated: 1 });
    const got = getRow(db, 'fix1');
    assert.equal(got.parent_rpid, '0', 'parent 以自洽新值修正');
    assert.equal(got.dialog_rpid, '0', 'dialog 一并修正');
    assert.equal(got.is_root, 1, 'is_root 派生列随修正重算');
    assert.equal(got.last_seen_at, 2000, '修正轮观测列照常更新');
    assert.ok(errs.some((e) => e.includes('[store]') && e.includes('R0') && e.includes('fix1')),
      `应打 [store] R0 修正日志，实际：${JSON.stringify(errs)}`);
  } finally { db.close(); }
});

test('upsert：新值同样违反 R0 → 不修正（不自洽脏数据不固化）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, { videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b1', replies: [row({ rpid_str: 'keep1' })] });
    db.prepare("UPDATE comments SET parent_rpid = 'pX' WHERE rpid_str = 'keep1'").run(); // 库内违反 R0
    // 新值也不自洽（楼行 parent='0'）→ 保留库内现值不改写
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 2000, batchId: 'b2',
      replies: [row({ rpid_str: 'keep1', root_rpid: '888', parent_rpid: '0', dialog_rpid: '888' })],
    });
    const got = getRow(db, 'keep1');
    assert.equal(got.root_rpid, '0', '不自洽新值不写入 root');
    assert.equal(got.parent_rpid, 'pX', '不自洽新值不写入 parent（脏维持原状，交校验器报告）');
  } finally { db.close(); }
});

// ── 置顶先清后打（§3.3）──

test('clearAndSetPins：先清后打——换置顶自然生效；incremental 不调用则 pin_kind 不动', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b1',
      replies: [row({ rpid_str: 'p1' }), row({ rpid_str: 'p2' }), row({ rpid_str: 'p3' })],
    });
    // full 轮 1：p1 置 upper
    let r = clearAndSetPins(db, videoId, [{ rpid_str: 'p1', kind: 'upper' }]);
    assert.equal(getRow(db, 'p1').pin_kind, 'upper');
    assert.equal(getRow(db, 'p2').pin_kind, null);
    assert.equal(r.cleared, 0, '首轮无既有置顶可清');
    assert.equal(r.set, 1);
    // full 轮 2：换 p2 置 vote → p1 自动清
    r = clearAndSetPins(db, videoId, [{ rpid_str: 'p2', kind: 'vote' }]);
    assert.equal(r.cleared, 1, '旧置顶被清');
    assert.equal(getRow(db, 'p1').pin_kind, null, '置顶撤销自然生效');
    assert.equal(getRow(db, 'p2').pin_kind, 'vote');
    // incremental 轮：不发 pins、不调用本函数 → p2 保持
    upsertComments(db, { videoId, upperMid: '1', fetchedAt: 3000, batchId: 'b3', replies: [row({ rpid_str: 'p2', like_count: 99 })] });
    assert.equal(getRow(db, 'p2').pin_kind, 'vote', '增量轮 upsert 不动 pin_kind');
    // 引用不存在行不报错、set 只计命中
    r = clearAndSetPins(db, videoId, [{ rpid_str: 'ghost', kind: 'admin' }, { rpid_str: 'p2', kind: 'admin' }]);
    assert.equal(r.set, 1, 'ghost 行不计 set');
    assert.equal(getRow(db, 'p2').pin_kind, 'admin');
  } finally { db.close(); }
});

// ── missing 对账四态：NULL→候选→确认→恢复（仅根评论、仅完整轮由调用方保证）──

test('reconcileMissing 四态：候选→确认→恢复；楼层行缺席不参与（is_root=1 双守卫）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    const ups = (fetchedAt: number, replies: CommentUpsertRow[]) =>
      upsertComments(db, { videoId, upperMid: '1', fetchedAt, batchId: `b${fetchedAt}`, replies });
    // 轮 1（完整）：根 A、B 与 A 的楼层 F 首采，scan_start=1000
    ups(1000, [row({ rpid_str: 'A', ctime_s: 900 }), row({ rpid_str: 'B', ctime_s: 950 }),
      replyToRoot('F', 'A', { ctime_s: 990 })]);
    assert.deepEqual(reconcileMissing(db, { videoId, scanStart: 1000 }),
      { candidates: 0, restored: 2, confirmed: 0 }, '首轮全员在场：无候选；restored 按 SQL matched 口径计在场根');
    assert.equal(getRow(db, 'B').missing_since, null, '态 1：NULL=在库正常');

    // 轮 2（完整）：B 缺席 → 置候选；F（楼层）虽也未翻到但不参与
    ups(2500, [row({ rpid_str: 'A' })]);
    assert.deepEqual(reconcileMissing(db, { videoId, scanStart: 2000 }),
      { candidates: 1, restored: 1, confirmed: 0 }, '态 2：B 首次缺席=候选；确认仍为 0（两轮语义）');
    assert.equal(getRow(db, 'B').missing_since, 2000, 'missing_since=本轮 scan_start');
    assert.equal(getRow(db, 'F').missing_since, null, '楼层行缺席不置 missing（仅根参与）');

    // 轮 3（完整）：B 仍未再见 → 确认（候选置值轮+比对轮，两轮均完整）
    ups(3500, [row({ rpid_str: 'A' })]);
    assert.deepEqual(reconcileMissing(db, { videoId, scanStart: 3000 }),
      { candidates: 0, restored: 1, confirmed: 1 }, '态 3：置值后仍未再见=确认缺失（≥2 轮）');
    assert.ok(getRow(db, 'B').last_seen_at < (getRow(db, 'B').missing_since as number), 'last_seen < missing_since');

    // 轮 4（完整）：B 重新见到 → 恢复（missing_since 清 NULL）
    ups(4500, [row({ rpid_str: 'A' }), row({ rpid_str: 'B' })]);
    assert.deepEqual(reconcileMissing(db, { videoId, scanStart: 4000 }),
      { candidates: 0, restored: 2, confirmed: 0 }, '态 4：A/B 均在场');
    assert.equal(getRow(db, 'B').missing_since, null, '恢复后 missing_since 清回 NULL');
    assert.equal(getRow(db, 'F').missing_since, null, '全程楼层行不受对账影响');
  } finally { db.close(); }
});

test('reconcileMissing：partial 轮守卫由调用方负责——直接调用即对账（db 层无守卫重复）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, { videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b1', replies: [row({ rpid_str: 'only' })] });
    // 假设调用方未做完整轮守卫就传入更晚 scan_start：db 层照常执行（守卫职责在 http/cli）
    const r = reconcileMissing(db, { videoId, scanStart: 99999 });
    assert.deepEqual(r, { candidates: 1, restored: 0, confirmed: 0 });
  } finally { db.close(); }
});

// ── commentsCount（§4.1 count 端点查询）──

test('commentsCount：rows/roots/maxCtimeS；水位只取根评论最大 ctime_s（楼层追新不抬水位）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b1',
      replies: [
        row({ rpid_str: 'rA', ctime_s: 100 }), // 根
        row({ rpid_str: 'rB', ctime_s: 500 }), // 根（最新根）
        replyToRoot('f1', 'rA', { ctime_s: 9000 }), // 楼中楼回复晚于全部根（老楼追新）
      ],
    });
    assert.deepEqual(commentsCount(db, videoId), { rows: 3, roots: 2, maxCtimeS: 500 },
      'max_ctime_s 只统计根：若混入楼层 9000，incremental 首页即判停会漏采新根（§4.3）');
  } finally { db.close(); }
});

test('commentsCount：视频在库但零评论 → rows/roots 0、maxCtimeS null（非 404 语义）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db, 'BV-EMPTY');
    assert.deepEqual(commentsCount(db, videoId), { rows: 0, roots: 0, maxCtimeS: null });
  } finally { db.close(); }
});

// ── R4 覆盖率纯逻辑（coverageOfRoots）──

test('coverageOfRoots：分母优先 page.count、fallback rcount、≤0 跳过；缺口/overshoot/ratio 口径', () => {
  // r1：pageCount=5 实采 4 → 缺 1（分母=page.count）
  // r2：无 pageCount，rcount=3 实采 1 → 缺 2（分母=rcount fallback）
  // r3：pageCount=2 实采 3 → overshoot（缺口 clamp 0）
  // r4：无 pageCount 且 rcount=0 → 分母 ≤0 不计入分子分母
  const s = coverageOfRoots([
    { rootRpid: 'r1', pageCount: 5, rcount: 0, actualFloors: 4 },
    { rootRpid: 'r2', pageCount: null, rcount: 3, actualFloors: 1 },
    { rootRpid: 'r3', pageCount: 2, rcount: 0, actualFloors: 3 },
    { rootRpid: 'r4', pageCount: null, rcount: 0, actualFloors: 0 },
  ]);
  assert.equal(s.mismatch, 2);
  assert.deepEqual(s.samples, ['r2(缺 2,分母=rcount fallback)', 'r1(缺 1,分母=page.count)'],
    '样本按缺口降序（top 语义），注记分母来源');
  assert.equal(s.overshoot, 1, '实采>分母 clamp 为 0 并计 overshoot');
  assert.equal(s.floorCovered, 4 + 1 + 2, 'Σ min(实采,分母)，r4 不计入');
  assert.equal(s.floorExpected, 5 + 3 + 2, 'Σ 分母，r4 不计入');
  assert.equal(s.ratio, Math.round((7 / 10) * 10000) / 10000);
});

test('coverageOfRoots：样本截断至 sampleLimit；全空视频 ratio=1', () => {
  const entries = Array.from({ length: 15 }, (_, i) => ({
    rootRpid: `x${i}`, pageCount: null, rcount: 10, actualFloors: 0,
  }));
  const s = coverageOfRoots(entries, 10);
  assert.equal(s.mismatch, 15);
  assert.equal(s.samples.length, 10, '§5.1 取 top 10 样本');
  assert.equal(coverageOfRoots([]).ratio, 1, '无有效分母（含空视频）按无缺失处理');
});

// ── verifyTree R0-R9 违例夹具（§7.1：各造一个）──

test('verifyTree R0：三元组不自洽计入 triple_inconsistent（根行 parent 非零）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, { videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b', replies: [row({ rpid_str: 'bad0' })] });
    db.prepare("UPDATE comments SET parent_rpid = 'px' WHERE rpid_str = 'bad0'").run(); // 造违例
    const v = verifyTree(db, videoId);
    assert.equal(v.integrity.triple_inconsistent, 1);
  } finally { db.close(); }
});

test('verifyTree R1：楼中楼 root 指向库内不存在的行 → orphan_floor', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b',
      replies: [row({ rpid_str: 'ok1' }), row({ rpid_str: 'orphan', root_rpid: 'ghostRoot', parent_rpid: 'ghostRoot', dialog_rpid: 'orphan' })],
    });
    const v = verifyTree(db, videoId);
    assert.equal(v.integrity.orphan_floor, 1);
  } finally { db.close(); }
});

test('verifyTree R2：parent 悬空 → dangling_parent', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    // 根在库、楼内条目 parent 指向已删的 Y（root 恒指根 → 不产生 R1）
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b',
      replies: [row({ rpid_str: 'root2' }), row({ rpid_str: 'c2', root_rpid: 'root2', parent_rpid: 'ghostY', dialog_rpid: 'ghostY' })],
    });
    const v = verifyTree(db, videoId);
    assert.equal(v.integrity.dangling_parent, 1);
    assert.equal(v.integrity.orphan_floor, 0, 'root 在库 → 不误报 R1');
  } finally { db.close(); }
});

test('verifyTree R3：dialog 悬空（指向既不在库也非自身）→ dangling_dialog；直回根 dialog=自身不算', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b',
      replies: [
        row({ rpid_str: 'root3' }),
        replyToRoot('direct', 'root3'), // dialog=自身 → 不算悬空（§7.3 回归例）
        row({ rpid_str: 'd3', root_rpid: 'root3', parent_rpid: 'root3', dialog_rpid: 'ghostD' }),
      ],
    });
    const v = verifyTree(db, videoId);
    assert.equal(v.integrity.dangling_dialog, 1, '仅 ghostD 一条');
  } finally { db.close(); }
});

test('verifyTree R4：rcount 对账（fallback 分母）+ samples 注记分母来源 + overshoot', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b',
      replies: [
        row({ rpid_str: 'rt4', rcount: 3 }), // 分母 fallback=3，实采 1 → 缺 2
        replyToRoot('f4a', 'rt4'),
        row({ rpid_str: 'rt5', rcount: 0 }), // 分母 0 → 不计入
      ],
    });
    const v = verifyTree(db, videoId);
    assert.equal(v.integrity.rcount_mismatch, 1);
    assert.deepEqual(v.integrity.rcount_mismatch_samples, ['rt4(缺 2,分母=rcount fallback)']);
    assert.equal(v.integrity.overshoot, 0);
    assert.deepEqual(v.coverage, { floor_covered: 1, floor_expected: 3, ratio: 0.3333 });
    // 采集轮传入实时 page.count 分母 + overshoot 形态
    const v2 = verifyTree(db, videoId, { rootPageCounts: { rt4: 1, rt5: 2 } });
    assert.equal(v2.integrity.overshoot, 0, 'rt4 实采 1 = pageCount 1，不超');
    assert.equal(v2.integrity.rcount_mismatch, 1, 'rt4 无缺口；rt5 实采 0 缺 pageCount 2');
    assert.deepEqual(v2.integrity.rcount_mismatch_samples, ['rt5(缺 2,分母=page.count)']);
  } finally { db.close(); }
});

test('verifyTree R4 overshoot：实采超过 page.count 分母 → 缺口 clamp 0 并计 overshoot', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b',
      replies: [
        row({ rpid_str: 'ro', rcount: 0 }),
        replyToRoot('fo1', 'ro'), replyToRoot('fo2', 'ro'), replyToRoot('fo3', 'ro'), // 实采 3
      ],
    });
    const v = verifyTree(db, videoId, { rootPageCounts: { ro: 2 } }); // 双来源重复场景：分母 2 < 实采 3
    assert.equal(v.integrity.overshoot, 1);
    assert.equal(v.integrity.rcount_mismatch, 0, '缺口 clamp 为 0');
    assert.deepEqual(v.coverage, { floor_covered: 2, floor_expected: 2, ratio: 1 }, '分子 clamp 到分母');
  } finally { db.close(); }
});

test('verifyTree R5：reply_total < rcount（历史总数 < 可见数）→ field_anomaly', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b',
      replies: [row({ rpid_str: 'bad5', reply_total: 2, rcount: 5 }), row({ rpid_str: 'ok5', reply_total: 8, rcount: 5 })],
    });
    const v = verifyTree(db, videoId);
    assert.equal(v.integrity.field_anomaly, 1, '仅 bad5 一条');
  } finally { db.close(); }
});

test('verifyTree R6：UNIQUE 约束下 dup_rpid 恒 0（防御性断言，COUNT vs DISTINCT）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b',
      replies: [row({ rpid_str: 'a6' }), row({ rpid_str: 'b6' })],
    });
    assert.equal(verifyTree(db, videoId).integrity.dup_rpid, 0);
  } finally { db.close(); }
});

test('verifyTree R7：missing 分档——missing_since 非空计候选，其中 last_seen < missing_since 计确认', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, { videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b', replies: [row({ rpid_str: 'n1' })] });
    // 直接 SQL 摆两档：n1=确认态（置值后未再见到，last_seen 停在置值前）；n2=候选态（本轮刚置值、last_seen 仍在推进）
    db.prepare("UPDATE comments SET missing_since = 2000, last_seen_at = 1000 WHERE rpid_str = 'n1'").run();
    upsertComments(db, { videoId, upperMid: '1', fetchedAt: 3000, batchId: 'b2', replies: [row({ rpid_str: 'n2' })] });
    db.prepare("UPDATE comments SET missing_since = 2500 WHERE rpid_str = 'n2'").run(); // last_seen 3000 ≥ 2500
    const v = verifyTree(db, videoId);
    assert.equal(v.counts.missing_candidates, 2);
    assert.equal(v.counts.missing_confirmed, 1, '仅 n1（last_seen 1000 < missing_since 2000）');
  } finally { db.close(); }
});

test('verifyTree R8：楼中楼 ctime_s 早于根行 → time_anomaly', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b',
      replies: [
        row({ rpid_str: 'root8', ctime_s: 2000 }),
        replyToRoot('f8', 'root8', { ctime_s: 1000 }), // 回复早于根
        replyToRoot('f8b', 'root8', { ctime_s: 2500 }),
      ],
    });
    assert.equal(verifyTree(db, videoId).integrity.time_anomaly, 1);
  } finally { db.close(); }
});

test('verifyTree R9：活跃行数 vs 外部总量（all_count/stat.reply 口径），相对偏差 >10% 计 gap', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    const replies = [
      row({ rpid_str: 'g1' }), row({ rpid_str: 'g2' }), row({ rpid_str: 'g3' }), row({ rpid_str: 'g4' }),
      replyToRoot('gf1', 'g1'), replyToRoot('gf2', 'g1'), // 库内共 6 行（4 根 + 2 楼）
    ];
    upsertComments(db, { videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b', replies });
    // 外部总量是评论区总量口径（含楼中楼）：活跃 6 行 vs 7 → 偏差 1/7≈14.3% > 10%
    assert.equal(verifyTree(db, videoId, { externalTotal: 7 }).integrity.root_count_gap, 1);
    assert.equal(verifyTree(db, videoId, { externalTotal: 6 }).integrity.root_count_gap, 0, '偏差 0 → 不报');
    assert.equal(verifyTree(db, videoId).integrity.root_count_gap, 0, '未传外部参照 → 跳过 R9');
    // 确认缺失的根从活跃行数中扣除：g4 置确认缺失 → 活跃 5 行 vs 外部 6 → 偏差 1/6≈16.7% > 10%
    db.prepare("UPDATE comments SET missing_since = 500, last_seen_at = 100 WHERE rpid_str = 'g4'").run();
    assert.equal(verifyTree(db, videoId, { externalTotal: 6 }).integrity.root_count_gap, 1);
    assert.equal(verifyTree(db, videoId, { externalTotal: 5 }).integrity.root_count_gap, 0);
  } finally { db.close(); }
});

// ── verifyTree 统计段（depth/like/up/ip）──

test('verifyTree 统计段：depth 按 parent 链（互复链 >2）、like 分位、up 计数、ip 分布', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    // upperMid='999' 与所有 mid 不同 → is_up 全 0（隔离 is_up 对 up 统计断言的干扰）
    upsertComments(db, {
      videoId, upperMid: '999', fetchedAt: 1000, batchId: 'b',
      replies: [
        row({ rpid_str: 't1', like_count: 917, up_reply: 1, up_like: 0, ip_location: '上海' }),
        replyToRoot('t2', 't1', { like_count: 12, up_like: 1, ip_location: '北京' }),
        row({ rpid_str: 't3', root_rpid: 't1', parent_rpid: 't2', dialog_rpid: 't2', like_count: 0, ip_location: null }), // 楼内互复 → 深度 3
        row({ rpid_str: 't4', like_count: 0, ip_location: '上海' }),
      ],
    });
    const v = verifyTree(db, videoId);
    assert.deepEqual(v.counts, {
      roots: 2, floors: 2, total: 4, pins: 0, missing_candidates: 0, missing_confirmed: 0,
      with_pictures: 0, // 夹具 content='{}' 全无 pictures 键 → 0
    });
    assert.deepEqual(v.depth, { max: 3, histogram: { '1': 2, '2': 1, '3': 1 } }, '深度按 parent 链：t3 挂在 t2 下');
    // like 升序 [0,0,12,917]：p50=nearest-rank ceil(0.5×4)=第2个=0；p90=ceil(3.6)=第4个=917
    assert.deepEqual(v.like, { p50: 0, p90: 917, p99: 917, max: 917, zero_pct: 0.5 });
    assert.deepEqual(v.up, { up_replied: 1, up_liked: 1, is_up_rows: 0 });
    assert.deepEqual(v.ip, { known_pct: 0.75, top: [['上海', 2], ['北京', 1]] });
  } finally { db.close(); }
});

test('verifyTree counts.with_pictures：content.pictures 非空数组计数（存量行即生效；空数组/坏 JSON/无 content 不计）', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    const pics2 = JSON.stringify({ pictures: [{ img_src: 'https://a/1.jpg' }, { img_src: 'https://a/2.jpg' }] });
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b',
      replies: [
        row({ rpid_str: 'p1', content: JSON.stringify({ pictures: [{ img_src: 'https://a/0.jpg' }] }) }), // 1 图 → 计
        row({ rpid_str: 'p2', content: pics2 }), // 2 图 → 计 1 行（按行计数不按图数）
        row({ rpid_str: 'p3', content: JSON.stringify({ pictures: [] }) }), // 空数组 → 不计
        row({ rpid_str: 'p4', content: JSON.stringify({ emote: {} }) }), // 无 pictures 键 → 不计
        row({ rpid_str: 'p5', content: null }), // 无 content → 不计
        row({ rpid_str: 'p6', content: 'not-json' }), // 坏 JSON（防御形态）→ 不计且打 [verify] 日志
      ],
    });
    const v = verifyTree(db, videoId);
    assert.equal(v.counts.with_pictures, 2, 'p1+p2 两行带图（按行计数）');
  } finally { db.close(); }
});

// ── count/索引断言（advanced.test.ts EXPLAIN 先例）──

test('索引存在性：comments 四索引齐全（sqlite_master）', () => {
  const db = freshDb();
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='comments' ORDER BY name").all() as Array<{ name: string }>)
      .map((r) => r.name);
    assert.deepEqual(names, [
      'idx_comments_parent',
      'idx_comments_root',
      'idx_comments_rpid',
      'idx_comments_video',
    ]);
  } finally { db.close(); }
});

test('EXPLAIN QUERY PLAN：rpid 等值走 idx_comments_rpid；根列表过滤+排序走 idx_comments_video', () => {
  const db = freshDb();
  try {
    insertVideo(db);
    const plan1 = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM comments WHERE rpid_str = ?').all('x') as Array<{ detail: string }>;
    assert.ok(plan1.some((p) => /SEARCH.*INDEX idx_comments_rpid/.test(p.detail)),
      `rpid 查找应走唯一索引，实际：${plan1.map((p) => p.detail).join(' | ')}`);
    // 镜像 treeByVideo 根查询形状（video_id + is_root 过滤、like_count DESC 排序）
    const plan2 = db.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM comments WHERE video_id = ? AND is_root = 1
      ORDER BY like_count DESC, ctime_s ASC, id ASC
    `).all(1) as Array<{ detail: string }>;
    assert.ok(plan2.some((p) => /SEARCH.*INDEX idx_comments_video/.test(p.detail)),
      `根列表应走 (video_id,is_root,like_count DESC) 索引，实际：${plan2.map((p) => p.detail).join(' | ')}`);
    // 镜像 reconcileMissing 的 missing 判定（video_id + is_root + missing_since/last_seen 过滤）
    const plan3 = db.prepare(`
      EXPLAIN QUERY PLAN SELECT COUNT(*) FROM comments
      WHERE video_id = ? AND is_root = 1 AND missing_since IS NOT NULL AND last_seen_at < missing_since
    `).all(1) as Array<{ detail: string }>;
    assert.ok(plan3.some((p) => /SEARCH.*INDEX idx_comments_video/.test(p.detail)),
      `missing 统计应走 video 前缀索引，实际：${plan3.map((p) => p.detail).join(' | ')}`);
  } finally { db.close(); }
});

// ── treeByVideo（供 C5 tree 子命令与 C6 bundle 导出）──

test('treeByVideo：根按 like_count 降序、组内按 ctime_s 升序；孤儿楼层保留原 root 归组', () => {
  const db = freshDb();
  try {
    const videoId = insertVideo(db);
    upsertComments(db, {
      videoId, upperMid: '1', fetchedAt: 1000, batchId: 'b',
      replies: [
        row({ rpid_str: 'low', like_count: 1, ctime_s: 100 }),
        row({ rpid_str: 'high', like_count: 99, ctime_s: 50 }),
        replyToRoot('h1', 'high', { ctime_s: 300 }),
        replyToRoot('h2', 'high', { ctime_s: 200 }),
        row({ rpid_str: 'orph', root_rpid: 'deadRoot', parent_rpid: 'deadRoot', dialog_rpid: 'orph', ctime_s: 10 }),
      ],
    });
    const t = treeByVideo(db, videoId);
    assert.deepEqual(t.roots.map((r) => r.rpid_str), ['high', 'low'], '根按 like_count 降序');
    assert.deepEqual((t.floorsByRoot.get('high') ?? []).map((f) => f.rpid_str), ['h2', 'h1'], '组内 ctime_s 升序');
    // 孤儿楼层（根已删）：不在 roots，但按原 root_rpid 归组保留（§3.4 不丢弃）
    assert.equal(t.roots.some((r) => r.rpid_str === 'deadRoot'), false);
    assert.deepEqual((t.floorsByRoot.get('deadRoot') ?? []).map((f) => f.rpid_str), ['orph']);
  } finally { db.close(); }
});
