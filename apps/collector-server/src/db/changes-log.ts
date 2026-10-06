// change_log 查询区段（2026-10-05 自 advanced.ts 抽出：getChanges 增 ref_* 派生列后模块行数
// 再触 maxLines 台账，沿 tag-match.ts / aggregate-tag.ts 先例收敛）。只含 change_log 列表查询，
// 与 videos 聚合/统计无关；db 层内部拆分，对外仍可经 advanced.js 转出（cli/commands/changes.ts、
// http/queries.ts 的既有 import 路径不变）。
import type Database from 'better-sqlite3';
import { buildOrderBy, type ChangeSortKey } from './sort.js';

export interface PageResult<T> {
  total: number;
  page: number;
  size: number;
  items: T[];
}

export interface ChangeRow {
  id: number;
  entity: string;
  entity_id: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: number;
  source?: string | null; // 派生列：entity 行所属平台（video/creator 可判，其余 null），非表列
  ref_source?: string | null;     // 派生列：跳转定位（2026-10-05 web 契约）——entity=video 时的平台，与 ref_vid 配对；无定位 null
  ref_vid?: string | null;        // 派生列：entity=video 时的平台内视频 ID（videos.source_vid）；无定位 null
  ref_creator_id?: number | null; // 派生列：entity=creator 时的 creators.id（web UP 详情路由）；无定位 null
}

export interface ChangeFilter {
  entity?: string;
  entity_id?: number;
  field?: string;
  source?: string;   // 平台过滤（bilibili|youtube）：经 entity 行 JOIN 判定，change_log 表无 source 列
  since?: number;   // 毫秒，比对 changed_at
  until?: number;
}

// change_log 列表（过滤 + 分页 + 排序，键仅 changed_at——单键但参数形态与其他端点统一；缺省 DESC）。
export function getChanges(db: Database.Database, filter: ChangeFilter, page: number, size: number, sort: ChangeSortKey = 'changed_at', desc = true): PageResult<ChangeRow> {
  const p = page > 0 ? page : 1;
  const s = size > 0 ? size : 20;
  const offset = (p - 1) * s;
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.entity) {
    conds.push('entity = ?');
    params.push(filter.entity);
  }
  if (filter.entity_id != null) {
    conds.push('entity_id = ?');
    params.push(filter.entity_id);
  }
  if (filter.field) {
    conds.push('field = ?');
    params.push(filter.field);
  }
  if (filter.source) {
    // 平台过滤：change_log 无 source 列，经实体行判定（当前 entity 只写 video/creator 两类；
    // 无法判平台的 entity 类型在平台过滤下不命中）
    conds.push(
      "((cl.entity = 'video' AND cl.entity_id IN (SELECT id FROM videos WHERE source = ?)) OR (cl.entity = 'creator' AND cl.entity_id IN (SELECT id FROM creators WHERE source = ?)))",
    );
    params.push(filter.source, filter.source);
  }
  if (filter.since != null) {
    conds.push('changed_at >= ?');
    params.push(filter.since);
  }
  if (filter.until != null) {
    conds.push('changed_at <= ?');
    params.push(filter.until);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM change_log cl ${where}`).get(...params) as { c: number };
  // source 为派生列（CASE 子查询带出），供展示层标平台；无平台语义的 entity 为 null。
  // ref_source/ref_vid/ref_creator_id（2026-10-05 web 契约）为跳转定位派生列：video → 库内视频
  // （source+source_vid 配对跳详情）；creator → creators.id（跳 UP 详情）；其余/实体行已删（change_log
  // 无外键，行可先亡）→ null（流水行仍展示，只是不可跳转）。
  const items = db.prepare(
    `SELECT cl.*,
       CASE
         WHEN cl.entity = 'video' THEN (SELECT source FROM videos WHERE id = cl.entity_id)
         WHEN cl.entity = 'creator' THEN (SELECT source FROM creators WHERE id = cl.entity_id)
         ELSE NULL
       END AS source,
       CASE WHEN cl.entity = 'video' THEN (SELECT source FROM videos WHERE id = cl.entity_id) END AS ref_source,
       CASE WHEN cl.entity = 'video' THEN (SELECT source_vid FROM videos WHERE id = cl.entity_id) END AS ref_vid,
       CASE WHEN cl.entity = 'creator' THEN cl.entity_id END AS ref_creator_id
     FROM change_log cl ${where} ${buildOrderBy('cl.changed_at', desc, { tieExpr: 'cl.id' })} LIMIT ? OFFSET ?`,
  ).all(...params, s, offset) as ChangeRow[];
  return { total: totalRow.c, page: p, size: s, items };
}
