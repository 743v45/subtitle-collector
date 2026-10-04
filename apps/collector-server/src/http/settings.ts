// HTTP handler：server 侧设置（settings KV）+ 运行状态（GET /api/status）。
// 路由：GET/PUT /api/settings/tag-priority（标签展示优先级，六档精确排列）
//       GET/PUT /api/settings/collect-timeout（采集超时 {bilibili, youtube, douyin} 毫秒,
//             youtube/douyin=扩展无进展窗口,bilibili=server 等回执预算;范围 [15s, 600s]）
//       GET /api/status（CLI 全功能 web 化 Phase 1：版本/运行时长/配置快照/库路径/在线客户端/各表行数。
//             安全口径：绝不回 token 明文，只有 token_configured 布尔）
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { getTagPriority, setTagPriority, getCollectTimeout, setCollectTimeout } from '../db/settings.js';
import { listOnlineClients } from '../ws/server.js';
import { json, readJsonBody } from './http-util.js';

// server 版本单点事实源：与 package.json version、cli/main.ts VERSION 三方对齐（无运行时互引，
// 各自维护；本常量供 /api/status 直出，web 据此对照部署版本）。
export const SERVER_VERSION = '0.1.0';

// /api/status 运行环境上下文（main.ts 装配传入；测试传固定值）——
// 4 参注入而非读 process.env：handler 可测、口径与 main.ts 单点装配一致。
export interface StatusContext {
  host: string;
  port: number;
  authRequired: boolean;
  tokenConfigured: boolean;
  allowedHosts: string[];
  dbPath: string;
  startedAt: number; // Date.now() 毫秒（uptime 计算基准）
}

export async function handleSettingsHttp(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  status: StatusContext,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/status' && req.method === 'GET') {
    handleStatus(res, db, status);
    return;
  }

  if (pathname === '/api/settings/tag-priority') {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, priority: getTagPriority(db) });
      return;
    }
    if (req.method === 'PUT') {
      const b = await readJsonBody(req) as { priority?: unknown };
      try {
        const priority = setTagPriority(db, b.priority);
        json(res, 200, { ok: true, priority });
      } catch {
        json(res, 400, { ok: false, error: 'priority must be an exact permutation of manual|batch|bili|season|ai|system' });
      }
      return;
    }
  }

  if (pathname === '/api/settings/collect-timeout') {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, ...getCollectTimeout(db) });
      return;
    }
    if (req.method === 'PUT') {
      const b = await readJsonBody(req);
      try {
        const saved = setCollectTimeout(db, b);
        json(res, 200, { ok: true, ...saved });
      } catch (e) {
        json(res, 400, { ok: false, error: String((e as Error).message) });
      }
      return;
    }
  }

  json(res, 404, { ok: false, error: 'not found' });
}

// GET /api/status：运行状态快照（抽出降 handleSettingsHttp 圈复杂度，对齐 translate.ts 先例）。
// counts 五表 COUNT(*)：videos/creators/subtitle_tracks/subtitle_versions/collect_tasks。
function handleStatus(res: ServerResponse, db: Database.Database, status: StatusContext): void {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  json(res, 200, {
    ok: true,
    version: SERVER_VERSION,
    uptime_s: Math.max(0, Math.floor((Date.now() - status.startedAt) / 1000)),
    config: {
      host: status.host,
      port: status.port,
      auth_required: status.authRequired,
      token_configured: status.tokenConfigured, // 布尔 only——token 明文任何情况下不出 HTTP 面
      allowed_hosts: status.allowedHosts,
    },
    db_path: status.dbPath,
    online_clients: listOnlineClients().length,
    counts: {
      videos: count('videos'),
      creators: count('creators'),
      tracks: count('subtitle_tracks'),
      versions: count('subtitle_versions'),
      collect_tasks: count('collect_tasks'),
    },
  });
}
