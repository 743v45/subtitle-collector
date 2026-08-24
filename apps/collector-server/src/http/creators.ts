// HTTP handler：UP 主（creators）列表/详情/打分类。
// 路由：GET /api/creators（列表+筛选）、GET /api/creators/:id（详情）、POST /api/creators/by-uid/:source/:uid/category（打分类）。
// 打分类路径带平台段：uid 两平台命名空间独立（B 站 mid / YouTube channelId），不带平台会写错行。
// 沿用 http/queries.ts 范式（本地 json + readJsonBody + 正则路由）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listCreators, getCreator, setCreatorCategory } from '../db/queries.js';
import { json, readJsonBody } from './http-util.js';

export async function handleCreatorsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const qp = (k: string): string | undefined => url.searchParams.get(k) ?? undefined;

  if (pathname === '/api/creators' && req.method === 'GET') {
    const q = qp('q');
    const category = qp('category');
    const scopeRaw = qp('scope');
    const source = qp('source'); // 平台过滤（bilibili|youtube）
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') ?? 20)));
    const sortRaw = qp('sort');
    const sort = sortRaw === 'fans' || sortRaw === 'video_count' ? sortRaw : 'first_seen';
    const r = listCreators(db, { q, category, source, scope: scopeRaw === 'agent' || scopeRaw === 'human' ? scopeRaw : undefined }, page, size, sort);
    json(res, 200, { ok: true, ...r });
    return;
  }
  const detail = pathname.match(/^\/api\/creators\/(\d+)$/);
  if (detail && req.method === 'GET') {
    const c = getCreator(db, Number(detail[1]));
    if (!c) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, creator: c });
    return;
  }
  // 平台枚举进正则：非 bilibili|youtube 直接 404（与 collect_tasks CHECK 同口径）
  const cat = pathname.match(/^\/api\/creators\/by-uid\/(bilibili|youtube)\/([^/]+)\/category$/);
  if (cat && req.method === 'POST') {
    const source = cat[1];
    const source_uid = decodeURIComponent(cat[2]);
    const b = await readJsonBody(req) as { scope?: string; name?: string };
    if ((b.scope !== 'agent' && b.scope !== 'human') || !b.name) { json(res, 400, { ok: false, error: 'scope(agent|human) and name required' }); return; }
    const c = setCreatorCategory(db, source, source_uid, b.scope, b.name);
    json(res, 200, { ok: true, creator: c });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}
