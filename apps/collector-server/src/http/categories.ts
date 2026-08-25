// HTTP handler：分类（categories）CRUD。
// 路由：GET/POST /api/categories、PATCH/DELETE /api/categories/:id。
// 沿用 http/queries.ts 范式（本地 json + readJsonBody + 正则路由）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listCategories, createCategory, updateCategory, deleteCategory } from '../db/queries.js';
import { json, readJsonBody } from './http-util.js';

export async function handleCategoriesHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/categories' && req.method === 'GET') {
    // 分类已无 scope 属性（值域合一）：非空 scope 参数一律 400，暴露过时调用方；空串视同未传
    const scope = url.searchParams.get('scope');
    if (scope) { json(res, 400, { ok: false, error: 'category has no scope; use plain name' }); return; }
    json(res, 200, { ok: true, items: listCategories(db) });
    return;
  }
  if (pathname === '/api/categories' && req.method === 'POST') {
    const b = await readJsonBody(req) as { name?: string };
    if (!b.name) { json(res, 400, { ok: false, error: 'name required' }); return; }
    try {
      json(res, 200, { ok: true, category: createCategory(db, b.name) });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('UNIQUE')) json(res, 409, { ok: false, error: 'category name already exists' });
      else json(res, 500, { ok: false, error: msg });
    }
    return;
  }
  const m = pathname.match(/^\/api\/categories\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (req.method === 'PATCH') {
      const b = await readJsonBody(req) as { name?: string; sort_order?: number };
      // 改名撞 UNIQUE(name) → 409（对齐 POST 先例；此前经兜底 500）
      try {
        const c = updateCategory(db, id, b);
        if (!c) { json(res, 404, { ok: false, error: 'not found' }); return; }
        json(res, 200, { ok: true, category: c });
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('UNIQUE')) json(res, 409, { ok: false, error: 'category name already exists' });
        else json(res, 500, { ok: false, error: msg });
      }
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
