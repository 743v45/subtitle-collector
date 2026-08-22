// HTTP handler：server 侧设置（settings KV）。
// 路由：GET/PUT /api/settings/tag-priority（标签展示优先级，四档精确排列）
//       GET/PUT /api/settings/collect-timeout（采集超时 {bilibili, youtube} 毫秒,
//             youtube=扩展无进展窗口,bilibili=server 等回执预算;范围 [15s, 600s]）
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { getTagPriority, setTagPriority, getCollectTimeout, setCollectTimeout } from '../db/settings.js';
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

  if (pathname === '/api/settings/collect-timeout') {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, ...getCollectTimeout(db) });
      return;
    }
    if (req.method === 'PUT') {
      const b = await readJsonBody(req);
      try {
        const saved = setCollectTimeout(db, b);
        json(res, 200, { ok: true, ...saved });
      } catch (e) {
        json(res, 400, { ok: false, error: String((e as Error).message) });
      }
      return;
    }
  }

  json(res, 404, { ok: false, error: 'not found' });
}
