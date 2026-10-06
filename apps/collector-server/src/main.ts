import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { handleAsrHttp } from './http/asr.js';
import { handleCommentsHttp } from './http/comments.js';
import { handleSettingsHttp, type StatusContext } from './http/settings.js';
import { handleSubSearchHttp } from './http/sub-search.js';
import { handleExportHttp } from './http/export.js';
import { handleTasksHttp } from './http/tasks.js';
import { handleCollectProxyHttp } from './http/collect-proxy.js';
import { handleJobsHttp } from './http/jobs.js';
import { createStaticFileServer } from './http/static-files.js';
import { runHandler, httpAuthOk, httpOriginAllowed, isPlaceholderToken } from './http/http-util.js';
import { attachTaskScheduler } from './tasks/tasks.js';
import { attachJobsWorker } from './jobs/runner.js';

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
// B2 启动闸（含占位符拒绝）：暴露部署必须配置非占位符 token——占位符（change-me-collector-token）
// 等效未配置，查 README/compose 文档即可猜到，控制面（navigate 任意 URL）等于公开接口。
// 拒绝路径位于 openDb 之前（保持现状）：不碰库、不监听端口，直接退出。
const HTTP_AUTH_REQUIRED = HOST === '0.0.0.0' || ALLOWED_HOSTS.length > 0;
if (HTTP_AUTH_REQUIRED && (!TOKEN || isPlaceholderToken(TOKEN))) {
  console.error(
    TOKEN
      ? `[collector-server] 已暴露到非 loopback，COLLECTOR_TOKEN 仍是占位符（${TOKEN}）——等效未配置，拒绝启动。`
      : '[collector-server] 已暴露到非 loopback（COLLECTOR_HOST=0.0.0.0 / COLLECTOR_ALLOWED_HOSTS），必须设置 COLLECTOR_TOKEN（HTTP /api/* 强制 Bearer）',
  );
  console.error('[collector-server] 生成强随机 token：node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
  process.exit(1);
}

const db = openDb(DB_PATH);
migrate(db);
runMigrations(db);

// /api/status 上下文（http/settings.ts StatusContext）：进程启动时刻 + 配置快照单点装配。
// token 只带 tokenConfigured 布尔，明文不出进程边界。
const STARTED_AT = Date.now();
const STATUS_CONTEXT: StatusContext = {
  host: HOST,
  port: PORT,
  authRequired: HTTP_AUTH_REQUIRED,
  tokenConfigured: TOKEN !== '',
  allowedHosts: ALLOWED_HOSTS,
  dbPath: DB_PATH,
  startedAt: STARTED_AT,
};

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

// Task 6 Step 15: 静态托管 collector-web 构建产物（实现抽至 http/static-files.ts——
// 目录路径 EISDIR 崩进程回归修复，2026-10-04）。
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
const serveStatic = createStaticFileServer(PUBLIC_DIR, MIME);

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
  ['/api/asr', (req, res, db) => handleAsrHttp(req, res, db)],
  ['/api/comments', (req, res, db) => handleCommentsHttp(req, res, db)],
  ['/api/settings', (req, res, db) => handleSettingsHttp(req, res, db, STATUS_CONTEXT)],
  // /api/status 也走 handleSettingsHttp（status 路由与其同文件），但前缀不同须单列一行（否则落 /api/ 兜底 404）
  ['/api/status', (req, res, db) => handleSettingsHttp(req, res, db, STATUS_CONTEXT)],
  ['/api/sub-search', (req, res, db) => handleSubSearchHttp(req, res, db)],
  // 文件下载通道（CLI 全功能 web 化 Phase 2）：videos/subtitle/bundle 三个导出端点，内部按 pathname 分支
  ['/api/export', (req, res, db) => handleExportHttp(req, res, db)],
  // 采集编排三端点（CLI 全功能 web 化 Phase 3）：collect-search / season/preview / upper-info/refresh，
  // server 内部白名单选 action 驱动扩展（非通用代理），内部按 pathname 分支；前缀须在 /api/ 兜底之前
  ['/api/collect-search', (req, res, db) => handleCollectProxyHttp(req, res, db)],
  ['/api/season', (req, res, db) => handleCollectProxyHttp(req, res, db)],
  ['/api/upper-info', (req, res, db) => handleCollectProxyHttp(req, res, db)],
  // jobs 任务台账（CLI 全功能 web 化 Phase 4）：asr-backfill / collect-find 长任务的提交/查询/取消，
  // 执行由 attachJobsWorker 的进程内串行执行器消费；前缀须在 /api/ 兜底之前
  ['/api/jobs', (req, res, db) => handleJobsHttp(req, res, db)],
  ['/api/', (req, res, db) => handleQueryHttp(req, res, db)],
];

// B1 401 结构化日志的配套净化：请求方可控的头（host/origin/url/sec-fetch-site）进日志前
// 去端口、去控制字符、截断，防伪造头把换行等注入内容带进日志。
// authorization 头任何情况下不落日志——只记 hasBearer 布尔（是否带 Bearer 形态头），防 token 入日志。
const sanitizeForLog = (v: string | undefined, max = 64): string => {
  if (!v) return '->';
  const cleaned = String(v).replace(/[\x00-\x1f\x7f]/g, '').split(':')[0].trim().slice(0, max);
  return cleaned || '->';
};
const originHostnameForLog = (v: string | undefined): string => {
  if (!v) return '->';
  try {
    // URL hostname 本就不含端口；再截断 + 控制字符净化对齐 sanitizeForLog
    return new URL(String(v)).hostname.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64) || '->';
  } catch { return '->'; }
};

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
    // B1：401 此前零日志——暴露部署下鉴权失败不可观测。结构化一行供 docker logs grep '[http] 401'。
    const authz = req.headers['authorization'];
    console.warn(
      `[http] 401 method=${req.method ?? '->'} url=${sanitizeForLog(req.url, 120)}`
      + ` host=${sanitizeForLog(req.headers['host'] as string | undefined)}`
      + ` originHostname=${originHostnameForLog(req.headers['origin'] as string | undefined)}`
      + ` secFetchSite=${sanitizeForLog(req.headers['sec-fetch-site'] as string | undefined)}`
      + ` hasBearer=${typeof authz === 'string' && authz.startsWith('Bearer ')}`,
    );
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
  if (req.url && !req.url.startsWith('/api/') && req.url !== '/ping') { serveStatic(req.url, res); return; }
  res.writeHead(404); res.end('not found');
});

attachWsServer(httpServer, db, TOKEN);
attachTaskScheduler(db); // 采集任务调度器（pending → 扩展派发 → 回执落 status）
attachJobsWorker(db); // jobs 串行执行器（asr-backfill / collect-find；启动恢复把在途任务置 cancelled）
attachBackupTimer(db, DB_PATH); // 容器内定时备份（VACUUM INTO 一致性快照，2026-08-24 损库事故产物）

httpServer.listen(PORT, HOST, () => {
  if (HOST === '0.0.0.0') {
    console.log(`[collector-server] listening on all interfaces (0.0.0.0):${PORT} — 用本机 IP 访问 (ws: /ext, api: /api/*)${ALLOWED_HOSTS.length ? ` — 放行 host: ${ALLOWED_HOSTS.join(', ')}` : ''}`);
  } else {
    console.log(`[collector-server] listening on http://${HOST}:${PORT} (ws: /ext, api: /api/*)${ALLOWED_HOSTS.length ? ` — 放行 host: ${ALLOWED_HOSTS.join(', ')}` : ''}`);
  }
});
