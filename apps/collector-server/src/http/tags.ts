// HTTP handler：视频标签（tags）。
// 路由：GET/POST /api/tags[/apply|/remove]、PATCH/DELETE /api/tags/:id；
//       单视频打标/移除在 http/queries.ts（/api/videos/:source/:vid/tags）。
// 沿用 http/categories.ts 范式（本地 json + readJsonBody + 正则路由）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import {
  listTags, applyVideoTags, removeVideoTags, renameTag, deleteTag,
  isTagSource, type VideoRef, type TagSource,
} from '../db/tags.js';
import { json, readJsonBody } from './http-util.js';

// 请求体校验：items 必须是 [{source, source_vid}]，names 是 string[]；source 必须是合法档（bili 只读 → 400）
function parseApplyBody(b: unknown, needSource: boolean): { refs: VideoRef[]; names: string[]; source?: TagSource } | { error: string } {
  const body = b as { items?: unknown; names?: unknown; source?: unknown };
  if (!Array.isArray(body.items) || body.items.length === 0 || !Array.isArray(body.names) || body.names.length === 0) {
    return { error: 'items:[{source,source_vid}] and names:string[] required' };
  }
  const refs: VideoRef[] = [];
  for (const it of body.items) {
    const r = it as { source?: unknown; source_vid?: unknown };
    if (typeof r.source !== 'string' || typeof r.source_vid !== 'string' || !r.source || !r.source_vid) {
      return { error: 'each item needs non-empty source & source_vid' };
    }
    refs.push({ source: r.source, source_vid: r.source_vid });
  }
  const names = body.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  if (names.length === 0) return { error: 'names must contain at least one non-empty string' };
  if (needSource) {
    if (body.source === 'bili') return { error: 'bili tags are read-only (from video extra)' };
    if (!isTagSource(body.source)) return { error: 'source must be manual|batch|ai' };
    return { refs, names, source: body.source };
  }
  // remove：source 可省略（删全档）；给了就必须合法
  if (body.source !== undefined) {
    if (body.source === 'bili') return { error: 'bili tags are read-only (from video extra)' };
    if (!isTagSource(body.source)) return { error: 'source must be manual|batch|ai' };
    return { refs, names, source: body.source };
  }
  return { refs, names };
}

export async function handleTagsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/tags' && req.method === 'GET') {
    const source = url.searchParams.get('source');
    if (source && !isTagSource(source)) { json(res, 400, { ok: false, error: 'source must be manual|batch|ai' }); return; }
    const q = url.searchParams.get('q') ?? undefined;
    const topN = Math.min(500, Math.max(1, Number(url.searchParams.get('topN') ?? '500') || 500));
    json(res, 200, { ok: true, items: listTags(db, { source: source as TagSource | undefined, q, topN }) });
    return;
  }

  if (pathname === '/api/tags/apply' && req.method === 'POST') {
    const parsed = parseApplyBody(await readJsonBody(req), true);
    if ('error' in parsed) { json(res, 400, { ok: false, error: parsed.error }); return; }
    const r = applyVideoTags(db, parsed.refs, parsed.names, parsed.source!);
    // 全部视频都不在库 → 404；部分缺失 → 200 带 missing 清单（部分成功）
    if (r.missing.length === parsed.refs.length) { json(res, 404, { ok: false, error: 'no videos found', missing: r.missing }); return; }
    json(res, 200, { ok: true, inserted: r.inserted, missing: r.missing });
    return;
  }

  if (pathname === '/api/tags/remove' && req.method === 'POST') {
    const parsed = parseApplyBody(await readJsonBody(req), false);
    if ('error' in parsed) { json(res, 400, { ok: false, error: parsed.error }); return; }
    const r = removeVideoTags(db, parsed.refs, parsed.names, parsed.source);
    json(res, 200, { ok: true, removed: r.removed, missing: r.missing });
    return;
  }

  const m = pathname.match(/^\/api\/tags\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (req.method === 'PATCH') {
      const b = await readJsonBody(req) as { name?: string };
      if (!b.name || typeof b.name !== 'string' || !b.name.trim()) { json(res, 400, { ok: false, error: 'name required' }); return; }
      try {
        const t = renameTag(db, id, b.name.trim());
        if (!t) { json(res, 404, { ok: false, error: 'not found' }); return; }
        json(res, 200, { ok: true, tag: t });
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('UNIQUE')) json(res, 409, { ok: false, error: 'tag name already exists' });
        else json(res, 500, { ok: false, error: msg });
      }
      return;
    }
    if (req.method === 'DELETE') {
      // 404 的 body 与状态码语义一致（ok:false），调用方能从 body 判断失败而非只看状态码
      if (deleteTag(db, id)) json(res, 200, { ok: true });
      else json(res, 404, { ok: false, error: 'not found' });
      return;
    }
  }

  json(res, 404, { ok: false, error: 'not found' });
}
