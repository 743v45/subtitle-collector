import { type IncomingMessage, type ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listClients, requestReportingChange, requestTaskDispatchChange, requestCommand } from '../ws/server.js';
import { json, readJsonBody } from './http-util.js';

// reporting / task-dispatch 两开关端点的同构处理（2026-08-23 抽出，降 handleClientsHttp 复杂度）：
// 校验 enabled 布尔 → 调切换函数 → 404 离线 / 504 回执超时 / 200 新状态三态。
// 成功体 {ok, client_id, ...切换函数返回的新状态字段}（reporting_enabled / task_dispatch_enabled）。
type ToggleResult = { ok: true } & Record<string, unknown> | { ok: false; code: 'offline' | 'timeout' };
async function handleTogglePost(
  res: ServerResponse,
  clientId: string,
  body: unknown,
  toggle: (clientId: string, enabled: boolean) => Promise<ToggleResult>,
): Promise<void> {
  if (typeof (body as { enabled?: unknown } | null)?.enabled !== 'boolean') {
    json(res, 400, { ok: false, error: 'enabled must be boolean' });
    return;
  }
  const r = await toggle(clientId, (body as { enabled: boolean }).enabled);
  if (!r.ok) {
    if (r.code === 'offline') { json(res, 404, { ok: false, error: 'client not online' }); return; }
    json(res, 504, { ok: false, error: 'extension result timeout' }); return;
  }
  json(res, 200, { client_id: clientId, ...r }); // r 含 ok:true + 新状态字段（reporting_enabled / task_dispatch_enabled）
}

export async function handleClientsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  // 全量视图：DB 注册表（含离线，名字/时间线持久）合并内存在线态（2026-08-24 客户端命名）
  if (pathname === '/api/clients') { json(res, 200, { ok: true, clients: listClients(db) }); return; }

  // 两开关端点（CLI clients reporting / task-dispatch、web 客户端页）共用同构处理
  const toggles: Array<[RegExp, (clientId: string, enabled: boolean) => Promise<ToggleResult>]> = [
    [/^\/api\/clients\/([^/]+)\/reporting$/, requestReportingChange],
    // task-dispatch（2026-08-23 仅上报状态）：off = 调度器不再给该客户端派采集任务（保持连接上报）
    [/^\/api\/clients\/([^/]+)\/task-dispatch$/, requestTaskDispatchChange],
  ];
  for (const [re, toggle] of toggles) {
    const m = pathname.match(re);
    if (m && req.method === 'POST') {
      await handleTogglePost(res, decodeURIComponent(m[1]), await readJsonBody(req), toggle);
      return;
    }
  }

  // 下发命令端点（CLI collector-cli clients command）：body 含 action + 任意 params + 可选 timeout。
  // 错误码语义（2026-08-21 收敛为「HTTP 状态即结果」，对齐 expand 的 503 / reporting 的 404·504）：
  //   404 客户端离线 / 504 回执超时 / 502 扩展执行失败（下游执行体失败，error = 扩展回执 error 原文）。
  // 成功 200 的 result 直接是扩展回执 data（去掉 {ok,data} 一层包装，外层 ok 即终判）——
  // CLI 不再需要层层挖 result.ok/result.error。
  const mc = pathname.match(/^\/api\/clients\/([^/]+)\/command$/);
  if (mc && req.method === 'POST') {
    const clientId = decodeURIComponent(mc[1]);
    const body = await readJsonBody(req);
    if (typeof body?.action !== 'string' || !body.action) {
      json(res, 400, { ok: false, error: 'action must be non-empty string' });
      return;
    }
    const { action, timeout, ...params } = body;
    const r = await requestCommand(clientId, action, params, typeof timeout === 'number' ? timeout : undefined);
    if (!r.ok) {
      if (r.code === 'offline') { json(res, 404, { ok: false, error: 'client not online' }); return; }
      json(res, 504, { ok: false, error: 'extension result timeout' }); return;
    }
    if (r.result?.ok !== true) {
      json(res, 502, { ok: false, error: String(r.result?.error ?? 'extension command failed') });
      return;
    }
    json(res, 200, { ok: true, client_id: clientId, action, result: r.result?.data });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}
