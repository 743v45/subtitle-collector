// collect 命令组：主动去 B 站采集（经 server→扩展，扩展内 fetch）。
// 设计参考 [2026-07-05-active-collection-design.md §6.4]。
// 底层全部复用 ServerClient.sendCommand + POST /api/clients/:id/command。
// 措辞：字幕（subtitle），非弹幕。
import type Database from 'better-sqlite3';
import { Command } from 'commander';
import {
  ServerClient,
  ServerUnreachableError,
  ServerResponseError,
} from '../http.js';
import { emitResult, emitError } from '../output.js';
import { getCliContext } from '../context.js';
import { openReadonlyDb } from '../db.js';
import { NO_SUBTITLE_TAG } from '../../db/tags.js';

/** 采集类命令默认超时：对齐 server 调度器分档（tasks.ts commandTimeoutMs——bilibili 90s / youtube 180s），
 *  覆盖扩展全链路（导航+多请求+宽限+关 tab）；低于扩展实际耗时会把仍在执行的任务判成失败。 */
const DEFAULT_COLLECT_TIMEOUT_MS = 180000;

/** ServerClient 最小接口（便于测试注入 mock）。 */
export interface CollectClient {
  listClients(): Promise<unknown[]>;
  sendCommand(clientId: string, action: string, params: Record<string, unknown>, timeout: number): Promise<unknown>;
}

/** --client 缺省时取第一个在线 client；无在线 → 抛错（action 前由调用方捕获转 ARGS）。 */
export async function resolveClientId(client: CollectClient, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const list = await client.listClients();
  const first = list.find((c) => (c as { client_id?: string })?.client_id);
  if (!first) throw new Error('no online client（扩展未连接，先确认浏览器已装扩展并已连 server）');
  return (first as { client_id: string }).client_id;
}

// ── 扩展命令统一入口（2026-08-21 端点形状收敛后）──
// server /api/clients/:id/command 的约定：成功 200 且 result 直接是扩展回执 data；
// 扩展执行失败 502 / 客户端离线 404 / 回执超时 504 —— HTTP 状态即结果，CLI 不再挖 result.ok。

/** sendCommand 成功响应体：result = 扩展回执 data（无内层 ok/data 包装）。 */
export interface CommandResp<T = Record<string, unknown>> {
  ok: boolean;
  client_id?: string;
  action?: string;
  result?: T;
}

/** 扩展命令失败：status 为 server 映射的 HTTP 状态（502 扩展执行失败 / 404 离线 / 504 超时），
 *  extError 为错误体里的 error 原文（扩展执行失败时即扩展回执 error），message 带 action 上下文。 */
export class ExtCommandError extends Error {
  readonly status: number;
  readonly extError: string;
  constructor(action: string, status: number, extError: string) {
    super(`${action} failed: ${extError}`);
    this.name = 'ExtCommandError';
    this.status = status;
    this.extError = extError;
  }
}

/** 下发扩展命令的统一入口：成功透传响应体；失败（ServerResponseError，requestJson 已带 HTTP 状态）
 *  解析错误体的 error 字段转 ExtCommandError（带 action 上下文）；非 HTTP 错误原样上抛。 */
export async function sendExtCommand(
  client: CollectClient,
  clientId: string,
  action: string,
  params: Record<string, unknown>,
  timeout: number,
): Promise<CommandResp> {
  try {
    return await client.sendCommand(clientId, action, params, timeout) as CommandResp;
  } catch (err) {
    if (err instanceof ServerResponseError) {
      let extError = err.body;
      try {
        const j = JSON.parse(err.body) as { error?: unknown };
        if (typeof j.error === 'string' && j.error) extError = j.error;
      } catch { /* 非 JSON 错误体：body 原文作 extError */ }
      throw new ExtCommandError(action, err.status, extError);
    }
    throw err;
  }
}

/** 单条采集的失败软/硬分类：need_login / risk_control → 硬停（抛 STOP 错，继续采大概率全失败）；
 *  其余扩展错误 → 软失败（返回 error 原文记 reason，继续下一条）。传输层错误原样上抛（整轮失败）。 */
function classifyCollectError(err: unknown, id: string): string {
  if (!(err instanceof ExtCommandError)) throw err;
  if (err.extError === 'need_login' || err.extError === 'risk_control') {
    throw new Error(`collect ${id} STOP: ${err.extError}（请处理后重跑）`);
  }
  return err.extError;
}

// ── 纯处理函数（可测：注入 mock client + 参数，返回结构化数据）──

export interface SearchOpts { page?: number; order?: string; tid?: number; }

/** `collect search <keyword>`：下发 search action，透传 server 响应。 */
export async function collectSearch(
  client: CollectClient,
  clientId: string,
  keyword: string,
  opts: SearchOpts,
  timeout: number,
): Promise<unknown> {
  const params: Record<string, unknown> = { keyword, page: opts.page ?? 1, order: opts.order ?? 'pubdate' };
  if (opts.tid != null) params.tid = opts.tid;
  return sendExtCommand(client, clientId, 'search', params, timeout);
}

/** `collect subtitle <bvid>`：下发 fetch-subtitle，扩展 fetch view+player+字幕体→ingest。 */
export async function collectSubtitle(
  client: CollectClient,
  clientId: string,
  bvid: string,
  timeout: number,
): Promise<unknown> {
  return sendExtCommand(client, clientId, 'fetch-subtitle', { bvid }, timeout);
}

/** `collect dedupe <bvid...>`：直读 SQLite，判据=video 是否存在（无字幕视频采过后也入 videos）。
 *  source 参数化（2026-08-21，YouTube 频道批量用）。 */
export function collectDedupe(
  db: Database.Database,
  bvids: string[],
  source: 'bilibili' | 'youtube' = 'bilibili',
): { collected: string[]; missing: string[] } {
  if (bvids.length === 0) return { collected: [], missing: [] };
  const placeholders = bvids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT source_vid FROM videos WHERE source = ? AND source_vid IN (${placeholders})`,
  ).all(source, ...bvids) as Array<{ source_vid: string }>;
  const set = new Set(rows.map((r) => r.source_vid));
  const collected: string[] = [];
  const missing: string[] = [];
  for (const b of bvids) (set.has(b) ? collected : missing).push(b);
  return { collected, missing };
}

// ── `collect season`：整个合集（ugc_season）字幕批量采集（2026-08-22）──
// 入参三形态：BV 号（须已采过——库内 extra.ugc_season.id 取合集）/ 纯数字合集 id /
// 合集页链接（…/channel/collectiondetail?sid=N 或 ?season_id=N）。
// 流程：扩展 list-season-videos 同步展开全量 → 直读库判重（已采跳过,判据同 dedupe）→
// 未采批量建任务（server 调度器自动串行执行,扩展离线则排队等上线;creator_uid 带 mid）。

/** 入参解析（纯函数可测）：BV 号 / 合集 id / 合集页链接 → {seasonId, bvid}。都认不出返回双 null。 */
export function parseSeasonArg(arg: string): { seasonId: number | null; bvid: string | null } {
  const t = arg.trim();
  if (/^BV[0-9A-Za-z]{10}$/.test(t)) return { seasonId: null, bvid: t };
  if (/^\d+$/.test(t)) return { seasonId: Number(t), bvid: null };
  try {
    const u = new URL(t);
    const sid = u.searchParams.get('sid') ?? u.searchParams.get('season_id');
    if (sid && /^\d+$/.test(sid)) return { seasonId: Number(sid), bvid: null };
  } catch { /* 非 URL 忽略 */ }
  return { seasonId: null, bvid: null };
}

/** 库内取合集 id：已采视频的 extra.ugc_season.id（ingest-payload 落）。未采过返回 null。 */
export function seasonIdFromDb(db: Database.Database, bvid: string): number | null {
  const row = db.prepare(
    "SELECT json_extract(extra, '$.ugc_season.id') AS sid FROM videos WHERE source = 'bilibili' AND source_vid = ?",
  ).get(bvid) as { sid: number | null } | undefined;
  return row?.sid ?? null;
}

/** season 子命令的 client 依赖（CollectClient + 批量建任务;测试注入 mock 用）。 */
export interface SeasonCollectClient extends CollectClient {
  createCollectTasksBatch(body: { vids: string[]; source: 'bilibili'; creator_uid?: string | null }): Promise<unknown>;
}

/** `collect season <arg>`：展开合集 → 判重 → 未采批量建任务。返回汇总（created/skipped 透传任务端点）。 */
export async function collectSeason(
  client: SeasonCollectClient,
  clientId: string,
  db: Database.Database,
  arg: string,
  opts: { dryRun?: boolean; timeout: number },
): Promise<Record<string, unknown>> {
  const parsed = parseSeasonArg(arg);
  let seasonId = parsed.seasonId;
  if (parsed.bvid) {
    seasonId = seasonIdFromDb(db, parsed.bvid);
    if (seasonId == null) {
      throw new Error(`BV 未采集过,库内无合集归属——先 collect subtitle ${parsed.bvid} 采一次,或直接传合集 id / 合集页链接`);
    }
  }
  if (seasonId == null) throw new Error(`无法识别合集参数: ${arg}（支持 BV 号 / 合集 id / 合集页链接）`);

  // 扩展同步展开合集全量（分页 + 500ms 页间节流;大合集十几秒,timeout 建议 ≥120000）
  const resp = await sendExtCommand(client, clientId, 'list-season-videos', { season_id: seasonId }, opts.timeout);
  const data = (resp.result ?? {}) as { mid?: unknown; items?: unknown };
  const items = Array.isArray(data.items) ? data.items : [];
  const bvids = items
    .map((it) => (typeof (it as { bvid?: unknown })?.bvid === 'string' ? (it as { bvid: string }).bvid : ''))
    .filter(Boolean);
  if (bvids.length === 0) throw new Error(`合集 ${seasonId} 展开结果为空（合集不存在或扩展拉取失败）`);
  const mid = typeof data.mid === 'number' ? String(data.mid) : null;

  // 判重：已入库视频跳过（重采个别视频用 collect subtitle 单发）
  const { collected, missing } = collectDedupe(db, bvids);
  const out: Record<string, unknown> = {
    season_id: seasonId,
    total: bvids.length,
    collected: collected.length,
    missing: missing.length,
  };
  if (missing.length === 0) return { ...out, tasks_created: 0, note: '合集视频已全部采集' };
  if (opts.dryRun) return { ...out, dry_run: true, missing_bvids: missing };
  const r = await client.createCollectTasksBatch({ vids: missing, source: 'bilibili', creator_uid: mid }) as {
    created?: number; skipped?: number;
  };
  return {
    ...out,
    tasks_created: r?.created ?? 0,
    tasks_skipped: r?.skipped ?? 0,
    note: '任务已创建,server 调度器自动派发扩展执行（web 采集页 / 历史页看进度）',
  };
}

/** `collect nosub`（内部用）：返回 bvids 中「已入 videos 但无 subtitle_tracks」的子集（供 --retry-nosub 重采）。
 *  与 collectDedupe 互补：dedupe 只看 video 行存在即标 collected（含「无字幕也入库」），nosub 进一步挑出
 *  「video 在库但无字幕轨」者——刚发布的视频字幕可能尚未生成，采过后入库 video 但无 track，需可重采。 */
export function collectNosub(
  db: Database.Database,
  bvids: string[],
): string[] {
  if (bvids.length === 0) return [];
  const placeholders = bvids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT v.source_vid FROM videos v
     LEFT JOIN subtitle_tracks t ON t.video_id = v.id
     WHERE v.source = 'bilibili' AND v.source_vid IN (${placeholders}) AND t.id IS NULL`,
  ).all(...bvids) as Array<{ source_vid: string }>;
  return rows.map((r) => r.source_vid);
}

// ── YouTube 频道（2026-08-21）：CLI 参数解析 + 全量列表 + 逐条采集 ──

/** 频道标识（扩展 list-yt-channel-videos action 的 ident 参数）。 */
export interface YtChannelIdent { handle?: string; channelId?: string; custom?: string; }

/** CLI 参数（@handle / UCxxx / 频道页 URL）→ ident。非法抛错（命令注册层转 ARGS）。 */
export function parseYtChannelArg(arg: string): YtChannelIdent {
  const a = arg.trim();
  if (/^@[\w.-]{3,30}$/.test(a)) return { handle: a };
  if (/^UC[\w-]{22}$/.test(a)) return { channelId: a };
  try {
    const u = new URL(a);
    if (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com')) {
      const seg = u.pathname.split('/').filter(Boolean);
      if (seg[0] && /^@[\w.-]{3,30}$/.test(seg[0])) return { handle: seg[0] };
      if (seg[0] === 'channel' && seg[1] && /^UC[\w-]{22}$/.test(seg[1])) return { channelId: seg[1] };
      if ((seg[0] === 'c' || seg[0] === 'user') && seg[1] && /^[\w.-]+$/.test(seg[1])) return { custom: seg[1] };
    }
  } catch { /* 非 URL → 落到下面统一报错 */ }
  throw new Error(`无法识别的频道参数：${arg}（支持 @handle / UC 开头 channelId / 频道页 URL）`);
}

/** 单条 YouTube 频道视频（list-yt-channel-videos 扩展回执 data.items 形状）。 */
export interface YtChannelVideoItem {
  vid: string;
  title?: string | null;
  created?: number | null; // unix 秒（publishedTimeText 相对时间估算）
  play?: number | null;
  length?: string | null;
}

/** `collect yt-videos`：下发 list-yt-channel-videos，扩展全量分页拉完回执（refresh 绕过扩展侧 1h 缓存）。 */
export async function collectYtChannelVideos(
  client: CollectClient,
  clientId: string,
  ident: YtChannelIdent,
  opts: { refresh?: boolean },
  timeout: number,
): Promise<unknown> {
  return sendExtCommand(client, clientId, 'list-yt-channel-videos', { ident, refresh: opts.refresh === true }, timeout);
}

/** `collect yt-videos <key> --collect`：逐条采集未入库视频（fetch-youtube-subtitle navigate，串行 + sleep 防风控）。
 *  已入库（videos 表命中）跳过——判据对齐 collectDedupe（无字幕也入 videos）。返回逐条结果。
 *  失败分类见 classifyCollectError：need_login/risk_control 硬停、其余扩展错误软记 reason、
 *  传输层错误整轮抛出。sleep 注入供测试（默认逐条间隔下限 1s 防风控）。 */
export async function collectYtVideosRun(
  client: CollectClient,
  clientId: string,
  db: Database.Database,
  vids: string[],
  sleepMs: number,
  timeout: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Array<{ vid: string; ok: boolean; reason?: string }>> {
  const { missing } = collectDedupe(db, vids, 'youtube');
  const out: Array<{ vid: string; ok: boolean; reason?: string }> = [];
  for (const vid of missing) {
    let data: { captured?: number; reason?: string } | undefined;
    let extError: string | undefined;
    try {
      const resp = await sendExtCommand(client, clientId, 'fetch-youtube-subtitle', { videoId: vid }, timeout);
      data = resp.result;
    } catch (err) {
      extError = classifyCollectError(err, vid);
    }
    out.push({ vid, ok: !extError && (data?.captured ?? 0) > 0, reason: extError ?? data?.reason });
    await sleep(Math.max(sleepMs, 1000));
  }
  return out;
}

/** `collect upper-info <mid>`：下发 get-upper-info，扩展 fetch acc/info+stat → ingest-upper 入库。 */
export async function collectUpperInfo(
  client: CollectClient,
  clientId: string,
  mid: string,
  timeout: number,
): Promise<unknown> {
  return sendExtCommand(client, clientId, 'get-upper-info', { mid }, timeout);
}

export interface UpperVideosOpts { page?: number; size?: number; }

/** 单条 UP 视频元数据（扩展 list-upper-videos 返回）。 */
export interface UpperVideoItem {
  bvid: string;
  title?: string;
  created?: number;
  play?: number;
  length?: string;
}

/** list-upper-videos 响应体（server 包装）：result 即扩展 data（total/items 列表）。 */
export interface UpperVideosResp {
  ok: boolean;
  client_id?: string;
  action?: string;
  result?: { total?: number; items?: UpperVideoItem[] };
}

/** `collect upper-videos <mid>`：下发 list-upper-videos，返回视频列表（不入库）。 */
export async function collectUpperVideos(
  client: CollectClient,
  clientId: string,
  mid: string,
  opts: UpperVideosOpts,
  timeout: number,
): Promise<unknown> {
  return sendExtCommand(client, clientId, 'list-upper-videos',
    { mid, page: opts.page ?? 1, page_size: opts.size ?? 30 }, timeout);
}

/** `collect upper-videos --all`：循环翻页拉完 UP 主所有视频，合并 items 后按单页响应形状返回。 */
// page 从 1 起，每页 size 条；翻到本页 items 不足 size（到尾）或累计达 total 停。
// maxPages 兜底防异常 total 导致的无限翻页。列表 API 轻量，页间不额外 sleep（CLI↔扩展↔B站 往返即延迟）。
// sinceCreated（可选）：发布时间窗起点（UNIX 秒）。非空时过滤掉 created < sinceCreated 的视频；
//   created == null 的视频保留（避免漏采刚发布还未带发布时间的条目）。
//   total 语义：未传 sinceCreated 保持 API 原 total；传了则用过滤后长度（便于调用方判断队列规模）。
export async function collectUpperVideosAll(
  client: CollectClient,
  clientId: string,
  mid: string,
  size: number,
  timeout: number,
  sinceCreated?: number,
): Promise<UpperVideosResp> {
  const allItems: UpperVideoItem[] = [];
  let total = 0;
  let lastResp: UpperVideosResp | undefined;
  const maxPages = 200;
  for (let page = 1; page <= maxPages; page++) {
    // 单页失败（扩展执行失败 → server 502 → ExtCommandError）：补 page 上下文再抛（分页调试需要页号）
    let resp: UpperVideosResp;
    try {
      resp = await collectUpperVideos(client, clientId, mid, { page, size }, timeout) as UpperVideosResp;
    } catch (err) {
      if (err instanceof ExtCommandError) throw new Error(`list-upper-videos page=${page} failed: ${err.extError}`);
      throw err;
    }
    lastResp = resp;
    const data = resp.result ?? {};
    total = data.total ?? total;
    const items = data.items ?? [];
    allItems.push(...items);
    if (items.length < size || (total > 0 && allItems.length >= total)) break;
  }
  // sinceCreated 过滤：null created 保留（避免漏采）；不传则不过滤（向后兼容）。
  const filtered = sinceCreated != null
    ? allItems.filter((it) => it.created == null || (it.created ?? 0) >= sinceCreated)
    : allItems;
  // total 语义：未传 sinceCreated 时保持原 total（来自 API）；传了则用过滤后长度。
  const resultTotal = sinceCreated != null ? filtered.length : total;
  // 用最后一次外层包装 + 合并后的全量 data，保持与单页输出形状一致。
  return {
    ...(lastResp ?? { ok: true }),
    result: { total: resultTotal, items: filtered },
  };
}

/** `collect new-videos <mid>`：拉 UP 主视频列表（经扩展）+ 直读 SQLite 对比 → 返回 new/collected。
 *  拉取失败（扩展执行失败等）抛 ExtCommandError（message 带 action 上下文）。 */
export async function collectNewVideos(
  client: CollectClient,
  clientId: string,
  mid: string,
  db: Database.Database,
  opts: UpperVideosOpts,
  timeout: number,
): Promise<{ total: number; new: string[]; collected: string[] }> {
  const resp = await collectUpperVideos(client, clientId, mid, opts, timeout) as CommandResp<{ total?: number; items?: Array<{ bvid: string }> }>;
  const items = resp.result?.items ?? [];
  const bvids = items.map((it) => it.bvid).filter(Boolean);
  if (bvids.length === 0) return { total: resp.result?.total ?? 0, new: [], collected: [] };
  const placeholders = bvids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT source_vid FROM videos WHERE source = 'bilibili' AND source_vid IN (${placeholders})`,
  ).all(...bvids) as Array<{ source_vid: string }>;
  const set = new Set(rows.map((r) => r.source_vid));
  const collected: string[] = [];
  const newArr: string[] = [];
  for (const b of bvids) (set.has(b) ? collected : newArr).push(b);
  return { total: resp.result?.total ?? bvids.length, new: newArr, collected };
}

/** `collect discover <mid...>`：批量多 UP，每个跑 new-videos，汇总 per_mid + all_new。单 mid 失败记录 error，不影响其他。 */
export async function collectDiscover(
  client: CollectClient,
  clientId: string,
  db: Database.Database,
  mids: string[],
  opts: UpperVideosOpts,
  timeout: number,
): Promise<{
  per_mid: Array<{ mid: string; total: number; new: string[]; collected: string[]; error?: string }>;
  all_new: string[];
}> {
  const per_mid: Array<{ mid: string; total: number; new: string[]; collected: string[]; error?: string }> = [];
  const all_new: string[] = [];
  for (const mid of mids) {
    try {
      const r = await collectNewVideos(client, clientId, mid, db, opts, timeout);
      per_mid.push({ mid, ...r });
      all_new.push(...r.new);
    } catch (err) {
      per_mid.push({ mid, total: 0, new: [], collected: [], error: String((err as Error)?.message ?? err) });
    }
  }
  return { per_mid, all_new };
}

// ── collect find：条件检索（多页搜索 + 发布时间/粉丝数后过滤）──
// 背景：search action 只能按关键词/分区/排序返回候选，不支持「粉丝数/发布时间」过滤；
//   粉丝数更不在搜索结果里（需拿 mid 查 UP 主信息）。find 命令把这层胶水做进 CLI：
//   多页 search → pubdate 后过滤 → 按 mid 解析 fans（creators 表缓存优先，miss 实时 get-upper-info）
//   → fans 过滤 → 输出候选。可选 --collect 直接采字幕。

/** search action 单条结果形状（扩展 formatSearchResult 后）。mid 可能是 number 或 string。 */
export interface SearchItem {
  bvid: string;
  title?: string;
  up?: string;
  mid?: number | string;
  play?: number;
  duration?: string | number;
  pubdate?: number;
}

/** find 命令输出条目（在 SearchItem 基础上补 fans）。 */
export interface FindItem extends SearchItem {
  fans?: number | null;
}

/** find 命令最终输出形状。 */
export interface FindResult {
  keyword: string;
  tid?: number;
  order: string;
  raw_total: number;      // 搜索首页 page.count（B 站声称的总匹配数）
  fetched: number;        // 多页合并后的候选条数
  after_date: number;     // 经发布时间过滤后条数
  after_fans: number;     // 经粉丝过滤后条数（= items 长度）
  fans_cache_hit: number; // fans 取自 creators 表缓存的 unique mid 数
  fans_fetched: number;   // fans 取自实时 get-upper-info 的 unique mid 数
  fans_unknown: number;   // fans 未能解析（缓存 miss + 实时查询失败）的 unique mid 数
  items: FindItem[];
}

/** find 命令检索选项（commander 层映射）。 */
export interface FindOpts {
  pages?: number;     // 翻多少页候选（默认 3）
  order?: string;     // 默认 pubdate
  tid?: number;
  minFans?: number;   // 最低粉丝数（<=0 不过滤）
  since?: number;     // 发布时间下限 UNIX 秒（可选）
}

/** fans 来源抽象（resolveFans 用）：DB 缓存 + 实时查询双通道。便于测试注入 mock。 */
export interface FansSource {
  readFansFromDb(mids: string[]): Promise<Record<string, number>>;
  fetchFans(mid: string): Promise<number | null>;
}

/** 按 pubdate 过滤：since 为空 → 不过滤；pubdate==null 保留（与 upper-videos 一致，避免漏新视频）。 */
export function filterByPubdate(items: SearchItem[], since?: number): SearchItem[] {
  if (since == null) return items;
  return items.filter((it) => it.pubdate == null || (it.pubdate ?? 0) >= since);
}

/** 按 fans 过滤：minFans<=0 → 不过滤；fans==null（未知）保留（保守，宁可多列再人工筛）。 */
export function filterByFans(items: FindItem[], minFans?: number): FindItem[] {
  if (!minFans || minFans <= 0) return items;
  return items.filter((it) => it.fans == null || (it.fans ?? 0) >= minFans);
}

/** 解析发布时间下限：since（UNIX 秒）优先；其次 sinceDays（天，转 now - days*86400）；都没 → undefined。
 *  now 注入便于测试（避免 Date.now 不稳定）。 */
export function parseSince(opts: { since?: number; sinceDays?: number; now?: number }): number | undefined {
  if (opts.since != null && Number.isFinite(opts.since)) return opts.since;
  if (opts.sinceDays != null && Number.isFinite(opts.sinceDays)) {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    return now - opts.sinceDays * 86400;
  }
  return undefined;
}

/** 解析 YYYY-MM-DD → UNIX 秒（本地时区 00:00:00）。非法 → undefined。 */
export function parseDateToUnix(dateStr?: string): number | undefined {
  if (!dateStr) return undefined;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateStr);
  if (!m) return undefined;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
  return Number.isNaN(dt.getTime()) ? undefined : Math.floor(dt.getTime() / 1000);
}

/** 合并 DB 缓存 + 实时补充，解析每个 mid 的 fans。
 *  - 缓存（creators 表 fans>0）直接用；miss 的串行实时查（调用方在 fetchFans 内部 sleep 防风控）；
 *  - 返回 unique mid → fans 映射 + 三类计数（cache_hit / fetched / unknown）。 */
export async function resolveFans(
  mids: string[],
  src: FansSource,
): Promise<{ fans: Map<string, number>; cacheHit: number; fetched: number; unknown: number }> {
  const fans = new Map<string, number>();
  let cacheHit = 0;
  let fetched = 0;
  let unknown = 0;
  const unique = [...new Set(mids)];
  const cached = await src.readFansFromDb(unique);
  const missing: string[] = [];
  for (const mid of unique) {
    const f = cached[mid];
    if (f != null && f > 0) { fans.set(mid, f); cacheHit++; }
    else missing.push(mid);
  }
  for (const mid of missing) {
    const f = await src.fetchFans(mid);
    if (f != null && f > 0) { fans.set(mid, f); fetched++; }
    else unknown++;
  }
  return { fans, cacheHit, fetched, unknown };
}

/** 多页搜索合并：循环 collectSearch page=1..pages，合并 items；首页取 raw_total。
 *  提前终止：某页 items 为空、或累计达 raw_total、或翻满 pages。
 *  单页扩展失败 → server 502 → ExtCommandError，补 page 上下文再抛（分页调试需要页号）。 */
export async function collectFindSearch(
  client: CollectClient,
  clientId: string,
  keyword: string,
  opts: { order: string; tid?: number; pages: number },
  timeout: number,
): Promise<{ raw_total: number; items: SearchItem[] }> {
  const all: SearchItem[] = [];
  let rawTotal = 0;
  for (let page = 1; page <= opts.pages; page++) {
    let resp: CommandResp<{ total?: number; items?: SearchItem[] }>;
    try {
      resp = await collectSearch(client, clientId, keyword, { page, order: opts.order, tid: opts.tid }, timeout) as CommandResp<{ total?: number; items?: SearchItem[] }>;
    } catch (err) {
      if (err instanceof ExtCommandError) throw new Error(`search page=${page} failed: ${err.extError}`);
      throw err;
    }
    const data = resp.result ?? {};
    if (page === 1) rawTotal = data.total ?? 0;
    const items = data.items ?? [];
    all.push(...items);
    if (items.length === 0) break;                       // 没更多结果
    if (rawTotal > 0 && all.length >= rawTotal) break;    // 拿够了
  }
  return { raw_total: rawTotal, items: all };
}

/** find 命令编排（纯函数，注入 client + fansSource + 选项；可测）。不含采字幕（--collect 在 action 层）。 */
export async function collectFind(
  client: CollectClient,
  clientId: string,
  keyword: string,
  opts: FindOpts,
  fansSrc: FansSource,
  timeout: number,
): Promise<FindResult> {
  const pages = opts.pages && opts.pages > 0 ? opts.pages : 3;
  const order = opts.order ?? 'pubdate';
  // 1. 多页搜索
  const { raw_total, items: raw } = await collectFindSearch(
    client, clientId, keyword, { order, tid: opts.tid, pages }, timeout,
  );
  // 2. pubdate 过滤
  const afterDateItems = filterByPubdate(raw, opts.since);
  // 3. 解析 fans（对去重 mid）
  const mids = afterDateItems.map((it) => it.mid).filter((m) => m != null).map(String);
  const { fans, cacheHit, fetched, unknown } = await resolveFans(mids, fansSrc);
  // 4. 把 fans 填回 + 按 fans 过滤
  const withFans: FindItem[] = afterDateItems.map((it) => ({
    ...it,
    fans: it.mid != null ? (fans.get(String(it.mid)) ?? null) : null,
  }));
  const finalItems = filterByFans(withFans, opts.minFans);
  return {
    keyword,
    tid: opts.tid,
    order,
    raw_total,
    fetched: raw.length,
    after_date: afterDateItems.length,
    after_fans: finalItems.length,
    fans_cache_hit: cacheHit,
    fans_fetched: fetched,
    fans_unknown: unknown,
    items: finalItems,
  };
}

// ── commander 装配 ──

/**
 * 统一 HTTP 错误归一化（对齐 clients.ts:90-101 模式 + collect 特有的 no online client 分支）：
 * - `ServerUnreachableError`（server 没开/ECONNREFUSED）→ `SERVER_UNREACHABLE`（退 3）。
 * - `ExtCommandError`（扩展命令失败：502 扩展执行失败 / 404 离线 / 504 超时）→ `RUNTIME`（退 1，透传扩展 error）。
 * - `ServerResponseError` status 404 → `NOT_FOUND`（退 5）；其余非 2xx → `RUNTIME`（退 1，带 status/body）。
 * - `no online client`（扩展未连）→ `ARGS`（退 2）。
 * - 其他：`RUNTIME`（退 1）。
 *
 * 返回 `never`：所有分支均经 emitError（process.exit）终结。
 */
function handleHttpError(err: unknown): never {
  if (err instanceof ServerUnreachableError) {
    emitError(err.message, 'SERVER_UNREACHABLE');
  }
  if (err instanceof ExtCommandError) {
    emitError(err.message, 'RUNTIME', { status: err.status, error: err.extError });
  }
  if (err instanceof ServerResponseError) {
    if (err.status === 404) {
      emitError(err.message, 'NOT_FOUND', { status: err.status, body: err.body });
    }
    emitError(err.message, 'RUNTIME', { status: err.status, body: err.body });
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/no online client/.test(msg)) emitError(msg, 'ARGS');
  emitError(msg, 'RUNTIME');
}

export function buildCollectCommand(): Command {
  const collect = new Command('collect');
  collect.description('主动采集（经 server→扩展，扩展内 fetch B 站）');

  collect
    .command('search <keyword>')
    .description('关键词搜视频，返回候选列表（不入库）')
    .option('--page <n>', '页码（默认 1）', (v) => Number.parseInt(v, 10), 1)
    .option('--order <o>', '排序（默认 pubdate）', 'pubdate')
    .option('--tid <id>', '分区 tid')
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '等扩展回执的超时毫秒（默认 180000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (keyword: string, opts: { page: number; order: string; tid?: string; client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const tid = opts.tid != null ? Number.parseInt(opts.tid, 10) : undefined;
        const data = await collectSearch(client as CollectClient, clientId, keyword, { page: opts.page, order: opts.order, tid }, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  collect
    .command('subtitle <bvid>')
    .description('采集单个视频字幕入库（扩展 fetch view+player+字幕体）')
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '超时毫秒（默认 180000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (bvid: string, opts: { client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = await collectSubtitle(client as CollectClient, clientId, bvid, opts.timeout);
        // 确认无字幕（扩展回执 reason=no_subtitle）→ 打 no-subtitle 系统标（远期 ASR 音频转字幕的定位锚点）。
        // 打标失败不阻断结果输出（视频行已入库；标可由下次重采或回填脚本补）。
        if ((data as { result?: { reason?: string } })?.result?.reason === 'no_subtitle') {
          try { await client.applyTags([bvid], [NO_SUBTITLE_TAG], 'system'); } catch { /* 下次补 */ }
        }
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  collect
    .command('dedupe <bvid...>')
    .description('批量判重：按 video 是否已入库分 collected/missing（直读 SQLite）')
    .action((bvids: string[]) => {
      const ctx = getCliContext();
      let db: Database.Database;
      try {
        db = openReadonlyDb(ctx.dbPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitError(msg, 'DB_UNREADABLE');
      }
      const data = collectDedupe(db, bvids);
      emitResult(data, ctx.format);
    });

  collect
    .command('season <arg>')
    .description('采集整个合集（ugc_season）全部视频字幕：BV 号（须已采过）/ 合集 id / 合集页链接 → 展开全量 → 未采的批量建任务（server 自动串行执行）')
    .option('--dry-run', '只列计划（missing 列表）,不建任务')
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '等扩展回执的超时毫秒（默认 180000,大合集页多耗时长）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (arg: string, opts: { dryRun?: boolean; client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      let db: Database.Database;
      try {
        db = openReadonlyDb(ctx.dbPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitError(msg, 'DB_UNREADABLE');
      }
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = await collectSeason(client as unknown as SeasonCollectClient, clientId, db, arg, {
          dryRun: opts.dryRun === true,
          timeout: opts.timeout,
        });
        emitResult(data, ctx.format);
      } catch (err) {
        // 旧扩展不认识新 action → 明确指向更新而非重试（对齐 server 侧 extNeedsUpdate 语义）
        if (err instanceof ExtCommandError && err.extError.includes('unknown action')) {
          emitError(`扩展版本过旧（不认识 list-season-videos）,请更新扩展后重试: ${err.extError}`, 'EXT_UPDATE');
        }
        handleHttpError(err);
      }
    });

  collect
    .command('upper-info <mid>')
    .description('采集 UP 主资料入库（扩展 fetch acc/info + relation/stat）')
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '超时毫秒（默认 180000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (mid: string, opts: { client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = await collectUpperInfo(client as CollectClient, clientId, mid, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  collect
    .command('upper-videos <mid>')
    .description('拉 UP 主视频列表（不入库；--all 全量翻页拉完）')
    .option('--page <n>', '页码（默认 1，--all 时忽略）', (v) => Number.parseInt(v, 10), 1)
    .option('--size <n>', '每页条数（默认 30）', (v) => Number.parseInt(v, 10), 30)
    .option('--all', '全量翻页拉完所有视频（默认仅首页）')
    .option('--since-created <unix>', '只保留发布时间 >= 该 UNIX 秒的视频（null 保留，--all 时生效）', (v) => Number.parseInt(v, 10))
    .option('--client <id>', '扩展 client_id')
    .option('--timeout <ms>', '超时毫秒（默认 180000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (mid: string, opts: { page: number; size: number; all?: boolean; sinceCreated?: number; client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = opts.all
          ? await collectUpperVideosAll(client as CollectClient, clientId, mid, opts.size, opts.timeout, opts.sinceCreated)
          : await collectUpperVideos(client as CollectClient, clientId, mid, { page: opts.page, size: opts.size }, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  collect
    .command('yt-videos <key>')
    .description('拉 YouTube 频道视频列表（@handle/UCxxx/频道页 URL；--collect 逐个采集未入库的字幕）')
    .option('--since-days <n>', '只保留近 N 天发布的视频（相对时间估算过滤；null 保留）', (v) => Number.parseInt(v, 10))
    .option('--collect', '对未入库视频逐个采集字幕（串行 navigate 采集，每条约 1 分钟，慢但稳）')
    .option('--refresh', '绕过扩展侧 1h 缓存强制重拉列表')
    .option('--sleep <ms>', '--collect 逐条采集间隔毫秒（默认 1500）', (v) => Number.parseInt(v, 10), 1500)
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '等扩展回执的超时毫秒（默认 180000，全量分页含节流需较久）', (v) => Number.parseInt(v, 10), 180000)
    .action(async (key: string, opts: { sinceDays?: number; collect?: boolean; refresh?: boolean; sleep: number; client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      if (opts.sinceDays != null && opts.sinceDays < 0) emitError(`invalid --since-days: ${opts.sinceDays}`, 'ARGS');
      let ident: YtChannelIdent;
      try {
        ident = parseYtChannelArg(key);
      } catch (err) {
        emitError(err instanceof Error ? err.message : String(err), 'ARGS');
      }
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        // 拉取失败（扩展执行失败等）抛 ExtCommandError → handleHttpError 统一退出
        const resp = await collectYtChannelVideos(client as CollectClient, clientId, ident, { refresh: opts.refresh }, opts.timeout) as CommandResp<{
          channel_id?: string;
          channel_name?: string;
          total?: number;
          items?: YtChannelVideoItem[];
          error?: string | null;
        }>;
        const d = resp.result ?? {};
        // since-days 过滤：null created 保留（YouTube 相对时间解析失败时防漏采）
        const sinceUnix = opts.sinceDays != null ? Math.floor(Date.now() / 1000) - opts.sinceDays * 86400 : null;
        const items = sinceUnix != null
          ? (d.items ?? []).filter((it) => it.created == null || it.created >= sinceUnix)
          : (d.items ?? []);
        const collectedSummary = { channel_id: d.channel_id, channel_name: d.channel_name, total: d.total ?? null, count: items.length };
        if (!opts.collect) {
          emitResult({ ...collectedSummary, items }, ctx.format);
        } else {
          const vids = items.map((it) => it.vid).filter(Boolean);
          let db: Database.Database;
          try { db = openReadonlyDb(ctx.dbPath); } catch (err) {
            emitError(err instanceof Error ? err.message : String(err), 'DB_UNREADABLE');
          }
          const collected = await collectYtVideosRun(client as CollectClient, clientId, db, vids, opts.sleep, opts.timeout);
          const { collected: already } = collectDedupe(db, vids, 'youtube');
          emitResult({ ...collectedSummary, collected_now: collected.length, already_in_db: already.length, results: collected }, ctx.format);
        }
      } catch (err) {
        handleHttpError(err);
      }
    });

  collect
    .command('new-videos <mid>')
    .description('发现 UP 主新视频：拉列表 + 对比库 → 返回 new/collected')
    .option('--page <n>', '页码（默认 1）', (v) => Number.parseInt(v, 10), 1)
    .option('--size <n>', '每页条数（默认 30）', (v) => Number.parseInt(v, 10), 30)
    .option('--client <id>', '扩展 client_id')
    .option('--timeout <ms>', '超时毫秒（默认 180000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (mid: string, opts: { page: number; size: number; client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      let db: Database.Database;
      try {
        db = openReadonlyDb(ctx.dbPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitError(msg, 'DB_UNREADABLE');
      }
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = await collectNewVideos(client as CollectClient, clientId, mid, db, { page: opts.page, size: opts.size }, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  collect
    .command('discover <mid...>')
    .description('批量多 UP 主发现新视频：每 UP 拉列表 + 对比库 → 汇总 per_mid + all_new')
    .option('--page <n>', '页码（默认 1）', (v) => Number.parseInt(v, 10), 1)
    .option('--size <n>', '每页条数（默认 30）', (v) => Number.parseInt(v, 10), 30)
    .option('--client <id>', '扩展 client_id')
    .option('--timeout <ms>', '超时毫秒（默认 180000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (mids: string[], opts: { page: number; size: number; client?: string; timeout: number }) => {
      if (mids.length === 0) emitError('at least one <mid> required', 'ARGS');
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      let db: Database.Database;
      try { db = openReadonlyDb(ctx.dbPath); } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitError(msg, 'DB_UNREADABLE');
      }
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = await collectDiscover(client as CollectClient, clientId, db, mids, { page: opts.page, size: opts.size }, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) { handleHttpError(err); }
    });

  collect
    .command('find <keyword>')
    .description('条件检索：关键词(+分区) 多页搜索，按发布时间/UP 粉丝数过滤出候选（fans 优先读 creators 表缓存，miss 实时查）')
    .option('--tid <id>', '分区 tid（⚠ 实测 search API 忽略 tid，当前不生效；分区收敛请用关键词。保留供未来 post-filter 改造）', (v) => Number.parseInt(v, 10))
    .option('--order <o>', '排序（默认 pubdate 最新）', 'pubdate')
    .option('--pages <n>', '翻多少页候选（默认 3，每页约 20 条）', (v) => Number.parseInt(v, 10), 3)
    .option('--min-fans <n>', '最低 UP 主粉丝数（默认 0=不过滤）', (v) => Number.parseInt(v, 10), 0)
    .option('--since <YYYY-MM-DD>', '发布日期下限（本地时区 00:00；与 --since-days 互斥，优先 --since）')
    .option('--since-days <n>', '近 N 天发布的视频（与 --since 互斥）', (v) => Number.parseInt(v, 10))
    .option('--collect', '命中候选后串行采字幕入库（默认仅列候选）')
    .option('--no-cache', '忽略 creators 表 fans 缓存，全部实时查（用于刷新粉丝数）')
    .option('--sleep <ms>', '实时查 fans / 采字幕 的间隔毫秒（默认 600）', (v) => Number.parseInt(v, 10), 600)
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '等扩展回执的超时毫秒（默认 180000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (keyword: string, opts: {
      tid?: number; order: string; pages: number; minFans: number;
      since?: string; sinceDays?: number; collect?: boolean; cache?: boolean; sleep: number;
      client?: string; timeout: number;
    }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      if (opts.minFans < 0) emitError(`invalid --min-fans: ${opts.minFans}`, 'ARGS');
      // since 解析：--since（YYYY-MM-DD）优先；其次 --since-days（天）。都没则不过滤发布时间。
      const sinceUnix = opts.since != null
        ? parseDateToUnix(opts.since)
        : parseSince({ sinceDays: opts.sinceDays });
      if (opts.since != null && sinceUnix == null) emitError(`invalid --since: ${opts.since}（需 YYYY-MM-DD）`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const dbPath = ctx.dbPath;
        const sleepMs = opts.sleep;
        // fans 来源：DB 缓存（--no-cache 跳过）+ 实时 get-upper-info（带 sleep 防风控）。
        const fansSrc: FansSource = {
          async readFansFromDb(mids) {
            if (opts.cache === false || mids.length === 0) return {};
            try {
              const db = openReadonlyDb(dbPath);
              try {
                const placeholders = mids.map(() => '?').join(',');
                const rows = db.prepare(
                  `SELECT source_uid, fans FROM creators WHERE source='bilibili' AND source_uid IN (${placeholders})`,
                ).all(...mids) as Array<{ source_uid: string; fans: number | null }>;
                const out: Record<string, number> = {};
                for (const r of rows) if (r.fans != null && r.fans > 0) out[String(r.source_uid)] = r.fans;
                return out;
              } finally { db.close(); }
            } catch {
              return {}; // DB 读失败降级：全部实时查
            }
          },
          async fetchFans(mid) {
            // 实时查失败（扩展执行失败 → 502）→ fans 未知（null，保守保留候选）；传输层错误原样上抛
            let resp: CommandResp<{ fans?: number }>;
            try {
              resp = await collectUpperInfo(client as CollectClient, clientId, mid, opts.timeout) as CommandResp<{ fans?: number }>;
            } catch (err) {
              if (err instanceof ExtCommandError) return null;
              throw err;
            }
            await new Promise((r) => setTimeout(r, sleepMs)); // 防风控
            const f = resp.result?.fans;
            return f != null && f > 0 ? f : null;
          },
        };
        const data = await collectFind(client as CollectClient, clientId, keyword,
          { pages: opts.pages, order: opts.order, tid: opts.tid, minFans: opts.minFans, since: sinceUnix },
          fansSrc, opts.timeout);
        // --collect：对最终候选串行采字幕入库（sleep>=1s 防风控；失败分类见 classifyCollectError）。
        if (opts.collect && data.items.length > 0) {
          const collected: Array<{ bvid: string; ok: boolean; reason?: string }> = [];
          const noSubtitleBvids: string[] = []; // 确认无字幕清单，收尾一次性打 no-subtitle 系统标
          for (const it of data.items) {
            let extError: string | undefined;
            let sdata: { reason?: string; tracks?: number } | undefined;
            try {
              const resp = await collectSubtitle(client as CollectClient, clientId, it.bvid, opts.timeout) as CommandResp<{ reason?: string; tracks?: number }>;
              sdata = resp.result;
            } catch (err) {
              extError = classifyCollectError(err, it.bvid);
            }
            if (!extError && sdata?.reason === 'no_subtitle') noSubtitleBvids.push(it.bvid);
            collected.push({
              bvid: it.bvid,
              ok: !extError && sdata?.reason !== 'no_subtitle',
              reason: extError ?? sdata?.reason,
            });
            await new Promise((r) => setTimeout(r, Math.max(sleepMs, 1000)));
          }
          // no-subtitle 系统标：远期 ASR 定位锚点。批量一次打，失败不阻断（可重采/回填补）。
          if (noSubtitleBvids.length > 0) {
            try { await client.applyTags(noSubtitleBvids, [NO_SUBTITLE_TAG], 'system'); } catch { /* 下次补 */ }
          }
          (data as FindResult & { collected?: unknown }).collected = collected;
        }
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  return collect;
}
