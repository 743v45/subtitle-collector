// HTTP handler：统计（stats）。
// 路由：GET /api/stats?type=overview → 总览计数；GET /api/stats?type=aggregate&groupBy=... → 分组聚合计数。
// 沿用 http/queries.ts 范式（本地 json + URLSearchParams + advanced.ts 纯函数）。
// 措辞：字幕（subtitle），非弹幕。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { aggregateStats, countOverview, type StatsGroupBy } from '../db/advanced.js';
import { parseVideoFilter } from './filter.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const GROUP_BY: readonly StatsGroupBy[] = ['creator', 'tname', 'lang', 'track-type'];

export function handleStatsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const type = url.searchParams.get('type') ?? 'overview';

  if (type === 'overview') {
    json(res, 200, { ok: true, overview: countOverview(db) });
    return;
  }
  if (type === 'aggregate') {
    const groupByRaw = url.searchParams.get('groupBy');
    if (!groupByRaw || !(GROUP_BY as readonly string[]).includes(groupByRaw)) {
      json(res, 400, { ok: false, error: 'groupBy must be one of creator|tname|lang|track-type' });
      return;
    }
    // 同 /api/videos 的全部 VideoFilter 透传（数字/布尔非法忽略）。
    const filter = parseVideoFilter(url.searchParams);
    // topN：覆盖默认 20（分区下拉等场景需更大列表），夹在 1..500，非法回落 20。
    const topN = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get('topN') ?? '20')) || 20));
    json(res, 200, { ok: true, items: aggregateStats(db, groupByRaw as StatsGroupBy, filter, topN) });
    return;
  }
  json(res, 400, { ok: false, error: 'type must be overview|aggregate' });
}
