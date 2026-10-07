// HTTP handler：B 站弹幕采集通路（2026-10-07 弹幕解冻，规格唯一来源 docs/plans/danmaku/PLAN.md §4.1）。
// 四端点（读 GET / 写 POST 惯例）：
//   POST /api/danmaku/ingest —— 解析归一后的条目（cli/bili-danmaku.ts 产物）白名单映射
//                              （批次级 cid/page 盖章到每行）→ upsertDanmaku（单事务幂等）；
//   GET  /api/danmaku/count?bvid=   —— 行数/分 P 聚合/时间轴水位（§4.3 步 0 count 哨兵与重采 diff 依赖）；
//   GET  /api/danmaku/verify?bvid=  —— 纯库内校验统计（§5.3，collect 收尾自动调用，只读无副作用）；
//   GET  /api/danmaku/list?bvid=    —— 全量弹幕轻量列表（白名单四字段防体量，popup 展示/复制消费，
//                              2026-10-07 用户现场指令追加，PLAN 外追加端点）。
// 消费方是 CLI `danmaku collect`（宿主直连 B 站采、经本端点写生产库——「CLI 永不写库」纪律，D4）。
// Bearer 鉴权由 main.ts 对 /api/* 统一执行（httpAuthOk），本 handler 不重复。
// 弹幕恒挂 videos.id（先采视频再谈弹幕，§4.1），定位只认 bvid（对齐 comments.ts 的 getVideo 写法）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { danmakuCount, danmakuTimeline, upsertDanmaku, type DanmakuRecord, type DanmakuUpsertRow } from '../db/danmaku.js';
import { verifyDanmaku } from '../db/danmaku-verify.js';
import { getVideo } from '../db/queries.js';
import { json, readJsonBody } from './http-util.js';

// ── 标量归一小工具（守圈复杂度 ≤15）──

/** 有限数字直读（否则 null）：null/undefined/非法类型一律 null（数值字段容错口径，不做隐式转换）。 */
function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 非空字符串直读（否则 null）。 */
function nonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

// ── ingest body 校验 + 白名单映射 ──

export interface DanmakuIngestParsed {
  bvid: string;
  cid: number;
  page: number;
  fetchedAt: number;
  batchId: string;
  rows: DanmakuUpsertRow[];
  skipped: number;
}

/** 原始条目 → DanmakuUpsertRow 白名单映射（cid/page 取批次级值盖章到每行——条目本身不带分 P 定位）；
 *  数值/字符串字段容错（null/undefined/非法类型 → null）。条目非对象或 id_str 缺失（唯一键不可定位）
 *  → 跳过计数。跳过不 400：单批数千条下个别脏条目不值得整批失败（对齐 comments.ts 容错口径），
 *  skipped 计入回执可观察（全无效 → 零写入 200，upsert 层空数组防御）。 */
function normalizeDanmakus(raw: unknown[], cid: number, page: number): { rows: DanmakuUpsertRow[]; skipped: number } {
  const rows: DanmakuUpsertRow[] = [];
  let skipped = 0;
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) { skipped++; continue; }
    const e = entry as Record<string, unknown>;
    const idStr = nonEmptyStr(e.id_str);
    if (idStr === null) { skipped++; continue; } // 唯一键缺失（id_str 恒取 field12 字符串，PLAN §2.3）
    rows.push({
      id_str: idStr,
      cid,
      page,
      progress_ms: finiteNum(e.progress_ms),
      mode: finiteNum(e.mode),
      fontsize: finiteNum(e.fontsize),
      color: finiteNum(e.color),
      mid_hash: nonEmptyStr(e.mid_hash),
      content: nonEmptyStr(e.content),
      ctime_s: finiteNum(e.ctime_s),
      weight: finiteNum(e.weight),
      pool: finiteNum(e.pool),
      action: nonEmptyStr(e.action),
    });
  }
  return { rows, skipped };
}

/** ingest body 校验 + 归一。六字段全必带（§4.1 契约）：bvid/cid/page/fetched_at/batch_id/danmakus——
 *  与 comments 的缺省容错不同：弹幕批次由 CLI 统一构造，缺任一字段即调用方 bug（早失败早暴露）；
 *  danmakus 须非空数组（零数据请求无意义，CLI flush 只发非空 buffer），条目级脏数据走 skipped 容错。 */
function parseIngestBody(b: unknown): DanmakuIngestParsed | { error: string } {
  if (b == null || typeof b !== 'object' || Array.isArray(b)) return { error: 'body must be a JSON object' };
  const body = b as Record<string, unknown>;
  const bvid = nonEmptyStr(body.bvid);
  if (!bvid) return { error: 'bvid must be a non-empty string' };
  const cid = finiteNum(body.cid);
  if (cid === null) return { error: 'cid: number required (本批所属分 P oid)' };
  const page = finiteNum(body.page);
  if (page === null) return { error: 'page: number required (分 P 页码)' };
  const fetchedAt = finiteNum(body.fetched_at);
  if (fetchedAt === null) return { error: 'fetched_at: number(ms) required' };
  const batchId = nonEmptyStr(body.batch_id);
  if (!batchId) return { error: 'batch_id: non-empty string required' };
  if (!Array.isArray(body.danmakus) || body.danmakus.length === 0) {
    return { error: 'danmakus: [...] required (non-empty array)' };
  }
  const { rows, skipped } = normalizeDanmakus(body.danmakus, cid, page);
  return { bvid, cid, page, fetchedAt, batchId, rows, skipped };
}

// ── 端点 ──

/** bvid 查询参数 → 库内视频（count/verify/list 共用）；错误带 HTTP 状态。弹幕恒 bilibili 域。 */
function resolveVideo(db: Database.Database, bvid: string | null): { videoId: number; bvid: string } | { status: number; error: string } {
  if (!bvid) return { status: 400, error: 'bvid query param required' };
  const detail = getVideo(db, 'bilibili', bvid);
  if (!detail) return { status: 404, error: `video not found: bilibili/${bvid}` };
  return { videoId: detail.video.id as number, bvid };
}

/** DanmakuRecord → 轻量白名单四字段（list 端点专用，popup 展示/复制消费，2026-10-07 用户现场指令追加）：
 *  只透出展示所需 progress_ms/mode/content/ctime_s（值原样可为 null），不泄漏 id_str/mid_hash 等
 *  采集侧字段——全量行出网防体量防泄漏，白名单映射而非黑名单剔除。 */
function lightDanmaku(r: DanmakuRecord): { progress_ms: number | null; mode: number | null; content: string | null; ctime_s: number | null } {
  return { progress_ms: r.progress_ms, mode: r.mode, content: r.content, ctime_s: r.ctime_s };
}

/** POST /api/danmaku/ingest：白名单映射 → upsert（单事务幂等，PLAN §3.3）。 */
async function handleIngest(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const parsed = parseIngestBody(await readJsonBody(req));
  if ('error' in parsed) { json(res, 400, { ok: false, error: parsed.error }); return; }

  const detail = getVideo(db, 'bilibili', parsed.bvid);
  if (!detail) { json(res, 404, { ok: false, error: `video not found: bilibili/${parsed.bvid}` }); return; }
  const videoId = detail.video.id as number;

  const { inserted, updated } = upsertDanmaku(db, videoId, parsed.rows, {
    fetchedAt: parsed.fetchedAt,
    batchId: parsed.batchId,
  });
  json(res, 200, { ok: true, video_id: videoId, inserted, updated, skipped: parsed.skipped });
}

export async function handleDanmakuHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/danmaku/ingest' && req.method === 'POST') {
    await handleIngest(req, res, db);
    return;
  }

  if (url.pathname === '/api/danmaku/count' && req.method === 'GET') {
    const v = resolveVideo(db, url.searchParams.get('bvid'));
    if ('error' in v) { json(res, v.status, { ok: false, error: v.error }); return; }
    // 视频在库未采过弹幕 → 200 rows:0/pages:[]（非 404；PLAN §4.1 明示，步 0 count 哨兵依赖）
    const c = danmakuCount(db, v.videoId);
    json(res, 200, { ok: true, bvid: v.bvid, ...c });
    return;
  }

  if (url.pathname === '/api/danmaku/verify' && req.method === 'GET') {
    const v = resolveVideo(db, url.searchParams.get('bvid'));
    if ('error' in v) { json(res, v.status, { ok: false, error: v.error }); return; }
    // 纯库内校验统计（§5.1 R1-R5 / §5.3 回执结构）：只读无副作用；ok/bvid 外壳由本端点包装（db 层不含）
    json(res, 200, { ok: true, bvid: v.bvid, ...verifyDanmaku(db, v.videoId) });
    return;
  }

  if (url.pathname === '/api/danmaku/list' && req.method === 'GET') {
    const v = resolveVideo(db, url.searchParams.get('bvid'));
    if ('error' in v) { json(res, v.status, { ok: false, error: v.error }); return; }
    // 全量轻量列表（popup 展示/复制消费，2026-10-07 用户现场指令追加）：timeline 全量行（§3.4，
    // cid 升序内 progress 升序）映射白名单四字段；pages/rows 复用 danmakuCount 口径（两条查询都便宜）。
    // 视频在库未采弹幕 → 200 rows:0/pages:[]/danmakus:[]（非 404，与 count 端点口径一致）
    const c = danmakuCount(db, v.videoId);
    const timeline = danmakuTimeline(db, v.videoId);
    json(res, 200, { ok: true, bvid: v.bvid, rows: c.rows, pages: c.pages, danmakus: timeline.map(lightDanmaku) });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}
