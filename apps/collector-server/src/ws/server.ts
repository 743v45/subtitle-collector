import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type Database from 'better-sqlite3';
import { ingestVideo, type IngestRequest } from '../db/ingest.js';

interface ExtConn {
  ws: WebSocket;
  extVersion: string | null;
  clientId: string | null;
  reportingEnabled: boolean;
}

const connections = new Map<string, ExtConn>(); // key = clientId（hello 后入表）

interface PendingEntry { resolve: (v: any) => void; timer: NodeJS.Timeout; }
const pending = new Map<string, PendingEntry>();

export function attachWsServer(httpServer: Server, _db: Database.Database, expectedToken?: string): void {
  const EXPECTED_TOKEN = expectedToken ?? process.env.COLLECTOR_TOKEN ?? ''; // 空 token 视为未配置，全部拒绝
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ext',
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const origin = req.headers['origin'];
      // Origin 是辅助防线（非浏览器/本地 Node 不带 Origin）；主鉴权靠 hello token（B1 备注）
      return !origin || origin.startsWith('chrome-extension://');
    },
  });

  wss.on('connection', (ws: WebSocket) => {
    const conn: ExtConn = { ws, extVersion: null, clientId: null, reportingEnabled: true };

    ws.on('message', async (data: RawData) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // 未完成 hello 握手且非 hello 消息：拒（防竞态未握手连接写库，B4）
      if (msg.type !== 'hello' && !conn.extVersion) return;

      if (msg.type === 'hello') {
        conn.extVersion = typeof msg.ext_version === 'string' ? msg.ext_version : null;
        // WS 握手 token 校验：比对预置 token，不匹配关闭连接（防 WS CSRF，学 opencli）
        if (!EXPECTED_TOKEN || msg.token !== EXPECTED_TOKEN) {
          ws.send(JSON.stringify({ type: 'hello-nack', ok: false, error: 'bad token' }));
          ws.close(4001, 'bad token');
          console.warn(`[ws] hello 握手失败：token 不匹配（ext_version=${conn.extVersion ?? 'unknown'}）`);
          return;
        }
        console.log(`[ws] hello 握手成功：ext_version=${conn.extVersion ?? 'unknown'}`);
        ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
        conn.clientId = typeof msg.client_id === 'string' && msg.client_id ? msg.client_id : null;
        conn.reportingEnabled = msg.reporting_enabled !== false; // 缺省 true
        if (conn.clientId) {
          const prev = connections.get(conn.clientId);
          if (prev && prev.ws !== ws && prev.ws.readyState === WebSocket.OPEN) prev.ws.close(4000, 'replaced');
          connections.set(conn.clientId, conn);
        }
        return;
      }

      if (msg.type === 'log') {
        const level = msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'info';
        console[level](`[ext] ${msg.msg}`);
        return;
      }

      if (msg.type === 'reporting-state') {
        conn.reportingEnabled = msg.enabled === true;
        return;
      }

      if (msg.type === 'ingest' && msg.payload) {
        try {
          const result = ingestVideo(_db, msg.payload as IngestRequest);
          ws.send(JSON.stringify({ type: 'ingest-ack', ok: true, ...result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ingest-ack', ok: false, error: (err as Error).message }));
        }
        return;
      }

      if (msg.type === 'result') {
        const entry = pending.get(msg.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(msg.id);
          entry.resolve(msg);
        } else {
          console.log(`[ext] result id=${msg.id} ok=${msg.ok}`);
        }
        return;
      }
    });

    ws.on('close', () => {
      if (conn.clientId && connections.get(conn.clientId) === conn) connections.delete(conn.clientId);
    });
  });
}

// port 参数保留为向后兼容签名（MVP 单实例广播；未来可按 port/contextId 路由）
export function broadcastCommand(_port: number, cmd: { id: string; action: string; [k: string]: unknown }): void {
  const payload = JSON.stringify(cmd);
  for (const c of connections.values()) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(payload);
    }
  }
}

export function listClients(): Array<{ client_id: string; ext_version: string | null; reporting_enabled: boolean; connected: true }> {
  return [...connections.values()]
    .filter(c => c.clientId && c.ws.readyState === WebSocket.OPEN)
    .map(c => ({ client_id: c.clientId!, ext_version: c.extVersion, reporting_enabled: c.reportingEnabled, connected: true }));
}

export function sendToClient(clientId: string, cmd: { id: string; action: string; [k: string]: unknown }): boolean {
  const conn = connections.get(clientId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
  conn.ws.send(JSON.stringify(cmd));
  return true;
}

export async function requestReportingChange(
  clientId: string,
  enabled: boolean,
  timeoutMs = 5000,
): Promise<{ ok: true; reporting_enabled: boolean } | { ok: false; code: 'offline' | 'timeout' }> {
  const id = randomUUID();
  const sent = sendToClient(clientId, { id, action: 'set-reporting', enabled });
  if (!sent) return { ok: false, code: 'offline' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ ok: false, code: 'timeout' }); }
    }, timeoutMs);
    pending.set(id, {
      resolve: (msg: any) => {
        const conn = connections.get(clientId);
        if (conn) conn.reportingEnabled = msg?.data?.reporting_enabled === true;
        resolve({ ok: true, reporting_enabled: msg?.data?.reporting_enabled === true });
      },
      timer,
    });
  });
}
