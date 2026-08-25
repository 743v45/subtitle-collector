import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { getVideo, getVersionPayload } from '../db/queries.js';
import { listVideosFiltered, getChanges, latestTaskStatusByVideoIds, VIDEO_SORT_KEYS, type VideoSortKey, type VideoListItemAdvanced, type ChangeFilter } from '../db/advanced.js';
import { CHANGE_SORT_KEYS, type ChangeSortKey } from '../db/sort.js';
import { parseVideoFilter } from './filter.js';
import { applyVideoTags, removeVideoTags, getVideoTagsByVideoIds, getVideoTagsForDetail, type TagSource } from '../db/tags.js';
import { getTagPriority, type TagPrioritySource } from '../db/settings.js';
import { json, readJsonBody, parseTagScope, parseSortParams } from './http-util.js';

// 合并 bili（extra.tags）+ season（extra.ugc_season.title）与关系三档，同名按 tag_priority 取优先档（winner）。
// 列表用（去重）；详情要全档时传 keepAll=true。
function mergeTagDetails(
  biliNames: string[],
  relTags: Array<{ name: string; source: TagSource }>,
  priority: TagPrioritySource[],
  keepAll = false,
  seasonNames: string[] = [],
): Array<{ name: string; source: TagPrioritySource }> {
  const all: Array<{ name: string; source: TagPrioritySource }> = [
    ...biliNames.map((name) => ({ name, source: 'bili' as const })),
    ...relTags.map((t) => ({ name: t.name, source: t.source })),
    ...seasonNames.map((name) => ({ name, source: 'season' as const })),
  ];
  if (keepAll) {
    return all.sort((a, b) => {
      const pa = priority.indexOf(a.source); const pb = priority.indexOf(b.source);
      return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
    });
  }
  const rank = new Map(priority.map((s, i) => [s, i]));
  const winner = new Map<string, { name: string; source: TagPrioritySource }>();
  for (const t of all) {
    const cur = winner.get(t.name);
    if (!cur || (rank.get(t.source) ?? 99) < (rank.get(cur.source) ?? 99)) winner.set(t.name, t);
  }
  return [...winner.values()].sort((a, b) => {
    const pa = rank.get(a.source) ?? 99; const pb = rank.get(b.source) ?? 99;
    return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
  });
}

// 列表项富化：用 json_extract 从 extra 取 tid/tname/tags/view/season_title，并合并关系档标签按优先级 dedupe。
// tags（兼容旧字段）= winner 标签名数组；tag_details = [{name, source}]（同名只保留优先级最高档）。
// 另附 pot_limited：最近一次采集任务 status='limited'（半入库：元信息在、0 轨）的派生标记，
// 与「真无字幕」区分；重采成功后自然消失（web UI 本次未消费，字段先备好）。
function enrichItems(
  db: Database.Database,
  items: VideoListItemAdvanced[],
): Array<VideoListItemAdvanced & { tid: number | null; tname: string | null; tags: string[]; view: number | null; pic: string | null; tag_details: Array<{ name: string; source: TagPrioritySource }>; pot_limited: boolean }> {
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  const latestStatus = latestTaskStatusByVideoIds(db, ids);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id,
            json_extract(extra, '$.tid') AS tid,
            json_extract(extra, '$.tname') AS tname,
            json_extract(extra, '$.tags') AS tags,
            json_extract(extra, '$.ugc_season.title') AS season_title,
            json_extract(extra, '$.pic') AS pic,
            CAST(json_extract(extra, '$.stat.view') AS INTEGER) AS view
       FROM videos WHERE id IN (${placeholders})`,
  ).all(...ids) as Array<{ id: number; tid: number | null; tname: string | null; tags: string | null; season_title: string | null; pic: string | null; view: number | null }>;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const relTags = getVideoTagsByVideoIds(db, ids);
  const priority = getTagPriority(db);
  return items.map((it) => {
    const r = byId.get(it.id);
    let biliNames: string[] = [];
    if (r?.tags) {
      try {
        const arr = JSON.parse(r.tags) as unknown;
        if (Array.isArray(arr)) {
          biliNames = (arr as Array<{ tag_name?: unknown }>)
            .map((x) => (x && typeof x.tag_name === 'string' ? x.tag_name : null))
            .filter((t): t is string => t !== null);
        }
      } catch {
        biliNames = []; // extra.tags 非合法 JSON → 空数组
      }
    }
    const tag_details = mergeTagDetails(biliNames, relTags.get(it.id) ?? [], priority, false, r?.season_title ? [r.season_title] : []);
    // pic：ingest 时已归一 https:（tasks.ts normalizePic），列表直接透传（无封面 null，前端回落占位）
    return { ...it, tid: r?.tid ?? null, tname: r?.tname ?? null, tags: tag_details.map((t) => t.name), view: r?.view ?? null, tag_details, pot_limited: latestStatus.get(it.id) === 'limited', pic: r?.pic ?? null };
  });
}

export async function handleQueryHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/changes') {
    const entity = url.searchParams.get('entity') ?? undefined;
    const entityIdRaw = url.searchParams.get('entity_id');
    const entity_id = entityIdRaw != null && /^\d+$/.test(entityIdRaw) ? Number(entityIdRaw) : undefined;
    const field = url.searchParams.get('field') ?? undefined;
    const source = url.searchParams.get('source') ?? undefined; // 平台过滤（经实体行 JOIN 判定，见 getChanges）
    const filter: ChangeFilter = { entity, entity_id, field, source };
    const sinceParam = url.searchParams.get('since');
    if (sinceParam != null && Number.isFinite(Number(sinceParam))) filter.since = Number(sinceParam);
    const untilParam = url.searchParams.get('until');
    if (untilParam != null && Number.isFinite(Number(untilParam))) filter.until = Number(untilParam);
    const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') ?? '1')) || 1);
    const size = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('size') ?? '20')) || 20));
    // sort 仅 changed_at 一个键（实体/字段文本排序无意义），但参数形态与其他列表端点统一；非法 → 400
    const sp = parseSortParams(url.searchParams, CHANGE_SORT_KEYS, 'changed_at');
    if ('error' in sp) { json(res, 400, { ok: false, error: sp.error }); return; }
    const data = getChanges(db, filter, page, size, sp.sort as ChangeSortKey, sp.desc);
    json(res, 200, { ok: true, total: data.total, page: data.page, size: data.size, items: data.items });
    return;
  }
  if (pathname === '/api/videos') {
    const filter = parseVideoFilter(url.searchParams);
    // sort：非法 → 400（2026-08-25 起取代旧「非法静默回落 first_seen」——以为排了其实没排是暗坑；
    // 错误信息列全合法键，单一事实源 VIDEO_SORT_KEYS）
    const sp = parseSortParams(url.searchParams, VIDEO_SORT_KEYS, 'first_seen');
    if ('error' in sp) { json(res, 400, { ok: false, error: sp.error }); return; }
    // desc：缺省 true（兼容旧 /api/videos 的 first_seen DESC，最新在前）；显式 'false'/'0'/'no' → 升序
    // page/size：非法（NaN）回落默认，page≥1，size 夹在 1..100
    const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') ?? '1')) || 1);
    const size = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('size') ?? '20')) || 20));

    const data = listVideosFiltered(db, { ...filter, sort: sp.sort as VideoSortKey, desc: sp.desc, page, size });
    json(res, 200, { ok: true, total: data.total, page: data.page, size: data.size, items: enrichItems(db, data.items) });
    return;
  }

  // 单视频打标/移除（web 详情页用）。批量打标走 /api/tags/apply。
  const videoTagsMatch = pathname.match(/^\/api\/videos\/([^/]+)\/([^/]+)\/tags$/);
  if (videoTagsMatch && (req.method === 'POST' || req.method === 'DELETE')) {
    const source = videoTagsMatch[1];
    const sourceVid = decodeURIComponent(videoTagsMatch[2]);
    // 视频必须已存在（打标挂在已入库视频上）
    const video = getVideo(db, source, sourceVid);
    if (!video) { json(res, 404, { ok: false, error: 'video not found' }); return; }
    if (req.method === 'POST') {
      // body.scope=档位（parseTagScope 统一校验；历史字段名 source 已改名，URL 路径里的 :source 是平台）
      const b = await readJsonBody(req) as { names?: unknown; scope?: unknown };
      const names = Array.isArray(b.names) ? b.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0) : [];
      if (names.length === 0) { json(res, 400, { ok: false, error: 'names:string[] required' }); return; }
      const ps = parseTagScope(b.scope, true);
      if (!ps.ok) { json(res, 400, { ok: false, error: ps.error }); return; }
      const r = applyVideoTags(db, [{ source, source_vid: sourceVid }], names, ps.scope!); // required=true 时必有
      json(res, 200, { ok: true, inserted: r.inserted, missing: r.missing });
      return;
    }
    // DELETE：name 必填，scope 可选（省略删全档）——query 参数（规避 DELETE body 兼容坑）
    {
      const name = url.searchParams.get('name');
      if (!name) { json(res, 400, { ok: false, error: 'name query param required' }); return; }
      const ps = parseTagScope(url.searchParams.get('scope') ?? undefined, false);
      if (!ps.ok) { json(res, 400, { ok: false, error: ps.error }); return; }
      const r = removeVideoTags(db, [{ source, source_vid: sourceVid }], [name], ps.scope);
      json(res, 200, { ok: true, removed: r.removed, missing: r.missing });
      return;
    }
  }

  const detailMatch = pathname.match(/^\/api\/videos\/([^/]+)\/([^/]+)$/);
  if (detailMatch) {
    const source = detailMatch[1];
    const sourceVid = decodeURIComponent(detailMatch[2]);
    const detail = getVideo(db, source, sourceVid);
    if (!detail) { json(res, 404, { ok: false, error: 'not found' }); return; }
    // 全档 tag_details（不去重，详情页五档全展示）：bili（extra.tags）+ season（extra.ugc_season.title）+ 关系三档
    // 注意 getVideo 返回的 extra 是 TEXT（JSON 字符串），需 parse 后再取 tags
    let biliNames: string[] = [];
    let seasonNames: string[] = [];
    try {
      const extraObj = typeof detail.video.extra === 'string' ? JSON.parse(detail.video.extra) : detail.video.extra;
      const arr = (extraObj as { tags?: unknown } | null)?.tags;
      if (Array.isArray(arr)) {
        biliNames = (arr as Array<{ tag_name?: unknown }>)
          .map((x) => (x && typeof x.tag_name === 'string' ? x.tag_name : null))
          .filter((t): t is string => t !== null);
      }
      const seasonTitle = (extraObj as { ugc_season?: { title?: unknown } } | null)?.ugc_season?.title;
      if (typeof seasonTitle === 'string' && seasonTitle) seasonNames = [seasonTitle];
    } catch { /* extra 非合法 JSON → 无 bili/season 标签 */ }
    const relTags = getVideoTagsForDetail(db, detail.video.id as number);
    const priority = getTagPriority(db);
    json(res, 200, { ok: true, ...detail, tag_details: mergeTagDetails(biliNames, relTags, priority, true, seasonNames) });
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
