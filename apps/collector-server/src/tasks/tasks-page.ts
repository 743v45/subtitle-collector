import type Database from 'better-sqlite3';
import { buildOrderBy, type TaskSortKey } from '../db/sort.js';
import type { CollectTask, TaskListFilter } from './tasks.js';

// ── collect_tasks 列表查询公共 SQL 片段 + 历史页「展示单元」真分页（2026-10-05）──
// 自 tasks.ts 迁入的原因：① TASK_SELECT 增补 video_title；② 假分页修复（paged 模式按展示单元
// 分页）独立成文件防 tasks.ts 台账（≤400 行）恶化——对齐 source.ts / upper-expand.ts 先例。
// 本文件对 tasks.ts 只 import 类型（编译期擦除），tasks.ts 运行时 import 本文件，无成环。

// 任务行查询的公共 FROM/JOIN（标题与 UP 名经 join 带出；videos 有 UNIQUE(source, source_vid)、
// creators 单行，JOIN 不扇出）。ct = 任务行 creator_uid 关联的资料行（未入库但已知 UP 的任务，
// P2 通道采过资料的库里有名字可回显）；c 与 ct 理论上同源同行（视频入库后归属一致），COALESCE 兜底。
export const TASK_JOINS = `
  FROM collect_tasks t
  LEFT JOIN videos v ON v.source = t.source AND v.source_vid = t.source_vid
  LEFT JOIN creators c ON c.id = v.creator_id
  LEFT JOIN creators ct ON ct.source = t.source AND ct.source_uid = t.creator_uid
`;
// video_title（2026-10-05 web 契约新增）：任务对应视频标题；批量任务无对应视频 → null。
// 与既有 title 列同源（v.title），保留 title 是 popup/历史字段不破坏，video_title 是 web 新消费名。
export const TASK_SELECT = `SELECT t.*, v.title AS title, v.title AS video_title, COALESCE(c.name, ct.name) AS creator_name, COALESCE(c.source_uid, t.creator_uid) AS creator_source_uid ${TASK_JOINS}`;

// 任务列表 WHERE 构造（limit 模式与 paged 单元分页共用）。UP 归属双来源：任务行冗余列
// t.creator_uid（批量提交已知 / 建任务查库回填 / ingest 回填——未入库任务也能筛）+ 入库后 v→creators；
// q 是入库元数据维度（标题），但 vid 段匹配 t.source_vid 覆盖未入库任务（按 BV 号找任务）；
// status/source/since/until/batchId 全走 t.* 列，覆盖全部任务。
export function buildTaskWhere(filter: TaskListFilter): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.status?.length) {
    conds.push(`t.status IN (${filter.status.map(() => '?').join(',')})`);
    params.push(...filter.status);
  }
  if (filter.source) { conds.push('t.source = ?'); params.push(filter.source); }
  if (filter.batchId) { conds.push('t.batch_id = ?'); params.push(filter.batchId); }
  if (filter.batchScope === 'batch') conds.push('t.batch_id IS NOT NULL');
  if (filter.batchScope === 'single') conds.push('t.batch_id IS NULL');
  if (filter.creator) {
    conds.push('(ct.name LIKE ? OR c.name LIKE ?)');
    params.push(`%${filter.creator}%`, `%${filter.creator}%`);
  }
  if (filter.creatorUid) {
    conds.push('(t.creator_uid = ? OR v.creator_id IN (SELECT id FROM creators WHERE source_uid = ?))');
    params.push(filter.creatorUid, filter.creatorUid);
  }
  if (filter.q) {
    conds.push('(v.title LIKE ? OR t.source_vid LIKE ?)');
    params.push(`%${filter.q}%`, `%${filter.q}%`);
  }
  if (filter.since != null) { conds.push('t.created_at >= ?'); params.push(filter.since); }
  if (filter.until != null) { conds.push('t.created_at <= ?'); params.push(filter.until); }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

// ── 历史页 paged 模式：按「展示单元」真分页 ──
// 展示单元 = 单条任务（batch_id IS NULL）或整批（同 batch_id 全体成员）。旧行为按「行」分页,
// 种子页再无界补全批次成员（假分页）：total 数的是行、页面却可能溢出 page_size、整批还常被
// 页边界劈成两半。真分页口径：
//   - total      = 筛选后的单元数（不是行数）；
//   - 页         = 单元集合按单元排序键分页，单元不跨页（整批必落同一页）；
//   - items      = 这些单元的全体成员行（历史页批次卡要完整成员才能算「n/m 完成」）；
//   - 筛选       = 作用于成员行（单元内任一成员命中 → 单元入选，页面仍带全批成员）。
// 单元排序键（与行级 buildOrderBy 语义对齐，单元级聚合口径在此定义）：
//   - created_at  = MAX(成员 created_at)——批次以最后创建成员的时间参战（与旧行为观感一致）；
//   - finished_at = MAX(成员 finished_at) + NULLS LAST——批次完成时刻取最晚成员，未完成单元殿后；
//   - status      = MIN(成员 status)（字典序，镜像行级 status 排序口径——最靠前成员状态代表单元）。
//   tie 一律 MAX(成员 id)，方向随主键（buildOrderBy tieExpr）。
export function listTasksPaged(
  db: Database.Database, limit: number, offset: number, filter: TaskListFilter = {},
  sort: TaskSortKey = 'created_at', desc = true,
): { total: number; items: CollectTask[] } {
  const { where, params } = buildTaskWhere(filter);
  // 单元定义：双列 GROUP BY 消除合成 key 的碰撞面——batch_id 非空按批分组；为空时以 t.id 自成
  // 单元（CASE 恒 NULL 之外的 id 值），不用 'single:'||id 之类合成串（防与真实 batch_id 撞名）。
  const unitsCte = `
    WITH units AS (
      SELECT t.batch_id AS bid,
             CASE WHEN t.batch_id IS NULL THEN t.id END AS single_id,
             MAX(t.created_at) AS unit_created_at,
             MAX(t.finished_at) AS unit_finished_at,
             MIN(t.status) AS unit_status,
             MAX(t.id) AS unit_max_id
      ${TASK_JOINS}
      ${where}
      GROUP BY bid, single_id
    )`;
  const unitSortExpr = sort === 'created_at' ? 'unit_created_at'
    : sort === 'finished_at' ? 'unit_finished_at'
    : 'unit_status';
  const order = buildOrderBy(unitSortExpr, desc, { nullable: sort === 'finished_at', tieExpr: 'unit_max_id' });
  const total = (db.prepare(`${unitsCte} SELECT COUNT(*) AS n FROM units`).get(...params) as { n: number }).n;
  const pageUnits = db.prepare(
    `${unitsCte} SELECT bid, single_id FROM units ${order} LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as Array<{ bid: string | null; single_id: number | null }>;
  if (pageUnits.length === 0) return { total, items: [] };
  const bids = pageUnits.map((u) => u.bid).filter((b): b is string => b != null);
  const singles = pageUnits.map((u) => u.single_id).filter((s): s is number => s != null);
  // 成员行整批带出：候选单元的 batch_id 集合 ∪ 单条任务 id 集合（两集合互斥——batch_id 空才算单条）。
  const memberConds: string[] = [];
  const memberParams: unknown[] = [];
  if (bids.length > 0) {
    memberConds.push(`t.batch_id IN (${bids.map(() => '?').join(',')})`);
    memberParams.push(...bids);
  }
  if (singles.length > 0) {
    memberConds.push(`t.id IN (${singles.map(() => '?').join(',')})`);
    memberParams.push(...singles);
  }
  const members = db.prepare(
    `${TASK_SELECT} WHERE (${memberConds.join(' OR ')})`,
  ).all(...memberParams) as CollectTask[];
  // 页内顺序：外层按单元页位（SQL 已排序的 units 顺序），单元内按 t.id 升序（建任务顺序，确定性）。
  const unitIndex = new Map<string, number>();
  pageUnits.forEach((u, i) => unitIndex.set(u.bid ?? `t:${u.single_id}`, i));
  const keyOf = (t: CollectTask): string => (t.batch_id ?? `t:${t.id}`);
  members.sort((a, b) => {
    const ia = unitIndex.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER;
    const ib = unitIndex.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER;
    return ia !== ib ? ia - ib : a.id - b.id;
  });
  return { total, items: members };
}
