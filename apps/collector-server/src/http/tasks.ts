import { type IncomingMessage, type ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { extractVideoUrl, expandShortLink, parseVideoUrl, createTask, createTasksBatch, findActiveTask, expandUpperVideos, getTask, deleteTask, listTasks, kickTaskScheduler, type FetchLike, type TaskStatus } from '../tasks/tasks.js';
import { json, readJsonBody } from './http-util.js';

// ── 采集任务 HTTP 接口（手机/网页提交入口）──
// POST   /api/collect-tasks        { text } → 从粘贴文本提取 URL → 建 pending 任务并尝试派发
//                                  （同视频已有未终态任务则返回既有任务，created:false）
// POST   /api/collect-tasks/batch  { vids[], source?, client_id? } → 批量建任务（popup/web 按 UP 勾选批量采集）并尝试派发
// GET    /api/collect-tasks        任务列表:limit(默认20)或 page+page_size 分页 + status 逗号筛选
//                                  (采集页 limit=30 最近列表;历史页 page/page_size+status 全量分页)
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
      // 未终态去重（判据同批量端点）：同 (source, source_vid) 已有 pending/dispatched → 返回既有任务
      //（created:false）不新建——手机分享文本双击提交不再产生两条 pending（可能双采）
      const active = findActiveTask(db, target.source, target.source_vid);
      if (active) { json(res, 200, { ok: true, task: active, created: false }); return; }
      const task = createTask(db, target);
      kickTaskScheduler(); // 事件驱动：建任务立即尝试派发
      json(res, 200, { ok: true, task, created: true });
      return;
    }
    if (req.method === 'GET') {
      // 两种形态:采集页 ?limit=N(最近列表,无分页);历史页 ?page=N&page_size=M&status=a,b(全量分页+筛选)
      const STATUSES: readonly TaskStatus[] = ['pending', 'dispatched', 'succeeded', 'failed', 'limited'];
      const statusParam = url.searchParams.get('status');
      const statusFilter = statusParam
        ? statusParam.split(',').map((s) => s.trim()).filter((s): s is TaskStatus => (STATUSES as readonly string[]).includes(s))
        : undefined;
      let limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('limit') ?? '20')) || 20));
      let offset = 0;
      let paged = false;
      const page = Number(url.searchParams.get('page') ?? '');
      const pageSize = Number(url.searchParams.get('page_size') ?? '');
      if (Number.isInteger(page) && page >= 1 && Number.isInteger(pageSize) && pageSize >= 1) {
        limit = Math.min(100, pageSize);
        offset = (page - 1) * limit;
        paged = true;
      }
      json(res, 200, { ok: true, ...(paged ? { page, page_size: limit } : {}), ...listTasks(db, limit, offset, statusFilter) });
      return;
    }
    json(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // 批量建任务（数字 id 路由之前匹配，防 /batch 被 (\d+) 之外的逻辑误吃——正则不匹配非数字，顺序只是可读性）
  if (pathname === '/api/collect-tasks/batch') {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    const body = await readJsonBody(req);
    // body 统一格式（2026-08-21，趁无外部消费者一次改齐）：{vids[], source?, client_id?}
    //   - bvids 旧键彻底删除（旧格式 = {vids, source:'bilibili'}，语义已并入）→ 旧请求 400 可见
    //   - client_id（可选）snake_case 对齐 API 其余字段（source_vid/creator_client_id）：
    //     创建者扩展 ID —— sticky 派发（任务跟随创建者，离线降级任意）
    const source = body?.source === 'youtube' ? 'youtube' : 'bilibili';
    const vids = Array.isArray(body?.vids) ? body.vids : null;
    const clientId = typeof body?.client_id === 'string' && body.client_id ? body.client_id : null;
    const label = source === 'youtube' ? 'YouTube 视频 ID（11 位）' : 'BV 号';
    if (!vids || vids.length === 0) { json(res, 400, { ok: false, error: `vids: string[] required（至少一个${label}）` }); return; }
    const r = createTasksBatch(db, vids, source, clientId);
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
