import { type IncomingMessage, type ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { extractVideoUrl, expandShortLink, parseVideoUrl, createTask, createTasksBatch, expandUpperVideos, getTask, deleteTask, listTasks, kickTaskScheduler, type FetchLike } from '../tasks/tasks.js';

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
// POST   /api/collect-tasks/batch  { bvids[] } → 批量建任务（popup/web 按 UP 勾选批量采集）并尝试派发
// GET    /api/collect-tasks        最近任务列表（手机「采集」页主体）
// GET    /api/collect-tasks/:id    单任务状态（手机每 2s 轮询直到终态）
// DELETE /api/collect-tasks/:id    删除任务（采集页删除按钮,任意状态可删）
// POST   /api/upper-videos/expand  { mid } → 经扩展 WS 代理拉 UP 全部视频 + 标注已采（web「按 UP 批量」用）
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

  // 批量建任务（数字 id 路由之前匹配，防 /batch 被 (\d+) 之外的逻辑误吃——正则不匹配非数字，顺序只是可读性）
  if (pathname === '/api/collect-tasks/batch') {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    const body = await readJsonBody(req);
    // 兼容两种 body：{bvids[]}（bilibili，旧）与 {vids[], source}（source=bilibili|youtube，2026-08-21）
    const source = body?.source === 'youtube' ? 'youtube' : 'bilibili';
    const vids = Array.isArray(body?.vids) ? body.vids : (Array.isArray(body?.bvids) ? body.bvids : []);
    const label = source === 'youtube' ? 'YouTube 视频 ID（11 位）' : 'BV 号';
    if (vids.length === 0) { json(res, 400, { ok: false, error: `vids: string[] required（至少一个${label}）` }); return; }
    const r = createTasksBatch(db, vids, source);
    if (r.created.length > 0) kickTaskScheduler(); // 事件驱动：建任务立即尝试派发
    json(res, 200, { ok: true, created: r.created.length, skipped: r.skipped.length, tasks: r.created });
    return;
  }

  // UP 全部视频列表（经扩展代理拉取；main.ts 把 /api/upper-videos 前缀路由到本 handler）
  if (pathname === '/api/upper-videos/expand') {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    const body = await readJsonBody(req);
    const mid = typeof body?.mid === 'string' ? body.mid.trim() : '';
    if (!/^\d+$/.test(mid)) { json(res, 400, { ok: false, error: 'mid（B 站用户数字 ID）required' }); return; }
    try {
      const r = await expandUpperVideos(db, mid);
      json(res, 200, { ok: true, ...r });
    } catch (e) {
      // 扩展离线/超时/风控 → 503（可重试的临时态）
      json(res, 503, { ok: false, error: String((e as Error)?.message ?? e) });
    }
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
