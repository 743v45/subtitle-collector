import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listVideos, getVideo, getVersionPayload, getCreator } from '../db/queries.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleQueryHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/videos') {
    const q = url.searchParams.get('q') ?? undefined;
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
    const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') ?? '20')));
    json(res, 200, { ok: true, ...listVideos(db, q, page, size) });
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

  const creatorMatch = pathname.match(/^\/api\/creators\/(\d+)$/);
  if (creatorMatch) {
    // GET /api/creators/:id → UP 主详情（含 P2 字段 sign/level/fans/...），供 popup/web 展示
    const c = getCreator(db, Number(creatorMatch[1]));
    if (!c) { json(res, 404, { ok: false, error: 'creator not found' }); return; }
    json(res, 200, { ok: true, creator: c });
    return;
  }

  const versionMatch = pathname.match(/^\/api\/versions\/(\d+)$/);
  if (versionMatch) {
    const v = getVersionPayload(db, Number(versionMatch[1]));
    if (!v) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, version: v });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}
