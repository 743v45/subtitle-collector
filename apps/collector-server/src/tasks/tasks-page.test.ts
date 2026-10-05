// tasks-page.ts（历史页「展示单元」真分页）单元测试（2026-10-05 web 契约）。
// 核心契约：paged 模式按单元分页——单元=单条任务或整批；total=单元数；整批必落同一页（不跨页劈开）；
// items=页面单元的全体成员行（可能 > page_size，批次卡完整性优先）；筛选作用成员行（任一成员命中
// → 单元入选）；sort 三键的单元级语义（created_at=MAX / finished_at=MAX+NULLS LAST / status=MIN 字典序）；
// limit 模式（listTasks 旧行为：行分页+批次补全）不回归。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 单元分页全形态（跨页整批/total 口径/筛选组合/三键排序/降序关闭/空页）+ limit 模式回归 + video_title | 通过 | 2026-10-05 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { listTasksPaged } from './tasks-page.js';
import { listTasks } from './tasks.js';

function setupDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'collector-tasks-page-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// 样本（created_at 全直写确定值；insert 顺序固定 → t.id 随之确定：s3 < m1 < m2 < m3 < s1 < s2）：
//   S3(T+150) → batchA m1/m2/m3(T+100/200/300) → S1(T+250) → S2(T+400)
//   batchA：m1 已入库 succeeded(fin T+10100)、m2 未入库 failed(fin T+10200)、m3 未入库 pending(fin null)
//   单元聚合：batchA.created=MAX=T+300、finished=MAX=T+10200、status=MIN='failed'
//   S1 pending(fin null)、S2 succeeded(fin T+10400)、S3 failed(fin T+10150)
function setupUnits(): {
  db: Database.Database; cleanup: () => void;
  batchIds: number[]; s1: number; s2: number; s3: number;
} {
  const { db, cleanup } = setupDb();
  const T = 1_700_000_000_000;
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1ALPHA0001', title: 'Alpha 视频一', creator: { source_uid: '1', name: 'Alpha UP' }, extra: {}, duration: 100, published_at: T },
    tracks: [],
  });
  const ins = db.prepare(
    'INSERT INTO collect_tasks (source, source_vid, url, status, created_at, batch_id, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const run = (sv: string, status: string, createdAt: number, batchId: string | null) =>
    Number(ins.run('bilibili', sv, `https://www.bilibili.com/video/${sv}`, status, createdAt, batchId,
      status === 'succeeded' || status === 'failed' ? createdAt + 10_000 : null).lastInsertRowid);
  const s3 = run('BV1S3VID000x', 'failed', T + 150, null);
  const m1 = run('BV1ALPHA0001', 'succeeded', T + 100, 'batchA');
  const m2 = run('BV1NOBAT001x', 'failed', T + 200, 'batchA');
  const m3 = run('BV1NOBAT002x', 'pending', T + 300, 'batchA');
  const s1 = run('BV1S1VID000x', 'pending', T + 250, null);
  const s2 = run('BV1S2VID000x', 'succeeded', T + 400, null);
  return { db, cleanup, batchIds: [m1, m2, m3], s1, s2, s3 };
}

const idsOf = (items: Array<{ id: number }>) => items.map((i) => i.id);
/** 页内行 → 单元序列（batchA 成员归并为 'batchA'，单条用 id；同单元成员连续相邻 → 去重相邻重复
 *  后一单元一个标签），断言单元级排序用 */
const unitSeq = (items: Array<{ id: number }>, batchIds: number[]): string[] => {
  const labels = items.map((i) => (batchIds.includes(i.id) ? 'batchA' : `t${i.id}`));
  return labels.filter((l, i) => i === 0 || l !== labels[i - 1]);
};

test('listTasksPaged：整批不跨页——批次落在页边界上时全体成员同页，items 可超 page_size', () => {
  const { db, cleanup, batchIds, s1, s2, s3 } = setupUnits();
  try {
    // 单元序（created_at desc）：S2(T+400) > batchA(T+300) > S1(T+250) > S3(T+150)，total=4 单元
    const p1 = listTasksPaged(db, 2, 0, {});
    assert.equal(p1.total, 4, 'total 数单元不数行（6 行 4 单元）');
    // 第 1 页 = [S2, batchA]：1 单条 + 整批 3 成员 = 4 行（> page_size=2，批次卡完整性优先）
    assert.equal(p1.items.length, 4);
    assert.deepEqual(idsOf(p1.items).sort((a, b) => a - b), [s2, ...batchIds].sort((a, b) => a - b));
    // 第 2 页 = [S1, S3]，批次成员绝不出现在第 2 页（不跨页）
    const p2 = listTasksPaged(db, 2, 2, {});
    assert.equal(p2.total, 4);
    assert.deepEqual(idsOf(p2.items).sort((a, b) => a - b), [s1, s3].sort((a, b) => a - b));
    // 第 3 页越界 → 空但 total 仍在
    const p3 = listTasksPaged(db, 2, 4, {});
    assert.equal(p3.total, 4);
    assert.deepEqual(p3.items, []);
  } finally { cleanup(); }
});

test('listTasksPaged：单元内成员按 t.id 升序（建任务顺序，确定性）', () => {
  const { db, cleanup, batchIds } = setupUnits();
  try {
    const p1 = listTasksPaged(db, 2, 0, {});
    const inPage = idsOf(p1.items).filter((id) => batchIds.includes(id));
    assert.deepEqual(inPage, batchIds, 'batchA 成员按 id 升序排列');
  } finally { cleanup(); }
});

test('listTasksPaged：筛选+分页组合——任一成员命中单元入选，页面仍带全批成员；total=筛选后单元数', () => {
  const { db, cleanup, batchIds, s1, s2, s3 } = setupUnits();
  try {
    // status=pending：batchA（m3 命中）+ S1 入选；S2(succeeded)/S3(failed) 出局
    const r = listTasksPaged(db, 1, 0, { status: ['pending'] });
    assert.equal(r.total, 2, '筛选后的单元数（不是命中行数）');
    // 单元序 created_at desc：batchA(T+300) > S1(T+250)；page_size=1 下 batchA 独占第 1 页
    assert.equal(r.items.length, 3, 'batchA 整批成员全带出（哪怕只 1 成员命中）');
    assert.deepEqual(idsOf(r.items).sort((a, b) => a - b), [...batchIds].sort((a, b) => a - b));
    // 翻页拿到 S1
    const p2 = listTasksPaged(db, 1, 1, { status: ['pending'] });
    assert.deepEqual(idsOf(p2.items), [s1]);
    // 反向对照：succeeded 命中 S2 与 batchA 的 m1 → batchA 整批也入选
    const ok = listTasksPaged(db, 10, 0, { status: ['succeeded'] });
    assert.equal(ok.total, 2);
    assert.deepEqual(idsOf(ok.items).sort((a, b) => a - b), [s2, ...batchIds].sort((a, b) => a - b), 'batchA 因 m1 succeeded 入选');
    void s3;
  } finally { cleanup(); }
});

test('listTasksPaged：sort=finished_at 单元语义 MAX + NULLS LAST（升降两向）', () => {
  const { db, cleanup, batchIds, s1, s2, s3 } = setupUnits();
  try {
    // 单元 finished：S2=T+10400 > batchA=T+10200 > S3=T+10150 > S1=null
    const desc = listTasksPaged(db, 10, 0, {}, 'finished_at', true);
    assert.deepEqual(unitSeq(desc.items, batchIds), [`t${s2}`, 'batchA', `t${s3}`, `t${s1}`],
      'desc：最晚完成单元在前，未完成单元（S1 null）NULLS LAST 殿后');
    // asc：NULLS LAST 不随方向翻转（升序看「最早完成」，未完成仍不挤最前）
    const asc = listTasksPaged(db, 10, 0, {}, 'finished_at', false);
    assert.deepEqual(unitSeq(asc.items, batchIds), [`t${s3}`, 'batchA', `t${s2}`, `t${s1}`],
      'asc：S3(T+10150) → batchA(T+10200) → S2(T+10400)，S1 仍殿后');
  } finally { cleanup(); }
});

test('listTasksPaged：sort=status 单元语义 MIN（字典序）+ tie MAX(id) 方向随主键', () => {
  const { db, cleanup, batchIds, s1, s2, s3 } = setupUnits();
  try {
    // 单元 status（MIN 字典序）：batchA=failed 与 S3=failed 同值 tie MAX(id)；S1=pending、S2=succeeded
    const desc = listTasksPaged(db, 10, 0, {}, 'status', true);
    assert.deepEqual(unitSeq(desc.items, batchIds), [`t${s2}`, `t${s1}`, 'batchA', `t${s3}`],
      'desc：succeeded → pending → failed；同 failed 的 tie 按 MAX(id) desc（batchA 晚建在前）');
    // asc：方向翻转，tie 也随主键翻转（S3 先建在前）
    const asc = listTasksPaged(db, 10, 0, {}, 'status', false);
    assert.deepEqual(unitSeq(asc.items, batchIds), [`t${s3}`, 'batchA', `t${s1}`, `t${s2}`],
      'asc：failed → pending → succeeded；tie 翻转（S3 在 batchA 前）');
  } finally { cleanup(); }
});

test('listTasksPaged：sort=created_at desc=false + 默认 desc=true（既有观感）', () => {
  const { db, cleanup, batchIds, s1, s2, s3 } = setupUnits();
  try {
    const def = listTasksPaged(db, 10, 0, {});
    assert.deepEqual(unitSeq(def.items, batchIds), [`t${s2}`, 'batchA', `t${s1}`, `t${s3}`],
      '默认 desc：单元 created_at=MAX 降序 S2(T+400) → batchA(T+300) → S1(T+250) → S3(T+150)');
    const asc = listTasksPaged(db, 10, 0, {}, 'created_at', false);
    assert.deepEqual(unitSeq(asc.items, batchIds), [`t${s3}`, `t${s1}`, 'batchA', `t${s2}`], 'asc 完全翻转');
  } finally { cleanup(); }
});

test('listTasksPaged：video_title 列（web 契约）——入库视频带标题、未入库成员 null', () => {
  const { db, cleanup } = setupUnits();
  try {
    const p1 = listTasksPaged(db, 10, 0, {});
    const m1 = p1.items.find((i) => i.source_vid === 'BV1ALPHA0001');
    assert.equal(m1?.video_title, 'Alpha 视频一');
    assert.equal(m1?.title, 'Alpha 视频一', 'title 旧消费名保留（同源 v.title）');
    assert.equal(m1?.creator_name, 'Alpha UP');
    const m2 = p1.items.find((i) => i.source_vid === 'BV1NOBAT001x');
    assert.equal(m2?.video_title ?? null, null, '未入库任务无对应视频 → video_title null');
  } finally { cleanup(); }
});

// limit 模式（listTasks 旧行为）不回归：行分页 + 种子批次补全 + total=行数——
// 与 paged 模式（单元口径）形成对照，修 paged 不得动 limit 语义（采集页最近列表依赖它）。
test('listTasks limit 模式回归：total=行数、种子页+批次补全（旧行为原样保留在 limit 模式）', () => {
  const { db, cleanup, batchIds, s1, s2 } = setupUnits();
  try {
    // 种子页=最新 2 行（created_at desc：S2 T+400、batchA m3 T+300）；m3 属 batchA → 补全 m1/m2
    const r = listTasks(db, 2, 0, {});
    assert.equal(r.total, 6, 'total 数行不数单元（limit 模式旧行为）');
    assert.equal(r.items.length, 4, '种子 2 行 + 批次补全 2 成员');
    assert.deepEqual(idsOf(r.items).sort((a, b) => a - b), [s2, ...batchIds].sort((a, b) => a - b));
    // 行分页没有「整批不跨页」保证：offset=2 是纯行窗口（S1 T+250、m2 T+200），m2 落窗仍触发
    // batchA 补全 → 窗口 2 行 + 批次成员 3 行（m2 本身在内）= 4 行
    const p2 = listTasks(db, 2, 2, {});
    assert.equal(p2.items.length, 4);
    assert.deepEqual(idsOf(p2.items).sort((a, b) => a - b), [s1, ...batchIds].sort((a, b) => a - b));
  } finally { cleanup(); }
});
