import { createServer } from 'node:http';
import { openDb, migrate } from './db/migrate.js';
import { attachWsServer } from './ws/server.js';

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? './bilibili-collector.db';
const PORT = Number(process.env.COLLECTOR_PORT ?? 21527);
const TOKEN = process.env.COLLECTOR_TOKEN ?? 'change-me-collector-token'; // 与扩展 config.js 一致

const db = openDb(DB_PATH);
migrate(db);

const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  // HTTP 查询 API 与静态托管在后续 task 接上
  res.writeHead(404); res.end('not found');
});

attachWsServer(httpServer, db, TOKEN);

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[collector-server] listening on http://127.0.0.1:${PORT} (ws: /ext)`);
});
