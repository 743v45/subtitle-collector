// HTTP handler：B 站评论采集通路（C2，规格唯一来源 docs/plans/comments/PLAN.md §4.1/§5.2）。
// 五端点（读 GET / 写 POST 惯例）：
//   POST /api/comments/ingest —— §2.3 映射前的原始条目子集 → 服务端 parseReplyRow 解析归一
//                                 → upsertComments（单事务幂等）→ full_scan:true 时 missing 对账
//                                 + 置顶先清后打；
//   GET  /api/comments/count?bvid=   —— 行数/根数/水位（§4.3 步 0 模式判定与增量水位依赖）；
//   GET  /api/comments/verify?bvid=  —— 纯库内校验（§5.2 入口 2，无副作用）；
//   GET  /api/comments/tree?bvid=    —— 根+楼中楼两层级树（web 评论页签展示，2026-10-05；
//                                 复用 treeByVideo CLI 口径，置顶稳定前置；节点白名单子集）。
//   GET  /api/comments/list?bvid=&limit= —— 轻量拍平列表（popup 评论卡展示，2026-10-08 用户现场指令，
//                                 对齐弹幕卡 GET /api/danmaku/list 先例）：白名单字段 + 根 like 降序、
//                                 楼组内 ctime 升序摊平成一行序，limit 默认 200 只截根数（防巨量视频撑爆）。
// 消费方是 CLI `comments collect`（宿主直连 B 站采、经本端点写生产库——「CLI 永不写库」纪律，D4）。
// Bearer 鉴权由 main.ts 对 /api/* 统一执行（httpAuthOk），本 handler 不重复。
// oid 仅链路观察用（对照传输体量），服务端定位只认 bvid（评论恒挂 videos.id，先采视频再谈评论）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { parseReplyRow, type PinKind } from '../cli/bili-comments.js';
import {
  clearAndSetPins,
  commentsCount,
  commentsLightTree,
  reconcileMissing,
  treeByVideo,
  upsertComments,
  type CommentLightRow,
  type CommentPin,
  type CommentRecord,
  type CommentUpsertRow,
} from '../db/comments.js';
import { verifyTree } from '../db/comments-verify.js';
import { getVideo } from '../db/queries.js';
import { json, readJsonBody } from './http-util.js';

const PIN_KINDS: readonly PinKind[] = ['admin', 'upper', 'vote'];

// ── 标量归一小工具（守圈复杂度 ≤15）──

/** 有限数字直读（否则 null）。 */
function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 非空字符串直读（否则 null）。 */
function nonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** §2.3 upper_mid 归一：number|string 均可（String() 直读防御在 is_up 计算侧）；其余形态 → null（不可判定）。 */
function upperMidOf(v: unknown): string | number | null {
  return nonEmptyStr(v) ?? finiteNum(v);
}

// ── ingest body 校验 + 服务端解析归一 ──

export interface IngestParsed {
  bvid: string;
  upperMid: string | number | null;
  fetchedAt: number;
  batchId: string | null;
  sort: string | null;
  page: number | null;
  fullScan: boolean;
  scanStart: number | null;
  pins: CommentPin[] | null;
  rows: CommentUpsertRow[];
}

/** 原始条目 → 归一行（parseReplyRow）；条目非对象或五 ID 皆缺（rpid 不可定位）→ 丢弃计数。
 * 丢弃不 400：单批大条目量下个别脏条目不值得整批失败，stderr 留痕可观察（调用方汇总）。 */
function normalizeReplies(raw: unknown[], upperMid: string | number | null): { rows: CommentUpsertRow[]; dropped: number } {
  const rows: CommentUpsertRow[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) { dropped++; continue; }
    const parsed = parseReplyRow(entry as Record<string, unknown>, upperMid ?? undefined);
    if (parsed.rpid_str === null) { dropped++; continue; } // 五 ID 皆缺（§2.3 ingest 侧拦截）
    const { source: _source, ...rest } = parsed; // source 是解析层诊断标记，不入库列
    rows.push({ ...rest, rpid_str: parsed.rpid_str });
  }
  return { rows, dropped };
}

/** pins 数组校验（§2.5 三类）：条目需非空 rpid_str + 合法 kind；错误以字符串返回（调用方 400）。 */
function parsePins(raw: unknown): CommentPin[] | string {
  if (!Array.isArray(raw)) return 'pins: [{rpid_str, kind}] must be an array';
  const pins: CommentPin[] = [];
  for (const p of raw) {
    if (p == null || typeof p !== 'object' || Array.isArray(p)) return 'pins entries must be objects';
    const { rpid_str, kind } = p as Record<string, unknown>;
    const rpid = nonEmptyStr(rpid_str);
    if (rpid === null) return 'pins entry needs non-empty string rpid_str';
    if (typeof kind !== 'string' || !(PIN_KINDS as readonly string[]).includes(kind)) {
      return `pins entry kind must be one of ${PIN_KINDS.join('|')}`;
    }
    pins.push({ rpid_str: rpid, kind });
  }
  return pins;
}

/** ingest body 校验 + 归一。严格项：bvid / replies / full_scan=true 时的 scan_start（缺则对账无基准）；
 * 宽松项：fetched_at 缺省取服务器当前时间，upper_mid/batch_id/sort/page 缺省 null（db 层语义见名）。 */
function parseIngestBody(b: unknown): IngestParsed | { error: string } {
  const body = b as Record<string, unknown>;
  const bvid = nonEmptyStr(body.bvid);
  if (!bvid) return { error: 'bvid must be a non-empty string' };
  if (!Array.isArray(body.replies)) return { error: 'replies: [...] required (non-empty array)' };
  const fullScan = body.full_scan === true;
  let scanStart: number | null = null;
  if (fullScan) {
    scanStart = finiteNum(body.scan_start);
    if (scanStart === null) return { error: 'scan_start: number(ms) required when full_scan=true' };
  }
  const pins = body.pins === undefined ? null : parsePins(body.pins);
  if (typeof pins === 'string') return { error: pins };
  const upperMid = upperMidOf(body.upper_mid);
  const { rows, dropped } = normalizeReplies(body.replies, upperMid);
  if (rows.length === 0) return { error: 'replies: no valid comment entries (条目非对象或 rpid 缺失)' };
  if (dropped > 0) {
    console.error(`[http] comments ingest dropped ${dropped} invalid entries (条目非对象或 rpid 缺失)`);
  }
  return {
    bvid,
    upperMid,
    pins,
    fullScan,
    scanStart,
    rows,
    fetchedAt: finiteNum(body.fetched_at) ?? Date.now(),
    batchId: nonEmptyStr(body.batch_id),
    sort: nonEmptyStr(body.sort),
    page: finiteNum(body.page),
  };
}

// ── 端点 ──

/** bvid 查询参数 → 库内视频（count/verify/tree 共用）；错误带 HTTP 状态。评论恒 bilibili 域。 */
function resolveVideo(db: Database.Database, bvid: string | null): { videoId: number; bvid: string } | { status: number; error: string } {
  if (!bvid) return { status: 400, error: 'bvid query param required' };
  const detail = getVideo(db, 'bilibili', bvid);
  if (!detail) return { status: 404, error: `video not found: bilibili/${bvid}` };
  return { videoId: detail.video.id as number, bvid };
}

// GET /api/comments/tree 的节点形态（web 契约 2026-10-05）：CommentRecord 白名单子集，snake_case
// 与列名逐字对齐；replies 只挂一层（根→楼中楼），楼层节点恒空数组（B 站楼中楼只两级）。
export interface CommentTreeNode {
  rpid_str: string;
  uname: string | null;
  mid_str: string | null;
  message: string | null;
  like_count: number;
  ctime_s: number | null;
  pin_kind: string | null;
  replies: CommentTreeNode[];
}

function toTreeNode(rec: CommentRecord, replies: CommentTreeNode[]): CommentTreeNode {
  return {
    rpid_str: rec.rpid_str,
    uname: rec.uname,
    mid_str: rec.mid_str,
    message: rec.message,
    like_count: rec.like_count,
    ctime_s: rec.ctime_s,
    pin_kind: rec.pin_kind,
    replies,
  };
}

/** GET /api/comments/tree?bvid=：根+楼中楼两层级树（web 评论页签展示，2026-10-05）。
 * 排序：置顶（pin_kind 非空）稳定前置（相对序不变），其余保持 CLI 口径（treeByVideo：
 * 根 like_count DESC/ctime_s ASC/id ASC；楼层 ctime_s ASC/id ASC）；响应顺序以页面渲染为准。
 * total_rows = 库内全部评论行（含根已删的孤儿楼层——它们计入分母但不进树，§3.4 保留口径）；
 * total_roots = 根评论数；视频在库但无评论 → 200 空树（对齐 count 端点，非 404）。 */
function handleTree(res: ServerResponse, db: Database.Database, bvid: string | null): void {
  const v = resolveVideo(db, bvid);
  if ('error' in v) { json(res, v.status, { ok: false, error: v.error }); return; }
  const tree = treeByVideo(db, v.videoId);
  // 稳定分区：置顶在前、普通在后，各自保持 treeByVideo 的既有相对序（filter 保序）
  const pinned = tree.roots.filter((r) => r.pin_kind != null);
  const normal = tree.roots.filter((r) => r.pin_kind == null);
  const nodes = [...pinned, ...normal].map((root) =>
    toTreeNode(root, (tree.floorsByRoot.get(root.rpid_str) ?? []).map((f) => toTreeNode(f, []))),
  );
  const c = commentsCount(db, v.videoId);
  json(res, 200, {
    ok: true,
    bvid: v.bvid,
    total_rows: c.rows,
    total_roots: tree.roots.length,
    tree: nodes,
  });
}

/** GET /api/comments/list 的 limit 解析：缺省 200（根评论条数上限，楼中楼随其根带出——
 *  防 88978 条级巨量视频撑爆 popup）；0=全部根（shapeTree 口径）；非正整数 → 400（显式错误，
 *  静默回落默认会掩盖调用方 bug）。 */
const LIST_LIMIT_DEFAULT = 200;
function parseListLimit(raw: string | null): number | { error: string } {
  if (raw === null) return LIST_LIMIT_DEFAULT;
  if (!/^\d+$/.test(raw)) return { error: 'limit must be a non-negative integer' };
  return Number(raw);
}

/** GET /api/comments/list?bvid=&limit=：轻量拍平列表（popup 评论卡消费，2026-10-08 用户现场指令）。
 *  排序：置顶稳定前置（filter 保序，对齐 handleTree），其余根保持 commentsLightTree 赞降序；
 *  楼中楼随其根（组内 ctime 升序）摊平进同一数组——root_rpid/parent_rpid/dialog_rpid 白名单字段
 *  供消费方树还原。total_rows/total_roots = 库内全量口径（含未带出的被截根与孤儿楼，截断时作
 *  分母）；truncated = 发生截根。视频在库无评论 → 200 comments:[]（对齐 tree/count，非 404）；
 *  不在库 → 404（popup hook 归一 0 条灰字）。 */
function handleList(res: ServerResponse, db: Database.Database, bvid: string | null, limitRaw: string | null): void {
  const v = resolveVideo(db, bvid);
  if ('error' in v) { json(res, v.status, { ok: false, error: v.error }); return; }
  const limit = parseListLimit(limitRaw);
  if (typeof limit !== 'number') { json(res, 400, { ok: false, error: limit.error }); return; }

  const tree = commentsLightTree(db, v.videoId, limit);
  // 置顶稳定前置（相对序不变），其后普通根按赞降序；根后随楼摊平成渲染序
  const orderedRoots = [
    ...tree.roots.filter((r) => r.pin_kind != null),
    ...tree.roots.filter((r) => r.pin_kind == null),
  ];
  const comments: CommentLightRow[] = [];
  for (const root of orderedRoots) {
    comments.push(root);
    for (const f of tree.floorsByRoot.get(root.rpid_str) ?? []) comments.push(f);
  }
  const c = commentsCount(db, v.videoId);
  json(res, 200, {
    ok: true,
    bvid: v.bvid,
    total_rows: c.rows,
    total_roots: c.roots,
    truncated: limit > 0 && c.roots > limit,
    limit,
    comments,
  });
}

/** POST /api/comments/ingest：解析归一 → upsert（单事务）→ full 轮 missing 对账 + 置顶清打。 */
async function handleIngest(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const parsed = parseIngestBody(await readJsonBody(req));
  if ('error' in parsed) { json(res, 400, { ok: false, error: parsed.error }); return; }

  const detail = getVideo(db, 'bilibili', parsed.bvid);
  if (!detail) { json(res, 404, { ok: false, error: `video not found: bilibili/${parsed.bvid}` }); return; }
  const videoId = detail.video.id as number;

  const { inserted, updated } = upsertComments(db, {
    videoId,
    upperMid: parsed.upperMid,
    replies: parsed.rows,
    fetchedAt: parsed.fetchedAt,
    batchId: parsed.batchId,
    page: parsed.page,
    sort: parsed.sort,
  });

  // 完整轮守卫（is_end/风控终止/连续空页/伪完整 suspicious_truncation）是 CLI 采集层职责（PLAN §3.3
  // 守卫 1-3 在调用方判定）；端点只管收到 full_scan:true 就执行对账。pins 仅 full 轮生效
  // （先清后打，§3.3）；partial 轮不发 pins、不碰 missing/pin_kind。
  let missing: { candidates: number; restored: number; confirmed: number } | null = null;
  if (parsed.fullScan) {
    missing = reconcileMissing(db, { videoId, scanStart: parsed.scanStart as number });
    if (parsed.pins) clearAndSetPins(db, videoId, parsed.pins);
  }

  json(res, 200, { ok: true, video_id: videoId, inserted, updated, missing });
}

export async function handleCommentsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/comments/ingest' && req.method === 'POST') {
    await handleIngest(req, res, db);
    return;
  }

  if (url.pathname === '/api/comments/count' && req.method === 'GET') {
    const v = resolveVideo(db, url.searchParams.get('bvid'));
    if ('error' in v) { json(res, v.status, { ok: false, error: v.error }); return; }
    // 视频在库无评论 → 200 全 0（非 404；§4.3 步 0 以 rows 分流 full/incremental）
    const c = commentsCount(db, v.videoId);
    json(res, 200, { ok: true, rows: c.rows, roots: c.roots, max_ctime_s: c.maxCtimeS });
    return;
  }

  if (url.pathname === '/api/comments/verify' && req.method === 'GET') {
    const v = resolveVideo(db, url.searchParams.get('bvid'));
    if ('error' in v) { json(res, v.status, { ok: false, error: v.error }); return; }
    // 纯库内校验：R4 分母走库内 rcount 快照（rootPageCounts 缺省 → 'rcount fallback'）、
    // R9 外部总量缺省跳过——collect 轮的实时分母/外部哨兵由 CLI 采集侧（C4）自带，不在此端点。
    json(res, 200, { ok: true, bvid: v.bvid, ...verifyTree(db, v.videoId) });
    return;
  }

  if (url.pathname === '/api/comments/tree' && req.method === 'GET') {
    handleTree(res, db, url.searchParams.get('bvid'));
    return;
  }

  if (url.pathname === '/api/comments/list' && req.method === 'GET') {
    handleList(res, db, url.searchParams.get('bvid'), url.searchParams.get('limit'));
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}
