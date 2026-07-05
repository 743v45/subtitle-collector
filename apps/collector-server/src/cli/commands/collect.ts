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
import { getCliContext } from '../main.js';
import { openReadonlyDb } from '../db.js';

/** 采集类命令默认超时（高于管控类 5000，给扩展 fetch+入库留时间）。 */
const DEFAULT_COLLECT_TIMEOUT_MS = 30000; // 主动采集 navigate（充电视频）需等被动 INGEST ~20s + 间隔，15s 不够

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
  return client.sendCommand(clientId, 'search', params, timeout);
}

/** `collect subtitle <bvid>`：下发 fetch-subtitle，扩展 fetch view+player+字幕体→ingest。 */
export async function collectSubtitle(
  client: CollectClient,
  clientId: string,
  bvid: string,
  timeout: number,
): Promise<unknown> {
  return client.sendCommand(clientId, 'fetch-subtitle', { bvid }, timeout);
}

/** `collect dedupe <bvid...>`：直读 SQLite，判据=video 是否存在（无字幕视频采过后也入 videos）。 */
export function collectDedupe(
  db: Database.Database,
  bvids: string[],
): { collected: string[]; missing: string[] } {
  if (bvids.length === 0) return { collected: [], missing: [] };
  const placeholders = bvids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT source_vid FROM videos WHERE source = 'bilibili' AND source_vid IN (${placeholders})`,
  ).all(...bvids) as Array<{ source_vid: string }>;
  const set = new Set(rows.map((r) => r.source_vid));
  const collected: string[] = [];
  const missing: string[] = [];
  for (const b of bvids) (set.has(b) ? collected : missing).push(b);
  return { collected, missing };
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

/** `collect upper-info <mid>`：下发 get-upper-info，扩展 fetch acc/info+stat → ingest-upper 入库。 */
export async function collectUpperInfo(
  client: CollectClient,
  clientId: string,
  mid: string,
  timeout: number,
): Promise<unknown> {
  return client.sendCommand(clientId, 'get-upper-info', { mid }, timeout);
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

/** list-upper-videos 扩展回执形状（外层 server 包装 + result.data 列表）。 */
export interface UpperVideosResp {
  ok: boolean;
  client_id?: string;
  action?: string;
  result?: {
    type?: string;
    id?: string;
    ok: boolean;
    error?: string;
    data?: { total?: number; items?: UpperVideoItem[] };
  };
}

/** `collect upper-videos <mid>`：下发 list-upper-videos，返回视频列表（不入库）。 */
export async function collectUpperVideos(
  client: CollectClient,
  clientId: string,
  mid: string,
  opts: UpperVideosOpts,
  timeout: number,
): Promise<unknown> {
  return client.sendCommand(clientId, 'list-upper-videos',
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
    const resp = await client.sendCommand(clientId, 'list-upper-videos',
      { mid, page, page_size: size }, timeout) as UpperVideosResp;
    if (!resp.ok || !resp.result?.ok) {
      throw new Error(`list-upper-videos page=${page} failed: ${resp.result?.error ?? 'server error'}`);
    }
    lastResp = resp;
    const data = resp.result?.data ?? {};
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
    result: {
      ...(lastResp?.result ?? { ok: true }),
      ok: true,
      data: { total: resultTotal, items: filtered },
    },
  };
}

/** `collect new-videos <mid>`：拉 UP 主视频列表（经扩展）+ 直读 SQLite 对比 → 返回 new/collected。 */
export async function collectNewVideos(
  client: CollectClient,
  clientId: string,
  mid: string,
  db: Database.Database,
  opts: UpperVideosOpts,
  timeout: number,
): Promise<{ total: number; new: string[]; collected: string[] }> {
  const resp = await collectUpperVideos(client, clientId, mid, opts, timeout) as {
    ok: boolean; result?: { ok: boolean; error?: string; data?: { total?: number; items?: Array<{ bvid: string }> } };
  };
  if (!resp.ok || !resp.result?.ok) {
    throw new Error(`list-upper-videos failed: ${resp.result?.error ?? 'server error'}`);
  }
  const items = resp.result?.data?.items ?? [];
  const bvids = items.map((it) => it.bvid).filter(Boolean);
  if (bvids.length === 0) return { total: resp.result?.data?.total ?? 0, new: [], collected: [] };
  const placeholders = bvids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT source_vid FROM videos WHERE source = 'bilibili' AND source_vid IN (${placeholders})`,
  ).all(...bvids) as Array<{ source_vid: string }>;
  const set = new Set(rows.map((r) => r.source_vid));
  const collected: string[] = [];
  const newArr: string[] = [];
  for (const b of bvids) (set.has(b) ? collected : newArr).push(b);
  return { total: resp.result?.data?.total ?? bvids.length, new: newArr, collected };
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
 *  提前终止：某页 items 为空、或累计达 raw_total、或翻满 pages。 */
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
    const resp = await collectSearch(client, clientId, keyword, { page, order: opts.order, tid: opts.tid }, timeout) as {
      ok: boolean; result?: { ok: boolean; error?: string; data?: { total?: number; items?: SearchItem[] } };
    };
    if (!resp.ok || !resp.result?.ok) {
      throw new Error(`search page=${page} failed: ${resp.result?.error ?? 'server error'}`);
    }
    const data = resp.result.data ?? {};
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
    .option('--timeout <ms>', '等扩展回执的超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
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
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (bvid: string, opts: { client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = await collectSubtitle(client as CollectClient, clientId, bvid, opts.timeout);
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
    .command('upper-info <mid>')
    .description('采集 UP 主资料入库（扩展 fetch acc/info + relation/stat）')
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
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
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
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
    .command('new-videos <mid>')
    .description('发现 UP 主新视频：拉列表 + 对比库 → 返回 new/collected')
    .option('--page <n>', '页码（默认 1）', (v) => Number.parseInt(v, 10), 1)
    .option('--size <n>', '每页条数（默认 30）', (v) => Number.parseInt(v, 10), 30)
    .option('--client <id>', '扩展 client_id')
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
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
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
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
    .option('--timeout <ms>', '等扩展回执的超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
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
            const resp = await collectUpperInfo(client as CollectClient, clientId, mid, opts.timeout) as {
              ok: boolean; result?: { ok: boolean; data?: { fans?: number }; error?: string };
            };
            await new Promise((r) => setTimeout(r, sleepMs)); // 防风控
            if (!resp.ok || !resp.result?.ok) return null;
            const f = resp.result.data?.fans;
            return f != null && f > 0 ? f : null;
          },
        };
        const data = await collectFind(client as CollectClient, clientId, keyword,
          { pages: opts.pages, order: opts.order, tid: opts.tid, minFans: opts.minFans, since: sinceUnix },
          fansSrc, opts.timeout);
        // --collect：对最终候选串行采字幕入库（sleep>=1s 防风控；遇 need_login/risk_control 即停）。
        if (opts.collect && data.items.length > 0) {
          const collected: Array<{ bvid: string; ok: boolean; reason?: string }> = [];
          for (const it of data.items) {
            const out = await collectSubtitle(client as CollectClient, clientId, it.bvid, opts.timeout) as {
              result?: { error?: string; data?: { reason?: string; tracks?: number } };
            };
            const err = out.result?.error;
            if (err === 'need_login' || err === 'risk_control') {
              emitError(`collect ${it.bvid} STOP: ${err}（请处理后重跑）`, 'RUNTIME');
            }
            collected.push({
              bvid: it.bvid,
              ok: !err && out.result?.data?.reason !== 'no_subtitle',
              reason: err ?? out.result?.data?.reason,
            });
            await new Promise((r) => setTimeout(r, Math.max(sleepMs, 1000)));
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
