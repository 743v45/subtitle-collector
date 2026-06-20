import { createServer, type IncomingMessage } from 'node:http';
import { openDb, migrate } from './db/migrate.js';
import { attachWsServer } from './ws/server.js';
import { handleQueryHttp } from './http/queries.js';

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? './bilibili-collector.db';
const PORT = Number(process.env.COLLECTOR_PORT ?? 21527);
const TOKEN = process.env.COLLECTOR_TOKEN ?? 'change-me-collector-token'; // 与扩展 config.js 一致

const db = openDb(DB_PATH);
migrate(db);

// C2: loopback HTTP 对浏览器是真实攻击面——DNS rebinding 可绕同源策略读 /api/* 与静态页。
// /ping 外的所有请求校验 Host（防 rebinding）+ Origin（浏览器请求须来自扩展或同源）。
const httpOriginAllowed = (req: IncomingMessage): boolean => {
  const host = String(req.headers['host'] ?? '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') return false; // DNS rebinding：非 loopback hostname 直接拒
  const origin = req.headers['origin'];
  if (!origin) return true; // curl / 服务端同源 fetch 无 Origin，放行
  const o = String(origin);
  return o.startsWith('chrome-extension://') // 扩展
    || o.startsWith('http://localhost')       // 同源 collector-web
    || o.startsWith('http://127.0.0.1');
};

const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (!httpOriginAllowed(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"forbidden"}'); return; } // C2
  if (req.url?.startsWith('/api/')) { handleQueryHttp(req, res, db); return; }
  // 静态托管 collector-web 产物在 Task 6 接上
  res.writeHead(404); res.end('not found');
});

attachWsServer(httpServer, db, TOKEN);

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[collector-server] listening on http://127.0.0.1:${PORT} (ws: /ext, api: /api/*)`);
});
