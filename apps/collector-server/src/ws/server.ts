import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type Database from 'better-sqlite3';
import { ingestVideo, type IngestRequest } from '../db/ingest.js';

interface ExtConn {
  ws: WebSocket;
  extVersion: string | null;
}

const connections = new Set<ExtConn>();

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
    const conn: ExtConn = { ws, extVersion: null };
    connections.add(conn);

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
          return;
        }
        ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
        return;
      }

      if (msg.type === 'log') {
        const level = msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'info';
        console[level](`[ext] ${msg.msg}`);
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
        // MVP：记录到 console；后续可挂 pending Promise resolve
        console.log(`[ext] result id=${msg.id} ok=${msg.ok}`);
        return;
      }
    });

    ws.on('close', () => { connections.delete(conn); });
  });
}

// port 参数保留为向后兼容签名（MVP 单实例广播；未来可按 port/contextId 路由）
export function broadcastCommand(_port: number, cmd: { id: string; action: string; [k: string]: unknown }): void {
  const payload = JSON.stringify(cmd);
  for (const c of connections) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(payload);
    }
  }
}
