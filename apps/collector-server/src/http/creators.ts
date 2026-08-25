// HTTP handler：UP 主（creators）列表/详情/打分类。
// 路由：GET /api/creators（列表+筛选）、GET /api/creators/:id（详情）、POST /api/creators/by-uid/:source/:uid/category（打分类）。
// 打分类路径带平台段：uid 两平台命名空间独立（B 站 mid / YouTube channelId），不带平台会写错行。
// 沿用 http/queries.ts 范式（本地 json + readJsonBody + 正则路由）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listCreators, getCreator, setCreatorCategory, CREATOR_SORT_KEYS, type CreatorSortKey } from '../db/queries.js';
import { json, readJsonBody, parseSortParams } from './http-util.js';

// scope query 解析（列表端点）：合法值原样、空串/缺省归 undefined、非空非法 → 错误（400 口径）
function parseScopeParam(raw: string | undefined): { scope?: 'agent' | 'human' } | { error: string } {
  if (!raw) return {};
  if (raw === 'agent' || raw === 'human') return { scope: raw };
  return { error: 'scope must be agent|human' };
}

export async function handleCreatorsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const qp = (k: string): string | undefined => url.searchParams.get(k) ?? undefined;

  if (pathname === '/api/creators' && req.method === 'GET') {
    const q = qp('q');
    const category = qp('category');
    const source = qp('source'); // 平台过滤（bilibili|youtube）
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') ?? 20)));
    // sort/scope 非法 → 400（2026-08-25 起取代旧「非法静默回落」，scope 随分类值域合一收紧）；
    // desc 缺省 true（旧恒 DESC 行为不变）。scope 语义：category 的匹配槽位（省略=两列任一），
    // 单独使用=筛该槽位已打标的 UP。
    const sp = parseSortParams(url.searchParams, CREATOR_SORT_KEYS, 'first_seen');
    if ('error' in sp) { json(res, 400, { ok: false, error: sp.error }); return; }
    const sc = parseScopeParam(qp('scope'));
    if ('error' in sc) { json(res, 400, { ok: false, error: sc.error }); return; }
    const r = listCreators(db, { q, category, source, scope: sc.scope }, page, size, sp.sort as CreatorSortKey, sp.desc);
    json(res, 200, { ok: true, ...r });
    return;
  }
  const detail = pathname.match(/^\/api\/creators\/(\d+)$/);
  if (detail && req.method === 'GET') {
    const c = getCreator(db, Number(detail[1]));
    if (!c) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, creator: c });
    return;
  }
  // 平台枚举进正则：非 bilibili|youtube 直接 404（与 collect_tasks CHECK 同口径）
  const cat = pathname.match(/^\/api\/creators\/by-uid\/(bilibili|youtube)\/([^/]+)\/category$/);
  if (cat && req.method === 'POST') {
    const source = cat[1];
    const source_uid = decodeURIComponent(cat[2]);
    const b = await readJsonBody(req) as { scope?: string; name?: string };
    if ((b.scope !== 'agent' && b.scope !== 'human') || !b.name) { json(res, 400, { ok: false, error: 'scope(agent|human) and name required' }); return; }
    const c = setCreatorCategory(db, source, source_uid, b.scope, b.name);
    json(res, 200, { ok: true, creator: c });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}
