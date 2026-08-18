import { type IncomingMessage, type ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { extractVideoUrl, expandShortLink, parseVideoUrl, createTask, getTask, deleteTask, listTasks, kickTaskScheduler, type FetchLike } from '../tasks/tasks.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
  });
}

// ── 采集任务 HTTP 接口（手机/网页提交入口）──
// POST   /api/collect-tasks        { text } → 从粘贴文本提取 URL → 建 pending 任务并尝试派发
// GET    /api/collect-tasks        最近任务列表（手机「采集」页主体）
// GET    /api/collect-tasks/:id    单任务状态（手机每 2s 轮询直到终态）
// DELETE /api/collect-tasks/:id    删除任务（采集页删除按钮,任意状态可删）
export async function handleTasksHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const fetcher: FetchLike = globalThis.fetch;

  if (pathname === '/api/collect-tasks') {
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const text = typeof body?.text === 'string' ? body.text : '';
      const rawUrl = extractVideoUrl(text);
      if (!rawUrl) { json(res, 400, { ok: false, error: '未找到视频链接（支持 B 站 / YouTube 分享或视频页链接）' }); return; }
      const expanded = await expandShortLink(rawUrl, fetcher);
      const target = parseVideoUrl(expanded);
      if (!target) { json(res, 400, { ok: false, error: '链接无法识别为 B 站 / YouTube 视频' }); return; }
      const task = createTask(db, target);
      kickTaskScheduler(); // 事件驱动：建任务立即尝试派发
      json(res, 200, { ok: true, task });
      return;
    }
    if (req.method === 'GET') {
      const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('limit') ?? '20')) || 20));
      json(res, 200, { ok: true, ...listTasks(db, limit) });
      return;
    }
    json(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  const m = pathname.match(/^\/api\/collect-tasks\/(\d+)$/);
  if (m && req.method === 'GET') {
    const task = getTask(db, Number(m[1]));
    if (!task) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, task });
    return;
  }
  if (m && req.method === 'DELETE') {
    const deleted = deleteTask(db, Number(m[1]));
    if (!deleted) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}
