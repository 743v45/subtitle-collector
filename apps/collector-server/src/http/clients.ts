import { type IncomingMessage, type ServerResponse } from 'node:http';
import { listClients, requestReportingChange, requestCommand } from '../ws/server.js';

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

  // 下发命令端点（CLI collector-cli clients command）：body 含 action + 任意 params + 可选 timeout
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
    json(res, 200, { ok: true, client_id: clientId, action, result: r.result });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}
