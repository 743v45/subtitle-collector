// HTTP handler：采集编排三端点（CLI 全功能 web 化 Phase 3）——把 CLI collect 的三个「选扩展下发 action」
// 编排搬到 server 进程内，web 前端免经 CLI：
//   POST /api/collect-search    —— 关键词搜候选（bilibili → action `search`；youtube → `yt-search`，
//                                  对齐 cli/commands/collect.ts collectSearch 与 collect-yt-search.ts collectYtSearch）
//   POST /api/season/preview    —— 合集展开预览（action `list-season-videos`，对齐 collectSeason；
//                                  预览只读，实际采集走既有 POST /api/collect-tasks/batch）
//   POST /api/upper-info/refresh—— UP 主资料刷新（action `get-upper-info`，对齐 collectUpperInfo；
//                                  扩展自己 fetch acc/info+stat 并推 ingest-upper 入库，server 只发这一个 action）
// 安全红线：白名单编排而非通用代理——action 由 server 按 source 硬编码选定，web 只传业务参数，
// 绝不透传任意 action/params（/api/clients/:id/command 的通用通道不对外开放面不变）。
// 复用：与扩展同进程，直接 import ws/server.js 的 requestCommand/listOnlineClients（clients.ts 同款，
// 禁 HTTP 自调用）；exists/has_subtitle 标注复用 queries.ts 的 check-exists SQL（querySubtitleExists）。
// 依赖注入：requestCommand/listOnlineClients 经 createCollectProxyHandler(deps) 注入（对齐 tasks/wsBridge
// 先例），测试在 requestCommand 层 mock，不起真扩展 WS。
// 措辞：字幕（subtitle），非弹幕。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { requestCommand, listOnlineClients } from '../ws/server.js';
import { DEFAULT_COLLECT_TIMEOUT_MS, parseSeasonArg, seasonIdFromDb } from '../cli/commands/collect.js';
import { filterYtBySince, type YtSearchItem } from '../cli/commands/collect-yt-search.js';
import { querySubtitleExists } from './queries.js';
import { HttpError, json, readJsonBody } from './http-util.js';

// 扩展命令通道（默认真实现 = ws/server.js；测试注入 mock）
export interface CollectProxyDeps {
  requestCommand: typeof requestCommand;
  listOnlineClients: () => Array<{ client_id: string }>;
}

// handler 工厂：deps 缺省用真实现（main.ts 用法）；测试传 mock 得独立 handler（无模块级可变状态）
export function createCollectProxyHandler(deps: CollectProxyDeps = { requestCommand, listOnlineClients: () => listOnlineClients() }) {
  return async function handleCollectProxyHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/collect-search' && req.method === 'POST') {
      await handleCollectSearch(res, db, deps, await readJsonBody(req));
      return;
    }
    if (url.pathname === '/api/season/preview' && req.method === 'POST') {
      await handleSeasonPreview(res, db, deps, await readJsonBody(req));
      return;
    }
    if (url.pathname === '/api/upper-info/refresh' && req.method === 'POST') {
      await handleUpperInfoRefresh(res, deps, await readJsonBody(req));
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  };
}

// main.ts 注册用缺省 handler（真 ws 通道）
export const handleCollectProxyHttp = createCollectProxyHandler();

// ── 共用件：在线客户端选取 / 扩展下发与错误映射 / 回执守卫 / exists 标注 ──

// 取第一个在线客户端（对齐 CLI resolveClientId 缺省语义）；无在线 → null（调用方 503）
function pickOnlineClient(deps: CollectProxyDeps): string | null {
  const online = deps.listOnlineClients();
  if (online.length === 0) return null;
  return online[0].client_id;
}

const NO_ONLINE_ERROR = 'no online client（扩展未连接）';

// 下发扩展命令并按 clients.ts 先例映射传输层错误：
//   offline → 503（刚从在线池选出又掉线 = 当前无可用扩展）/ timeout → 504 / 回执 ok!==true → 502 透传
//   extError（need_login / risk_control 原样过，上层语义由调用方解读）；unknown action → 502 + 版本过旧提示
//   （对齐 CLI EXT_UPDATE 语义：collect.ts「扩展版本过旧（不认识 …）,请更新扩展后重试」）。
// 成功回 data（WS result 消息的 data 字段）；全程带 label/client/action/耗时日志（可观察性纪律）。
async function sendExtOrThrow(deps: CollectProxyDeps, clientId: string, action: string, params: Record<string, unknown>, label: string): Promise<any> {
  const startedAt = Date.now();
  const r = await deps.requestCommand(clientId, action, params, DEFAULT_COLLECT_TIMEOUT_MS);
  const elapsed = Date.now() - startedAt;
  if (!r.ok) {
    if (r.code === 'offline') {
      console.warn(`[http:collect-proxy] ${label}: 客户端选在线后掉线 client_id=${clientId} action=${action} elapsed=${elapsed}ms`);
      throw new HttpError(503, `client offline during command: ${clientId}`);
    }
    console.warn(`[http:collect-proxy] ${label}: 扩展回执超时 client_id=${clientId} action=${action} timeout=${DEFAULT_COLLECT_TIMEOUT_MS}ms elapsed=${elapsed}ms`);
    throw new HttpError(504, 'extension result timeout');
  }
  if (r.result?.ok !== true) {
    const extError = String(r.result?.error ?? 'extension command failed');
    console.warn(`[http:collect-proxy] ${label}: 扩展执行失败 client_id=${clientId} action=${action} extError=${extError} elapsed=${elapsed}ms`);
    if (extError.includes('unknown action')) {
      throw new HttpError(502, `扩展版本过旧（不认识 ${action}）,请更新扩展后重试: ${extError}`);
    }
    throw new HttpError(502, extError);
  }
  console.log(`[http:collect-proxy] ${label}: 扩展回执 ok client_id=${clientId} action=${action} elapsed=${elapsed}ms`);
  return r.result.data;
}

// 回执 items 数组守卫：items 非数组 → 502（结构漂移当场报，带 data 顶层键日志不盲猜）。
// 回执经 WS 进来本就无类型（对齐 clients.ts 的 any 口径），条目形状由各 CLI 契约注释说明
// （bilibili search: bvid/title/up/mid/play/duration/pubdate；yt-search: vid/title/created/play/length/pic；
//   list-season-videos: bvid/title/created/play/length/pic）。
function itemsOf(data: unknown, label: string, clientId: string, action: string): any[] {
  if (data == null || typeof data !== 'object' || !Array.isArray((data as { items?: unknown }).items)) {
    const keys = data != null && typeof data === 'object' ? Object.keys(data).join(',') : String(data);
    console.warn(`[http:collect-proxy] ${label}: 回执结构异常（items 非数组）client_id=${clientId} action=${action} dataKeys=${keys}`);
    throw new HttpError(502, 'extension receipt malformed: items is not an array');
  }
  return (data as { items: any[] }).items;
}

// 条目 vid 键提取（bilibili 回执=bvid；youtube yt-search 回执=vid），非字符串/缺键过滤
function vidsOf(items: any[], key: string): string[] {
  return items.map((it) => (typeof it?.[key] === 'string' ? it[key] as string : '')).filter(Boolean);
}

// exists/has_subtitle 标注：查库命中 → exists=true + has_subtitle 实况；未入库 → exists=false/has_subtitle=false
function annotateItems(items: any[], byVid: Map<string, boolean>, key: string): any[] {
  return items.map((it) => {
    const vid = typeof it?.[key] === 'string' ? it[key] as string : '';
    const has = byVid.get(vid);
    return { ...it, exists: has !== undefined, has_subtitle: has === true };
  });
}

// ── POST /api/collect-search ──
// body {source:'bilibili'|'youtube', keyword(必填≤100), order?, pages?(1..5), since_days?(1..365), tid?}
// 参数归属硬约束（错源给旋钮 → 400，不做静默忽略——「以为筛了其实没筛」是暗坑）：
//   bilibili → order（缺省 pubdate，CLI 不校验枚举，透传）+ tid；youtube → order（relevance|newest|views，
//   对齐 CLI validateYtSearchArgs）+ pages + since_days（server 侧 filterYtBySince 本地过滤，created=null 保留）。
const MAX_SEARCH_KEYWORD_LEN = 100;
const YT_ORDERS = ['relevance', 'newest', 'views'] as const;

// 数值旋钮表驱动校验（抽出降 parseCollectSearchBody 圈复杂度）：名字 → {归属平台, 范围}。
// 错源给旋钮 → 400（不做静默忽略——「以为筛了其实没筛」是暗坑）；越界 → 400 带合法区间。
const SEARCH_KNOBS: Record<string, { source: 'bilibili' | 'youtube'; min: number; max: number }> = {
  pages: { source: 'youtube', min: 1, max: 5 },
  since_days: { source: 'youtube', min: 1, max: 365 },
  tid: { source: 'bilibili', min: 1, max: Number.MAX_SAFE_INTEGER },
};

function parseSearchKnobs(body: Record<string, unknown>): { ok: true; knobs: Record<string, number | undefined> } | { ok: false; error: string } {
  const knobs: Record<string, number | undefined> = {};
  for (const [name, spec] of Object.entries(SEARCH_KNOBS)) {
    const v = intOpt(body[name], name);
    if (v.error) return { ok: false, error: v.error };
    if (v.value != null && (v.value < spec.min || v.value > spec.max)) {
      return { ok: false, error: `${name} must be ${spec.min}..${spec.max}` };
    }
    if (v.value != null && body.source !== spec.source) {
      return { ok: false, error: `${name} only applies to source=${spec.source}` };
    }
    knobs[name] = v.value;
  }
  return { ok: true, knobs };
}

type CollectSearchParsed =
  | { ok: true; source: 'bilibili' | 'youtube'; keyword: string; order?: string; pages?: number; sinceDays?: number; tid?: number }
  | { ok: false; error: string };

function parseCollectSearchBody(b: unknown): CollectSearchParsed {
  const body = (b ?? {}) as Record<string, unknown>;
  if (body.source !== 'bilibili' && body.source !== 'youtube') return { ok: false, error: "source must be 'bilibili'|'youtube'" };
  const keyword = body.keyword;
  if (typeof keyword !== 'string' || !keyword) return { ok: false, error: 'keyword: non-empty string required' };
  if (keyword.length > MAX_SEARCH_KEYWORD_LEN) {
    console.warn(`[http:collect-proxy] collect-search: keyword 超长被拒 len=${keyword.length} max=${MAX_SEARCH_KEYWORD_LEN}`);
    return { ok: false, error: `keyword too long: ${keyword.length} > ${MAX_SEARCH_KEYWORD_LEN}` };
  }
  // 数值旋钮（pages/since_days/tid）：给了就必须是正整数 + 落在表内区间 + 归属平台正确
  const knobs = parseSearchKnobs(body);
  if (!knobs.ok) return { ok: false, error: knobs.error };
  const order = body.order;
  if (order !== undefined && typeof order !== 'string') return { ok: false, error: 'order must be a string' };
  if (body.source === 'youtube' && typeof order === 'string' && !(YT_ORDERS as readonly string[]).includes(order)) {
    return { ok: false, error: `order must be one of ${YT_ORDERS.join('|')}（youtube）` };
  }
  return {
    ok: true,
    source: body.source,
    keyword,
    order,
    pages: knobs.knobs.pages,
    sinceDays: knobs.knobs.since_days,
    tid: knobs.knobs.tid,
  };
}

// 可选正整数参数（缺省 undefined；给了非整数/非正数 → error，调用方 400）
function intOpt(v: unknown, name: string): { value?: number; error?: string } {
  if (v === undefined || v === null) return { value: undefined };
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return { error: `${name} must be a positive integer: ${String(v)}` };
  return { value: v };
}

async function handleCollectSearch(res: ServerResponse, db: Database.Database, deps: CollectProxyDeps, body: unknown): Promise<void> {
  const parsed = parseCollectSearchBody(body);
  if (!parsed.ok) { json(res, 400, { ok: false, error: parsed.error }); return; }
  const clientId = pickOnlineClient(deps);
  if (clientId === null) {
    console.warn(`[http:collect-proxy] collect-search: 无在线扩展 source=${parsed.source} keyword=${JSON.stringify(parsed.keyword)}`);
    json(res, 503, { ok: false, error: NO_ONLINE_ERROR });
    return;
  }

  if (parsed.source === 'bilibili') {
    // 参数对齐 cli collectSearch（collect.ts）：{keyword, page, order, tid?}；web 形态固定第 1 页
    const params: Record<string, unknown> = { keyword: parsed.keyword, page: 1, order: parsed.order ?? 'pubdate' };
    if (parsed.tid != null) params.tid = parsed.tid;
    const data = await sendExtOrThrow(deps, clientId, 'search', params, 'collect-search');
    const items = itemsOf(data, 'collect-search', clientId, 'search');
    const byVid = querySubtitleExists(db, 'bilibili', vidsOf(items, 'bvid'));
    const annotated = annotateItems(items, byVid, 'bvid');
    const inDb = annotated.filter((it) => it.exists).length;
    console.log(`[http:collect-proxy] collect-search: done source=bilibili keyword=${JSON.stringify(parsed.keyword)} total=${annotated.length} in_db=${inDb}`);
    json(res, 200, { ok: true, source: 'bilibili', keyword: parsed.keyword, client_id: clientId, total: annotated.length, items: annotated });
    return;
  }

  // youtube：参数对齐 cli collectYtSearch（collect-yt-search.ts）：{keyword, order, pages}；
  // since_days 是 CLI 侧本地过滤（filterYtBySince，created=null 保留），扩展不认识该参数
  const params: Record<string, unknown> = { keyword: parsed.keyword, order: parsed.order ?? 'relevance', pages: parsed.pages ?? 1 };
  const data = await sendExtOrThrow(deps, clientId, 'yt-search', params, 'collect-search');
  const rawItems = itemsOf(data, 'collect-search', clientId, 'yt-search');
  let items: any[] = rawItems;
  let sinceFiltered = 0;
  if (parsed.sinceDays != null) {
    const sinceUnix = Math.floor(Date.now() / 1000) - parsed.sinceDays * 86400;
    items = filterYtBySince(rawItems as YtSearchItem[], sinceUnix);
    sinceFiltered = rawItems.length - items.length;
  }
  const byVid = querySubtitleExists(db, 'youtube', vidsOf(items, 'vid'));
  const annotated = annotateItems(items, byVid, 'vid');
  const inDb = annotated.filter((it) => it.exists).length;
  // raw_total/pages_fetched/diag 透传（对齐 CLI summary：解析命中计数，0 命中/结构漂移时先看它）
  const receipt = (data ?? {}) as { raw_total?: unknown; pages_fetched?: unknown; diag?: unknown };
  console.log(`[http:collect-proxy] collect-search: done source=youtube keyword=${JSON.stringify(parsed.keyword)} total=${annotated.length} since_filtered=${sinceFiltered} in_db=${inDb} pages_fetched=${String(receipt.pages_fetched ?? '?')}`);
  json(res, 200, {
    ok: true,
    source: 'youtube',
    keyword: parsed.keyword,
    client_id: clientId,
    raw_total: receipt.raw_total ?? null,
    pages_fetched: receipt.pages_fetched ?? null,
    since_days: parsed.sinceDays ?? null,
    since_filtered: sinceFiltered,
    total: annotated.length,
    items: annotated,
    diag: receipt.diag ?? null,
  });
}

// ── POST /api/season/preview ──
// body {arg: 必填}——三形态对齐 cli parseSeasonArg：BV 号（须已采过，库内 extra.ugc_season.id 取合集 id）/
// 纯数字合集 id / 合集页链接（?sid=N 或 ?season_id=N）。只读预览，实际采集走 POST /api/collect-tasks/batch。
async function handleSeasonPreview(res: ServerResponse, db: Database.Database, deps: CollectProxyDeps, body: unknown): Promise<void> {
  const arg = (body as Record<string, unknown> | null)?.arg;
  if (typeof arg !== 'string' || !arg.trim()) { json(res, 400, { ok: false, error: 'arg: non-empty string required（BV 号 / 合集 id / 合集页链接）' }); return; }
  const parsed = parseSeasonArg(arg);
  let seasonId = parsed.seasonId;
  if (parsed.bvid) {
    seasonId = seasonIdFromDb(db, parsed.bvid);
    if (seasonId == null) {
      console.warn(`[http:collect-proxy] season/preview: BV 库内无合集归属 bvid=${parsed.bvid}`);
      json(res, 404, { ok: false, error: `BV 未采集过,库内无合集归属——先采集 ${parsed.bvid} 单个视频，或直接传合集 id / 合集页链接` });
      return;
    }
  }
  if (seasonId == null) {
    json(res, 400, { ok: false, error: `无法识别合集参数: ${arg}（支持 BV 号 / 合集 id / 合集页链接）` });
    return;
  }
  const clientId = pickOnlineClient(deps);
  if (clientId === null) {
    console.warn(`[http:collect-proxy] season/preview: 无在线扩展 season_id=${seasonId}`);
    json(res, 503, { ok: false, error: NO_ONLINE_ERROR });
    return;
  }
  const data = await sendExtOrThrow(deps, clientId, 'list-season-videos', { season_id: seasonId }, 'season/preview');
  const items = itemsOf(data, 'season/preview', clientId, 'list-season-videos');
  if (items.length === 0) {
    // 对齐 CLI collectSeason：空展开 = 合集不存在或扩展拉取失败，按失败报不空手 200
    console.warn(`[http:collect-proxy] season/preview: 合集展开为空 season_id=${seasonId} client_id=${clientId}`);
    json(res, 502, { ok: false, error: `合集 ${seasonId} 展开结果为空（合集不存在或扩展拉取失败）` });
    return;
  }
  const byVid = querySubtitleExists(db, 'bilibili', vidsOf(items, 'bvid'));
  const annotated = annotateItems(items, byVid, 'bvid');
  const inDb = annotated.filter((it) => it.exists).length;
  const mid = typeof (data as Record<string, unknown>)?.mid === 'number' ? (data as { mid: number }).mid : null;
  console.log(`[http:collect-proxy] season/preview: done season_id=${seasonId} total=${annotated.length} in_db=${inDb} mid=${String(mid)}`);
  json(res, 200, { ok: true, season: { id: seasonId, mid }, client_id: clientId, total: annotated.length, items: annotated });
}

// ── POST /api/upper-info/refresh ──
// body {mid: 必填，B 站数字 UID}——只发一个 action `get-upper-info`：扩展自己 fetch acc/info+relation/stat
// 并推 ingest-upper 入库（background.js:762 / ws/server.ts ingestUpper），server 无第二步、无直写。
async function handleUpperInfoRefresh(res: ServerResponse, deps: CollectProxyDeps, body: unknown): Promise<void> {
  const mid = (body as Record<string, unknown> | null)?.mid;
  if (typeof mid !== 'string' || !/^\d+$/.test(mid)) {
    json(res, 400, { ok: false, error: 'mid: 纯数字 UID 字符串 required（B 站 UID）' });
    return;
  }
  const clientId = pickOnlineClient(deps);
  if (clientId === null) {
    console.warn(`[http:collect-proxy] upper-info/refresh: 无在线扩展 mid=${mid}`);
    json(res, 503, { ok: false, error: NO_ONLINE_ERROR });
    return;
  }
  const data = await sendExtOrThrow(deps, clientId, 'get-upper-info', { mid }, 'upper-info/refresh');
  if (data == null || typeof data !== 'object') {
    console.warn(`[http:collect-proxy] upper-info/refresh: 回执结构异常（data 非对象）client_id=${clientId} data=${String(data)}`);
    json(res, 502, { ok: false, error: 'extension receipt malformed: data is not an object' });
    return;
  }
  console.log(`[http:collect-proxy] upper-info/refresh: done mid=${mid} name=${String((data as Record<string, unknown>).name ?? '?')}`);
  json(res, 200, { ok: true, client_id: clientId, creator: data });
}
