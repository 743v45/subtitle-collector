// HTTP handler：分类（categories）CRUD。
// 路由：GET/POST /api/categories、PATCH/DELETE /api/categories/:id。
// 沿用 http/queries.ts 范式（本地 json + readJsonBody + 正则路由）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listCategories, createCategory, updateCategory, deleteCategory } from '../db/queries.js';

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

export async function handleCategoriesHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/categories' && req.method === 'GET') {
    const scope = url.searchParams.get('scope');
    if (scope && scope !== 'agent' && scope !== 'human') { json(res, 400, { ok: false, error: 'scope must be agent|human' }); return; }
    json(res, 200, { ok: true, items: listCategories(db, (scope as 'agent' | 'human') ?? undefined) });
    return;
  }
  if (pathname === '/api/categories' && req.method === 'POST') {
    const b = await readJsonBody(req) as { name?: string; scope?: string };
    if (!b.name || (b.scope !== 'agent' && b.scope !== 'human')) { json(res, 400, { ok: false, error: 'name and scope(agent|human) required' }); return; }
    try {
      json(res, 200, { ok: true, category: createCategory(db, b.name, b.scope) });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('UNIQUE')) json(res, 409, { ok: false, error: 'category name+scope already exists' });
      else json(res, 500, { ok: false, error: msg });
    }
    return;
  }
  const m = pathname.match(/^\/api\/categories\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (req.method === 'PATCH') {
      const b = await readJsonBody(req) as { name?: string; sort_order?: number };
      const c = updateCategory(db, id, b);
      if (!c) { json(res, 404, { ok: false, error: 'not found' }); return; }
      json(res, 200, { ok: true, category: c });
      return;
    }
    if (req.method === 'DELETE') {
      deleteCategory(db, id);
      json(res, 200, { ok: true });
      return;
    }
  }
  json(res, 404, { ok: false, error: 'not found' });
}
