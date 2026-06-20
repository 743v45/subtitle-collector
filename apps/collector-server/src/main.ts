import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
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

// Task 6 Step 15: 静态托管 collector-web 构建产物。
// 落在 C2 httpOriginAllowed 守卫之后（调用点先校验 Origin 再走 serveStatic），
// 确保静态文件不绕过安全校验。
const PUBLIC_DIR = join(process.cwd(), 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const fp = join(PUBLIC_DIR, url.pathname === '/' ? '/index.html' : url.pathname);
  // 路径穿越防护：解析后必须在 PUBLIC_DIR 之下
  if (!fp.startsWith(PUBLIC_DIR) || !existsSync(fp)) { res.writeHead(404); res.end('not found'); return; }
  const contentType = MIME[extname(fp)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(readFileSync(fp));
}

const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (!httpOriginAllowed(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"forbidden"}'); return; } // C2
  if (req.url?.startsWith('/api/')) { handleQueryHttp(req, res, db); return; }
  // 静态托管 collector-web 产物（非 /ping 非 /api/ 的请求）——C2 校验已在上方通过
  if (req.url && !req.url.startsWith('/api/') && req.url !== '/ping') { serveStatic(req, res); return; }
  res.writeHead(404); res.end('not found');
});

attachWsServer(httpServer, db, TOKEN);

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[collector-server] listening on http://127.0.0.1:${PORT} (ws: /ext, api: /api/*)`);
});
