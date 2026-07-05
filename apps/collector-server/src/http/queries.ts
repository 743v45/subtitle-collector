import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { getVideo, getVersionPayload } from '../db/queries.js';
import { listVideosFiltered, type VideoSortKey, type VideoListItemAdvanced } from '../db/advanced.js';
import { parseVideoFilter, parseBool } from './filter.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const SORT_KEYS: readonly VideoSortKey[] = ['first_seen', 'published_at', 'title', 'duration', 'view'];

// 列表项富化：用 json_extract 从 extra 取 tid/tname/tags/view/pic，前端列表直接展示分区/标签/播放量/封面，避免逐条再请求。
// tags 在 extra 是对象数组 [{tag_id,tag_name}]，这里降维成 tag_name 字符串数组；非合法 JSON → 空数组（不 500）。
function enrichItems(
  db: Database.Database,
  items: VideoListItemAdvanced[],
): Array<VideoListItemAdvanced & { tid: number | null; tname: string | null; tags: string[]; view: number | null; pic: string | null }> {
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id,
            json_extract(extra, '$.tid') AS tid,
            json_extract(extra, '$.tname') AS tname,
            json_extract(extra, '$.tags') AS tags,
            CAST(json_extract(extra, '$.stat.view') AS INTEGER) AS view,
            json_extract(extra, '$.pic') AS pic
       FROM videos WHERE id IN (${placeholders})`,
  ).all(...ids) as Array<{ id: number; tid: number | null; tname: string | null; tags: string | null; view: number | null; pic: string | null }>;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return items.map((it) => {
    const r = byId.get(it.id);
    let tags: string[] = [];
    if (r?.tags) {
      try {
        const arr = JSON.parse(r.tags) as unknown;
        if (Array.isArray(arr)) {
          tags = (arr as Array<{ tag_name?: unknown }>)
            .map((x) => (x && typeof x.tag_name === 'string' ? x.tag_name : null))
            .filter((t): t is string => t !== null);
        }
      } catch {
        tags = []; // extra.tags 非合法 JSON → 空数组
      }
    }
    return { ...it, tid: r?.tid ?? null, tname: r?.tname ?? null, tags, view: r?.view ?? null, pic: r?.pic ?? null };
  });
}

export function handleQueryHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/videos') {
    const filter = parseVideoFilter(url.searchParams);
    // sort：非法值落回默认 first_seen（不报错）
    const sortRaw = url.searchParams.get('sort');
    const sort: VideoSortKey = sortRaw && (SORT_KEYS as readonly string[]).includes(sortRaw)
      ? (sortRaw as VideoSortKey)
      : 'first_seen';
    // desc：缺省 true（兼容旧 /api/videos 的 first_seen DESC，最新在前）；显式 'false'/'0'/'no' → 升序
    const desc = parseBool(url.searchParams.get('desc')) ?? true;
    // page/size：非法（NaN）回落默认，page≥1，size 夹在 1..100
    const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') ?? '1')) || 1);
    const size = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('size') ?? '20')) || 20));

    const data = listVideosFiltered(db, { ...filter, sort, desc, page, size });
    json(res, 200, { ok: true, total: data.total, page: data.page, size: data.size, items: enrichItems(db, data.items) });
    return;
  }

  const detailMatch = pathname.match(/^\/api\/videos\/([^/]+)\/([^/]+)$/);
  if (detailMatch) {
    const source = detailMatch[1];
    const sourceVid = decodeURIComponent(detailMatch[2]);
    const detail = getVideo(db, source, sourceVid);
    if (!detail) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, ...detail });
    return;
  }

  // 注：GET /api/creators/:id 由 http/creators.ts 处理（main.ts 按 /api/creators 前缀优先分发），
  // 此处历史上的重复 /api/creators/:id 分支是死路由，已删除。

  const versionMatch = pathname.match(/^\/api\/versions\/(\d+)$/);
  if (versionMatch) {
    const v = getVersionPayload(db, Number(versionMatch[1]));
    if (!v) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, version: v });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}
