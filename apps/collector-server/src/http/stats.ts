// HTTP handler：统计（stats）。
// 路由：GET /api/stats?type=overview → 总览计数（含分平台 by_source）；GET /api/stats?type=aggregate&groupBy=... → 分组聚合计数。
// 沿用 http/queries.ts 范式（本地 json + URLSearchParams + advanced.ts 纯函数）。
// 措辞：字幕（subtitle），非弹幕。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { aggregateStats, countOverviewWithSources, type StatsGroupBy } from '../db/advanced.js';
import { AGG_SORT_KEYS, type AggregateSortKey } from '../db/sort.js';
import { parseVideoFilter } from './filter.js';
import { json, parseSortParams } from './http-util.js';

const GROUP_BY: readonly StatsGroupBy[] = ['creator', 'tname', 'lang', 'track-type', 'tag', 'source'];

export function handleStatsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const type = url.searchParams.get('type') ?? 'overview';

  if (type === 'overview') {
    json(res, 200, { ok: true, ...countOverviewWithSources(db) });
    return;
  }
  if (type === 'aggregate') {
    const groupByRaw = url.searchParams.get('groupBy');
    if (!groupByRaw || !(GROUP_BY as readonly string[]).includes(groupByRaw)) {
      json(res, 400, { ok: false, error: 'groupBy must be one of creator|tname|lang|track-type|tag|source' });
      return;
    }
    // 同 /api/videos 的全部 VideoFilter 透传（数字/布尔非法忽略）。
    const filter = parseVideoFilter(url.searchParams);
    // topN：覆盖默认 20（分区下拉等场景需更大列表），夹在 1..500，非法回落 20。
    const topN = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get('topN') ?? '20')) || 20));
    // sort：count（默认）/key（分组值本身）；非法 → 400；desc 缺省 true（count DESC, key ASC = 现状）
    const sp = parseSortParams(url.searchParams, AGG_SORT_KEYS, 'count');
    if ('error' in sp) { json(res, 400, { ok: false, error: sp.error }); return; }
    json(res, 200, { ok: true, items: aggregateStats(db, groupByRaw as StatsGroupBy, filter, topN, sp.sort as AggregateSortKey, sp.desc) });
    return;
  }
  json(res, 400, { ok: false, error: 'type must be overview|aggregate' });
}
