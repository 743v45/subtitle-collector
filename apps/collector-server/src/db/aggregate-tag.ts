// 聚合榜 tag 分支（从 advanced.ts 抽出，2026-08-25 排序功能偿还 max-lines 台账）：
// 六档并聚——关系表四档 UNION ALL bili extra json_each + season extra json_extract，
// 外层 COUNT(DISTINCT video_id)（同名多档并存时按 1 计——聚合语义是「有几个视频带此标签」）。
// tag_source 过滤：只含 bili/season → 只对应 extra 分支；只含关系档 → 第一分支带 IN；省略 → 全查。
// 2026-08-26 纳入 system 档（与 advanced.ts tagMatchCond 同步）：no-subtitle 等系统标进标签榜。
import type Database from 'better-sqlite3';
import { aggOrderBy, type AggregateSortKey } from './sort.js';

// where/params 是调用方（aggregateStats）构建的 video 级 WHERE（含 LEFT JOIN creators 别名 c）；
// tagSource 即 VideoFilter.tag_source（档位过滤子集；undefined = 六档全查）。
export function aggregateStatsByTag(
  db: Database.Database,
  where: string,
  params: unknown[],
  tagSource: string[] | undefined,
  topN: number,
  sort: AggregateSortKey,
  desc: boolean,
): Array<{ key: string; count: number }> {
  const allSources = ['manual', 'batch', 'ai', 'system', 'bili', 'season'];
  const sources = tagSource?.length ? tagSource.filter((s) => allSources.includes(s)) : allSources;
  const relSources = sources.filter((s) => s !== 'bili' && s !== 'season');
  const parts: string[] = [];
  const params2: unknown[] = [];
  if (relSources.length > 0) {
    const placeholders = relSources.map(() => '?').join(',');
    const relWhere = where ? `${where} AND vt.source IN (${placeholders})` : `WHERE vt.source IN (${placeholders})`;
    parts.push(
      `SELECT vt.video_id as vid, t.name as name FROM video_tags vt
         JOIN tags t ON t.id = vt.tag_id
         JOIN videos v ON v.id = vt.video_id
         LEFT JOIN creators c ON c.id = v.creator_id ${relWhere}`,
    );
    params2.push(...params, ...relSources);
  }
  if (sources.includes('bili')) {
    parts.push(
      `SELECT v.id as vid, json_extract(je.value, '$.tag_name') as name
         FROM videos v LEFT JOIN creators c ON c.id = v.creator_id, json_each(v.extra, '$.tags') je
         ${where}`,
    );
    params2.push(...params);
  }
  if (sources.includes('season')) {
    parts.push(
      `SELECT v.id as vid, json_extract(v.extra, '$.ugc_season.title') as name
         FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}`,
    );
    params2.push(...params);
  }
  if (parts.length === 0) return [];
  // 注意：两个分支各自绑定 params + 自身的 IN 占位；SQL 的 ? 顺序 = 分支顺序，params2 已按此排列。
  const sql = `SELECT name as key, COUNT(DISTINCT vid) as count FROM (${parts.join(' UNION ALL ')})
             WHERE name IS NOT NULL GROUP BY name ORDER BY ${aggOrderBy(sort, desc)} LIMIT ?`;
  const rows = db.prepare(sql).all(...params2, topN) as Array<{ key: string | null; count: number }>;
  return rows.map((r) => ({ key: r.key == null ? '(unknown)' : String(r.key), count: r.count }));
}
