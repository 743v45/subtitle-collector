// HTTP handler：UP 主（creators）列表/详情/打分类。
// 路由：GET /api/creators（列表+筛选）、GET /api/creators/:id（详情）、POST /api/creators/by-uid/:uid/category（打分类）。
// 沿用 http/queries.ts 范式（本地 json + readJsonBody + 正则路由）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listCreators, getCreator, setCreatorCategory } from '../db/queries.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export async function handleCreatorsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/creators' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? undefined;
    const category = url.searchParams.get('category') ?? undefined;
    const scope = url.searchParams.get('scope');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') ?? 20)));
    const r = listCreators(db, { q, category, scope: scope === 'agent' || scope === 'human' ? scope : undefined }, page, size);
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
  const cat = pathname.match(/^\/api\/creators\/by-uid\/([^/]+)\/category$/);
  if (cat && req.method === 'POST') {
    const source_uid = decodeURIComponent(cat[1]);
    const b = await readJsonBody(req) as { scope?: string; name?: string };
    if ((b.scope !== 'agent' && b.scope !== 'human') || !b.name) { json(res, 400, { ok: false, error: 'scope(agent|human) and name required' }); return; }
    const c = setCreatorCategory(db, 'bilibili', source_uid, b.scope, b.name);
    json(res, 200, { ok: true, creator: c });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}
