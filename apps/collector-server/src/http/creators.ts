// HTTP handler：UP 主（creators）列表/详情/打分类/批量打分类/资料刷新。
// 路由：GET /api/creators（列表+筛选）、GET /api/creators/:id（详情）、
//   POST /api/creators/by-uid/:source/:uid/category（打分类）、
//   POST /api/creators/batch-category（多选批量打分类，2026-10-05 web 契约；body {ids,
//   agent_category_id?, human_category_id?}，槽位三态：键省略=保持原值 / null=清空该槽位 /
//   数字=写该分类 id）、
//   POST /api/creators/:id/refresh（拉 B 站 card 回写资料，2026-10-05 web 契约；仅 bilibili）。
// 打分类路径带平台段：uid 两平台命名空间独立（B 站 mid / YouTube channelId），不带平台会写错行。
// 沿用 http/queries.ts 范式（本地 json + readJsonBody + 正则路由）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listCreators, getCreator, setCreatorCategory, setCreatorsBatchCategory, CREATOR_SORT_KEYS, type CreatorSortKey } from '../db/queries.js';
import type { FetchLike } from '../tasks/tasks.js';
import { json, readJsonBody, parseSortParams } from './http-util.js';

// scope query 解析（列表端点）：合法值原样、空串/缺省归 undefined、非空非法 → 错误（400 口径）
function parseScopeParam(raw: string | undefined): { scope?: 'agent' | 'human' } | { error: string } {
  if (!raw) return {};
  if (raw === 'agent' || raw === 'human') return { scope: raw };
  return { error: 'scope must be agent|human' };
}

// ── POST /api/creators/batch-category ──

/** 分类 id 槽位解析（三态，对齐 web「— 不变 —/— 清除 —/具体分类」下拉）：
 *  undefined（请求体省略该键）→ {value: undefined}（保持原值，不进 SET 子句）；
 *  null → {value: null}（清空该槽位）；数字须为整数且存在于 categories（web 下拉只出存量分类，
 *  幽灵 id 一律 400 防静默写空）→ {value: id}。区分「键缺席」与「显式 null」是 keep 语义的根基：
 *  混同会让用户只改一个槽位时另一槽位被静默清空（2026-10-05 对抗审查 blocker 修复）。 */
function parseCategorySlot(db: Database.Database, label: string, raw: unknown): { value: number | null | undefined } | { error: string } {
  if (raw === undefined) return { value: undefined };
  if (raw === null) return { value: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { error: `${label} must be null or an integer category id` };
  if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(raw)) {
    return { error: `${label}=${raw} not found in categories` };
  }
  return { value: raw };
}

// ── POST /api/creators/:id/refresh ──

// B 站用户信息卡接口（无需登录态；扩展侧采集走的是 acc/info，card 自带 follower 故选它）。
const BILI_CARD_URL = 'https://api.bilibili.com/x/web-interface/card?mid=';

/** 字符串字段宽容收录（抽出降 mapCardFields 圈复杂度；name/face/sign/sex 四字段共用）：
 * 非空串才写（face 落 avatar 列，其余同名）。 */
function putStr(src: Record<string, unknown>, key: string, outKey: string, out: Record<string, string | number>): void {
  const v = src[key];
  if (typeof v === 'string' && v !== '') out[outKey] = v;
}

/** card 响应 official_verify → official_type/official_title（-1=未认证也照写；desc 缺失跳过该字段）。
 *  抽出降 mapCardFields 圈复杂度。 */
function mapOfficialVerify(ov: unknown, out: Record<string, string | number>): void {
  if (ov == null || typeof ov !== 'object') return;
  const v = ov as { type?: unknown; desc?: unknown };
  if (typeof v.type === 'number' && Number.isFinite(v.type)) out.official_type = v.type;
  if (typeof v.desc === 'string') out.official_title = v.desc;
}

/** fans 取值（抽出降 mapCardFields 圈复杂度）：data.follower 优先，回落 card.fans；
 *  两处都非有限数 → null（调用方跳过该字段不写）。 */
function pickFans(data: { follower?: unknown }, card: { fans?: unknown }): number | null {
  if (typeof data.follower === 'number' && Number.isFinite(data.follower)) return data.follower;
  if (typeof card.fans === 'number' && Number.isFinite(card.fans)) return card.fans;
  return null;
}

/** card 响应 → 可回写字段映射（宽容口径：字段缺失/形态不对（含空串）就跳过该字段——刷新是
 * 展示层同步，绝不产出 null 去清空既有资料；fans 取 data.follower ?? card.fans；
 * following ← card.attention；official_type ← card.official_verify.type 原样（-1=未认证也照写）。 */
function mapCardFields(payload: unknown): Record<string, string | number> {
  const data = (payload as any)?.data ?? {};
  const card = data.card ?? {};
  const out: Record<string, string | number> = {};
  putStr(card, 'name', 'name', out);
  putStr(card, 'face', 'avatar', out);
  putStr(card, 'sign', 'sign', out);
  const level = card.level_info?.current_level;
  if (typeof level === 'number' && Number.isFinite(level)) out.level = level;
  putStr(card, 'sex', 'sex', out);
  mapOfficialVerify(card.official_verify, out);
  const fans = pickFans(data, card);
  if (fans !== null) out.fans = fans;
  if (typeof card.attention === 'number' && Number.isFinite(card.attention)) out.following = card.attention;
  return out;
}

/** code!=0 / card 缺失 → 抛错（message 即下发前端的原始口径，抽出降 fetchBiliCard 圈复杂度）；
 *  stderr 观察日志带 code/message。 */
function assertCardOk(payload: unknown, mid: string): void {
  const code = (payload as any)?.code;
  if (code !== 0 || (payload as any)?.data?.card == null) {
    const msg = (payload as any)?.message ?? 'card missing in response';
    console.error(`[http] creators refresh bili error mid=${mid} code=${code} message=${msg}`);
    throw new Error(`bilibili card error ${String(code)}: ${msg}`);
  }
}

/** card 拉取 + 解析（抽出降 handleRefreshCreator 圈复杂度）。错误口径与抽出前逐字一致：
 *  网络/JSON 解析异常 → `fetch bilibili card failed: <原始 message>`；非 200 → `bilibili card http N`；
 *  code!=0 / card 缺失 → `bilibili card error <code>: <message>`（assertCardOk）。失败都带 stderr
 *  观察日志（mid/状态/响应特征）。 */
async function fetchBiliCard(fetcher: FetchLike, mid: string): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetcher(`${BILI_CARD_URL}${encodeURIComponent(mid)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; subtitle-collector)' },
    });
  } catch (e) {
    console.error(`[http] creators refresh card fetch failed mid=${mid}: ${(e as Error)?.message}`);
    throw new Error(`fetch bilibili card failed: ${(e as Error)?.message ?? e}`);
  }
  console.error(`[http] creators refresh card status=${resp.status} mid=${mid}`);
  if (!resp.ok) {
    console.error(`[http] creators refresh card non-200 status=${resp.status} mid=${mid}`);
    throw new Error(`bilibili card http ${resp.status}`);
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (e) {
    console.error(`[http] creators refresh card json parse failed mid=${mid}: ${(e as Error)?.message}`);
    throw new Error(`fetch bilibili card failed: ${(e as Error)?.message ?? e}`);
  }
  assertCardOk(payload, mid);
  return payload;
}

/** card 映射字段回写（抽出降 handleRefreshCreator 圈复杂度）：全字段缺失（风控降级响应但
 * code=0）时只 bump updated_at 不产空 UPDATE，保留原值（stderr 观察日志可辨）。 */
function applyCardFields(db: Database.Database, id: number, mid: string, fields: Record<string, string | number>): void {
  const cols = Object.keys(fields);
  const now = Date.now();
  if (cols.length > 0) {
    db.prepare(`UPDATE creators SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(fields), now, id);
  } else {
    console.error(`[http] creators refresh card mapped 0 fields mid=${mid}（保留原值只刷 updated_at）`);
    db.prepare('UPDATE creators SET updated_at = ? WHERE id = ?').run(now, id);
  }
}

/** refresh 主体（对齐 handleListTasksHttp 先例抽子函数降圈复杂度）。
 * 失败口径：库内无此 UP → 404；非 bilibili → 400（refresh 语义只有 B 站有）；fetch 网络异常 /
 * 非 200 / code!=0 / card 缺失 → 502 + 原始 message（fetchBiliCard 抛出）；成功：宽容映射回写
 * （缺字段不清空）+ updated_at，返回刷新后的完整详情行。 */
async function handleRefreshCreator(res: ServerResponse, db: Database.Database, fetcher: FetchLike, id: number): Promise<void> {
  const existing = getCreator(db, id);
  if (!existing) { json(res, 404, { ok: false, error: 'not found' }); return; }
  if (existing.source !== 'bilibili') {
    json(res, 400, { ok: false, error: `refresh only supported for bilibili creators (got source=${existing.source})` });
    return;
  }
  try {
    const payload = await fetchBiliCard(fetcher, existing.source_uid);
    applyCardFields(db, id, existing.source_uid, mapCardFields(payload));
  } catch (e) {
    json(res, 502, { ok: false, error: (e as Error)?.message ?? String(e) });
    return;
  }
  json(res, 200, { ok: true, creator: getCreator(db, id) });
}

// GET /api/creators 列表（抽出降 handleCreatorsHttp 圈复杂度）：sort/scope 非法 → 400，其余查询参数透传。
function handleListCreators(res: ServerResponse, db: Database.Database, url: URL): void {
  const qp = (k: string): string | undefined => url.searchParams.get(k) ?? undefined;
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
}

// POST /api/creators/batch-category（抽出降 handleCreatorsHttp 圈复杂度）：ids 非空整数数组 +
// 两槽位三态（省略=保持原值 / null=清空 / id=写值）校验，任一非法 400；合法即单事务批量回写。
async function handleBatchCategory(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const b = await readJsonBody(req) as { ids?: unknown; agent_category_id?: unknown; human_category_id?: unknown };
  const ids = Array.isArray(b.ids) ? b.ids : [];
  if (ids.length === 0 || !ids.every((n) => typeof n === 'number' && Number.isInteger(n))) {
    json(res, 400, { ok: false, error: 'ids: non-empty integer[] required' });
    return;
  }
  const agent = parseCategorySlot(db, 'agent_category_id', b.agent_category_id);
  if ('error' in agent) { json(res, 400, { ok: false, error: agent.error }); return; }
  const human = parseCategorySlot(db, 'human_category_id', b.human_category_id);
  if ('error' in human) { json(res, 400, { ok: false, error: human.error }); return; }
  // 两槽位都省略 = 什么都不改（web 批量条已禁点此形态，直达 API 才会出现）：不落库不动
  // updated_at，200/updated=0 带日志（边界观察：谁在发无槽位批量请求）
  if (agent.value === undefined && human.value === undefined) {
    console.error(`[http] creators batch-category 两槽位都省略（keep）无槽可写，跳过落库 ids=${ids.length} 个`);
    json(res, 200, { ok: true, updated: 0 });
    return;
  }
  const updated = setCreatorsBatchCategory(db, ids as number[], agent.value, human.value);
  json(res, 200, { ok: true, updated });
}

// POST /api/creators/by-uid/:source/:uid/category 主体（抽出降 handleCreatorsHttp 圈复杂度）：
// scope/name 校验（非法 400），合法即打标。
async function handleSetCategoryByUid(req: IncomingMessage, res: ServerResponse, db: Database.Database, source: string, source_uid: string): Promise<void> {
  const b = await readJsonBody(req) as { scope?: string; name?: string };
  if ((b.scope !== 'agent' && b.scope !== 'human') || !b.name) { json(res, 400, { ok: false, error: 'scope(agent|human) and name required' }); return; }
  const c = setCreatorCategory(db, source, source_uid, b.scope, b.name);
  json(res, 200, { ok: true, creator: c });
}

export async function handleCreatorsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database, fetcher: FetchLike = globalThis.fetch): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/creators' && req.method === 'GET') {
    handleListCreators(res, db, url);
    return;
  }
  const detail = pathname.match(/^\/api\/creators\/(\d+)$/);
  if (detail && req.method === 'GET') {
    const c = getCreator(db, Number(detail[1]));
    if (!c) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, creator: c });
    return;
  }
  // 批量打分类（数字 id 路由之前匹配，防被 /:id 语义误吃——正则不匹配带路径段的，顺序只是可读性）
  if (pathname === '/api/creators/batch-category' && req.method === 'POST') {
    await handleBatchCategory(req, res, db);
    return;
  }
  // 平台枚举进正则：非 bilibili|youtube 直接 404（与 collect_tasks CHECK 同口径）
  const cat = pathname.match(/^\/api\/creators\/by-uid\/(bilibili|youtube)\/([^/]+)\/category$/);
  if (cat && req.method === 'POST') {
    await handleSetCategoryByUid(req, res, db, cat[1], decodeURIComponent(cat[2]));
    return;
  }
  const refresh = pathname.match(/^\/api\/creators\/(\d+)\/refresh$/);
  if (refresh && req.method === 'POST') {
    await handleRefreshCreator(res, db, fetcher, Number(refresh[1]));
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}
