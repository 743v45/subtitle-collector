// HTTP handler：server 侧设置（settings KV）。
// 路由：GET/PUT /api/settings/tag-priority（标签展示优先级，四档精确排列）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { getTagPriority, setTagPriority } from '../db/settings.js';
import { json, readJsonBody } from './http-util.js';

export async function handleSettingsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (pathname === '/api/settings/tag-priority') {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, priority: getTagPriority(db) });
      return;
    }
    if (req.method === 'PUT') {
      const b = await readJsonBody(req) as { priority?: unknown };
      try {
        const priority = setTagPriority(db, b.priority);
        json(res, 200, { ok: true, priority });
      } catch {
        json(res, 400, { ok: false, error: 'priority must be an exact permutation of manual|batch|bili|ai' });
      }
      return;
    }
  }

  json(res, 404, { ok: false, error: 'not found' });
}
