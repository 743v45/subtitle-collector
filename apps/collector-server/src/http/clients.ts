import { type IncomingMessage, type ServerResponse } from 'node:http';
import { listClients, requestReportingChange, requestCommand } from '../ws/server.js';
import { json, readJsonBody } from './http-util.js';

export async function handleClientsHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/clients') { json(res, 200, { ok: true, clients: listClients() }); return; }

  const m = pathname.match(/^\/api\/clients\/([^/]+)\/reporting$/);
  if (m && req.method === 'POST') {
    const clientId = decodeURIComponent(m[1]);
    const body = await readJsonBody(req);
    if (typeof body?.enabled !== 'boolean') { json(res, 400, { ok: false, error: 'enabled must be boolean' }); return; }
    const r = await requestReportingChange(clientId, body.enabled);
    if (!r.ok) {
      if (r.code === 'offline') { json(res, 404, { ok: false, error: 'client not online' }); return; }
      json(res, 504, { ok: false, error: 'extension result timeout' }); return;
    }
    json(res, 200, { ok: true, client_id: clientId, reporting_enabled: r.reporting_enabled });
    return;
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
