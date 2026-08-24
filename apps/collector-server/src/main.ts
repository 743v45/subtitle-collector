import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { openDb, migrate, runMigrations } from './db/migrate.js';
import { attachBackupTimer } from './db/backup.js';
import { attachWsServer } from './ws/server.js';
import { handleQueryHttp } from './http/queries.js';
import { handleClientsHttp } from './http/clients.js';
import { handleCategoriesHttp } from './http/categories.js';
import { handleCreatorsHttp } from './http/creators.js';
import { handleStatsHttp } from './http/stats.js';
import { handleTagsHttp } from './http/tags.js';
import { handleTranslateHttp } from './http/translate.js';
import { handleSettingsHttp } from './http/settings.js';
import { handleTasksHttp } from './http/tasks.js';
import { runHandler, httpAuthOk, httpOriginAllowed } from './http/http-util.js';
import { attachTaskScheduler } from './tasks/tasks.js';

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? './bilibili-collector.db';
const PORT = Number(process.env.COLLECTOR_PORT ?? 21527);
const HOST = process.env.COLLECTOR_HOST ?? '127.0.0.1';
// 默认空 = 无 token 模式：WS hello 不校验、loopback HTTP 免鉴权，扩展默认 server URL（不带 ?token=）开箱即连。
// server 端可选设 COLLECTOR_TOKEN：设置后扩展的 server URL 须带 ?token=xxx（popup 服务器配置），
// CLI 须带 Bearer token；暴露部署（0.0.0.0 / ALLOWED_HOSTS）必须设置（见下方 HTTP_AUTH_REQUIRED 校验）。
const TOKEN = process.env.COLLECTOR_TOKEN ?? '';
// C2 opt-in:显式放行非 loopback 的 Host(及其 Origin),逗号分隔。默认空 → 仅 loopback,保留 DNS-rebinding 防护。
// 需暴露到局域网/docker 宿主 IP 时设为 IP/主机名(如 192.168.1.5,collector.local)。配合 COLLECTOR_HOST=0.0.0.0 使用。
const ALLOWED_HOSTS = (process.env.COLLECTOR_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// HTTP /api/* 鉴权（此前 token 只护 WS hello，HTTP 控制面——含可驱动扩展 navigate 任意 URL 的
// /api/clients/:id/command——完全裸奔）。仅暴露部署强制：同源浏览器免 token（web/手机零配置），
// 其余（curl/CLI/扩展 Origin）必须 Bearer；loopback 部署保持免鉴权。
const HTTP_AUTH_REQUIRED = HOST === '0.0.0.0' || ALLOWED_HOSTS.length > 0;
if (HTTP_AUTH_REQUIRED && !process.env.COLLECTOR_TOKEN) {
  console.error('[collector-server] 已暴露到非 loopback（COLLECTOR_HOST=0.0.0.0 / COLLECTOR_ALLOWED_HOSTS），必须设置 COLLECTOR_TOKEN（HTTP /api/* 强制 Bearer）');
  process.exit(1);
}

const db = openDb(DB_PATH);
migrate(db);
runMigrations(db);

// C2: loopback HTTP 对浏览器是真实攻击面——DNS rebinding 可绕同源策略读 /api/* 与静态页。
// /ping 外的所有请求校验 Host（防 rebinding）+ Origin（浏览器请求须来自扩展或同源）。
// 设了 COLLECTOR_ALLOWED_HOSTS 时,额外放行这些 Host 及其 Origin(用于显式暴露到非 loopback)。
// 判定逻辑在 http/http-util.ts 的 httpOriginAllowed（localhost/127.0.0.1/放行主机的 Origin
// 均按 URL hostname 精确匹配,防 localhost.evil.com 类前缀注入）。
const originAllowed = (req: IncomingMessage): boolean =>
  httpOriginAllowed({
    host: req.headers['host'] as string | undefined,
    origin: req.headers['origin'] as string | undefined,
    allowedHosts: ALLOWED_HOSTS,
  });

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

// /api/* 路由分发表（createServer 回调按序前缀匹配）；全部 handler 统一三参（req, res, db）。
// /api/upper-videos/expand（按 UP 批量的列表拉取）复用 tasks handler——批量采集域。
const API_ROUTES: Array<[prefix: string, handler: (req: IncomingMessage, res: ServerResponse, db: Database.Database) => Promise<void> | void]> = [
  ['/api/clients', handleClientsHttp],
  ['/api/collect-tasks', (req, res, db) => handleTasksHttp(req, res, db)],
  ['/api/upper-videos', (req, res, db) => handleTasksHttp(req, res, db)],
  ['/api/categories', (req, res, db) => handleCategoriesHttp(req, res, db)],
  ['/api/creators', (req, res, db) => handleCreatorsHttp(req, res, db)],
  ['/api/stats', (req, res, db) => handleStatsHttp(req, res, db)],
  ['/api/tags', (req, res, db) => handleTagsHttp(req, res, db)],
  ['/api/translate', (req, res, db) => handleTranslateHttp(req, res, db)],
  ['/api/settings', (req, res, db) => handleSettingsHttp(req, res, db)],
  ['/api/', (req, res, db) => handleQueryHttp(req, res, db)],
];

const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (!originAllowed(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"forbidden"}'); return; } // C2
  // 暴露部署的 /api/* 统一鉴权（/ping 探活与静态页除外；web/手机同源浏览器免 token）
  if (HTTP_AUTH_REQUIRED && req.url?.startsWith('/api/') && !httpAuthOk({
    required: true,
    token: TOKEN,
    origin: req.headers['origin'] as string | undefined,
    host: req.headers['host'] as string | undefined,
    authorization: req.headers['authorization'] as string | undefined,
    secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
  })) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"ok":false,"error":"unauthorized"}');
    return;
  }
  // runHandler 兜底：handler 抛错（含非法 JSON 的 HttpError）只影响该请求，
  // 不再以 unhandledRejection 崩掉整个进程（连带全部 WS 连接）。
  // 分发表驱动（顺序即匹配优先级）：前缀专属 handler 在前，/api/ 兜底（handleQueryHttp）最后。
  for (const [prefix, handler] of API_ROUTES) {
    if (req.url?.startsWith(prefix)) { void runHandler(res, () => handler(req, res, db)); return; }
  }
  // 静态托管 collector-web 产物（非 /ping 非 /api/ 的请求）——C2 校验已在上方通过
  if (req.url && !req.url.startsWith('/api/') && req.url !== '/ping') { serveStatic(req, res); return; }
  res.writeHead(404); res.end('not found');
});

attachWsServer(httpServer, db, TOKEN);
attachTaskScheduler(db); // 采集任务调度器（pending → 扩展派发 → 回执落 status）
attachBackupTimer(db, DB_PATH); // 容器内定时备份（VACUUM INTO 一致性快照，2026-08-24 损库事故产物）

httpServer.listen(PORT, HOST, () => {
  if (HOST === '0.0.0.0') {
    console.log(`[collector-server] listening on all interfaces (0.0.0.0):${PORT} — 用本机 IP 访问 (ws: /ext, api: /api/*)${ALLOWED_HOSTS.length ? ` — 放行 host: ${ALLOWED_HOSTS.join(', ')}` : ''}`);
  } else {
    console.log(`[collector-server] listening on http://${HOST}:${PORT} (ws: /ext, api: /api/*)${ALLOWED_HOSTS.length ? ` — 放行 host: ${ALLOWED_HOSTS.join(', ')}` : ''}`);
  }
});
