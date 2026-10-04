// collect-find worker（CLI 全功能 web 化 Phase 4）：把 CLI `collect find`（条件检索博主发现，
// B 站专属）编排搬进 server 进程。管线对齐 cli/commands/collect.ts 的 collectFind：
// 多页 search（页间 sleep 防风控）→ since_days 发布时间过滤 → fans 过滤 → （可选）批量建采集任务。
// 与 CLI 的两处刻意的差异（都是 server 化后的正确形态，非行为漂移）：
//   1. fans 只读 server 库 creators 表缓存（CLI 的实时 get-upper-info 逐 mid 补查是 CLI 交互形态的
//      产物——server 任务里对几十个 mid 串行实时查会把任务拖到分钟级；无缓存 = fans 未知，
//      保守保留候选 + unknown_fans 计数，web 端人工复核）。
//   2. collect=true 建任务（POST /api/collect-tasks/batch 同款 createTasksBatch：去重/has-subtitle
//      跳过/batch_id 语义全复用），实际采集由既有 task 调度器派发——不在本任务里同步采。
// tid 传给 search action（扩展 background.js 转发到 B 站 API；CLI --tid 同参透传）。
import type Database from 'better-sqlite3';
import { requestCommand, listOnlineClients } from '../ws/server.js';
import {
  DEFAULT_COLLECT_TIMEOUT_MS, filterByPubdate, parseSince,
  type SearchItem, type FindItem,
} from '../cli/commands/collect.js';
import { createTasksBatch, kickTaskScheduler } from '../tasks/tasks.js';
import { querySubtitleExists } from '../http/queries.js';
import type { JobCtx } from './runner.js';

// 提交参数（http/jobs.ts 校验后入队；worker 内防御性归一双保险）
export interface CollectFindParams {
  keyword: string;      // 必填 ≤100
  pages?: number;       // 1..5，默认 1
  min_fans?: number;    // >=0，可选
  max_fans?: number;    // >=0，可选
  since_days?: number;  // 1..365，可选
  tid?: number;         // 分区 tid（此次真正生效：随 search action 下发）
  collect?: boolean;    // 命中候选批量建采集任务（默认仅列候选）
  client_id?: string;   // 指定扩展（缺省第一个在线）
}

// 终态产物（result_json）。items = 过滤后候选（截前 100）+ fans/exists/has_subtitle 标注
export interface CollectFindResult {
  keyword: string;
  pages_fetched: number;
  raw_total: number;      // 首页 B 站声称的总匹配数
  candidates: number;     // 多页合并后的候选条数
  filtered_since: number; // 发布时间过滤剔除数
  filtered_fans: number;  // fans 过滤剔除数
  unknown_fans: number;   // fans 未知（无 creators 行）的 unique mid 数
  collected?: { created: number; skipped: number }; // collect=true 时的建任务结果
  items: Array<FindItem & { exists: boolean; has_subtitle: boolean }>;
}

// 依赖注入（测试 mock；缺省真实现——对齐 collect-proxy 的工厂口径）
export interface CollectFindJobDeps {
  requestCommand?: typeof requestCommand;
  listOnlineClients?: () => Array<{ client_id: string }>;
  sleep?: (ms: number) => Promise<void>;
}

// 页间 sleep：2-4s 随机（固定间隔特征太机械，防风控；对齐 CLI find 的防风控意识）
const PAGE_SLEEP_MIN_MS = 2000;
const PAGE_SLEEP_RANGE_MS = 2000;

function clampInt(v: unknown, min: number, max: number, dft: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) return dft;
  return Math.min(v, max);
}

// 单页 search：下发扩展 `search` action 并守卫回执结构（传输层/执行失败/结构漂移各自归因上抛 → job failed）
async function searchPage(
  doRequest: typeof requestCommand,
  clientId: string,
  keyword: string,
  page: number,
  tid?: number,
): Promise<{ total: number; items: SearchItem[] }> {
  const startedAt = Date.now();
  const params: Record<string, unknown> = { keyword, page, order: 'pubdate', ...(tid != null ? { tid } : {}) };
  const r = await doRequest(clientId, 'search', params, DEFAULT_COLLECT_TIMEOUT_MS);
  const elapsed = Date.now() - startedAt;
  if (!r.ok) {
    const reason = r.code === 'offline' ? `扩展离线（${clientId}）` : `扩展回执超时（${DEFAULT_COLLECT_TIMEOUT_MS}ms）`;
    throw new Error(`search page=${page} ${reason}`);
  }
  if (r.result?.ok !== true) {
    throw new Error(`search page=${page} 扩展执行失败: ${String(r.result?.error ?? 'unknown')}`);
  }
  const data = r.result.data as { total?: unknown; items?: unknown } | null | undefined;
  if (data == null || !Array.isArray(data.items)) {
    const keys = data != null && typeof data === 'object' ? Object.keys(data).join(',') : String(data);
    throw new Error(`search page=${page} 回执结构异常（items 非数组）dataKeys=${keys}`);
  }
  console.log(`[jobs:find] search page=${page} client=${clientId} items=${data.items.length} total=${String(data.total ?? '?')} (${elapsed}ms)`);
  return {
    total: typeof data.total === 'number' ? data.total : 0,
    items: data.items as SearchItem[],
  };
}

// fans 只读 creators 表缓存（source='bilibili'，fans>0 才算有效——对齐 CLI readFansFromDb 口径）
function readFansFromDb(db: Database.Database, mids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < mids.length; i += 500) {
    const chunk = mids.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT source_uid, fans FROM creators WHERE source='bilibili' AND source_uid IN (${placeholders})`,
    ).all(...chunk) as Array<{ source_uid: string; fans: number | null }>;
    for (const r of rows) if (r.fans != null && r.fans > 0) out.set(String(r.source_uid), r.fans);
  }
  return out;
}

// min/max fans 谓词：fans 未知（null）保守保留；min/max<=0 视为不过滤该侧
function passesFans(fans: number | null | undefined, minFans: number, maxFans: number): boolean {
  if (fans == null) return true;
  if (minFans > 0 && fans < minFans) return false;
  if (maxFans > 0 && fans > maxFans) return false;
  return true;
}

// worker 参数归一（http/jobs.ts 校验后入队，此处防御性归一双保险；非法值 → CLI 同源缺省/忽略）
interface NormalizedFindParams {
  keyword: string;
  pages: number;
  minFans: number;
  maxFans: number;
  sinceDays?: number;
  tid?: number;
  collect: boolean;
}

function normalizeFindParams(rawParams: Record<string, unknown>): NormalizedFindParams {
  const p = (rawParams ?? {}) as unknown as CollectFindParams;
  return {
    keyword: typeof p.keyword === 'string' ? p.keyword : '',
    pages: clampInt(p.pages, 1, 5, 1),
    minFans: typeof p.min_fans === 'number' && p.min_fans > 0 ? p.min_fans : 0,
    maxFans: typeof p.max_fans === 'number' && p.max_fans > 0 ? p.max_fans : 0,
    sinceDays: typeof p.since_days === 'number' && p.since_days > 0 ? p.since_days : undefined,
    tid: typeof p.tid === 'number' && p.tid > 0 ? p.tid : undefined,
    collect: p.collect === true,
  };
}

// 执行扩展选择：显式 client_id 优先，缺省取第一个在线扩展；两者皆无 → 抛错（任务失败归因）
function resolveClientId(p: CollectFindParams, doListClients: () => Array<{ client_id: string }>): string {
  const explicit = typeof p.client_id === 'string' && p.client_id ? p.client_id : null;
  const clientId = explicit ?? doListClients()[0]?.client_id ?? null;
  if (!clientId) throw new Error('no online client（扩展未连接，先确认浏览器已装扩展并已连 server）');
  return clientId;
}

// ── 1. 多页搜索（空页/拿够 raw_total 提前终止；页间 sleep 防风控）──
async function searchAllPages(
  ctx: JobCtx,
  doRequest: typeof requestCommand,
  sleep: (ms: number) => Promise<void>,
  clientId: string,
  params: NormalizedFindParams,
): Promise<{ all: SearchItem[]; rawTotal: number; pagesFetched: number }> {
  const all: SearchItem[] = [];
  let rawTotal = 0;
  let pagesFetched = 0;
  for (let page = 1; page <= params.pages; page++) {
    const { total, items } = await searchPage(doRequest, clientId, params.keyword, page, params.tid);
    pagesFetched = page;
    if (page === 1) rawTotal = total;
    all.push(...items);
    ctx.onProgress({ stage: 'search', pages_fetched: pagesFetched, candidates: all.length });
    if (items.length === 0) break;
    if (rawTotal > 0 && all.length >= rawTotal) break;
    if (page < params.pages) await sleep(PAGE_SLEEP_MIN_MS + Math.floor(Math.random() * (PAGE_SLEEP_RANGE_MS + 1)));
  }
  return { all, rawTotal, pagesFetched };
}

// ── 2+3. since_days 发布时间过滤（pubdate null 保留）+ fans 过滤（库缓存 only；无行=未知 → 保留+计数）
function filterPipeline(
  ctx: JobCtx,
  all: SearchItem[],
  params: NormalizedFindParams,
): { afterFans: Array<FindItem & { fans: number | null }>; afterDate: number; filteredSince: number; filteredFans: number; unknownFans: number } {
  const sinceUnix = parseSince({ sinceDays: params.sinceDays });
  const afterDate = filterByPubdate(all, sinceUnix);
  const filteredSince = all.length - afterDate.length;
  const mids = [...new Set(afterDate.map((it) => String(it.mid ?? '')).filter(Boolean))];
  const fansMap = readFansFromDb(ctx.db, mids);
  const unknownFans = mids.filter((m) => !fansMap.has(m)).length;
  const annotated: Array<FindItem & { fans: number | null }> = afterDate.map((it) => ({ ...it, fans: fansMap.get(String(it.mid ?? '')) ?? null }));
  const afterFans = annotated.filter((it) => passesFans(it.fans, params.minFans, params.maxFans));
  const filteredFans = annotated.length - afterFans.length;
  return { afterFans, afterDate: afterDate.length, filteredSince, filteredFans, unknownFans };
}

// ── 4. collect=true → 批量建采集任务（createTasksBatch 全套去重语义复用；调度器异步派发）──
function collectTasks(ctx: JobCtx, afterFans: Array<{ bvid: string }>, clientId: string): CollectFindResult['collected'] {
  const vids = afterFans.map((it) => it.bvid);
  const r = createTasksBatch(ctx.db, vids, 'bilibili', clientId, null, false);
  const collected = { created: r.created.length, skipped: r.skipped.length + r.skippedCollected.length };
  console.log(`[jobs:find job=${ctx.jobId}] collect 建 ${collected.created} 跳 ${collected.skipped}（active 在途 ${r.skipped.length} / 已有字幕 ${r.skippedCollected.length}）`);
  if (r.created.length > 0) kickTaskScheduler();
  return collected;
}

// worker 主入口（runner 按 type='collect-find' 分派）
export async function runCollectFindJob(
  ctx: JobCtx,
  rawParams: Record<string, unknown>,
  deps: CollectFindJobDeps = {},
): Promise<CollectFindResult> {
  const doRequest = deps.requestCommand ?? requestCommand;
  const doListClients = deps.listOnlineClients ?? listOnlineClients;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const params = normalizeFindParams(rawParams);
  if (!params.keyword) throw new Error('keyword: non-empty string required');
  const clientId = resolveClientId((rawParams ?? {}) as unknown as CollectFindParams, doListClients);
  console.log(`[jobs:find job=${ctx.jobId}] 执行 keyword=${JSON.stringify(params.keyword)} pages=${params.pages} min_fans=${params.minFans} max_fans=${params.maxFans}${params.sinceDays != null ? ` since_days=${params.sinceDays}` : ''}${params.tid != null ? ` tid=${params.tid}` : ''} collect=${params.collect} client=${clientId}`);

  const { all, rawTotal, pagesFetched } = await searchAllPages(ctx, doRequest, sleep, clientId, params);

  // ── 2+3. 发布时间过滤 + fans 过滤（fans 未知保守保留 + unknown_fans 计数）──
  const { afterFans, afterDate, filteredSince, filteredFans, unknownFans } = filterPipeline(ctx, all, params);
  ctx.onProgress({ stage: 'filter', pages_fetched: pagesFetched, candidates: all.length, filtered_since: filteredSince, filtered_fans: filteredFans, unknown_fans: unknownFans, after_fans: afterFans.length });

  // ── 4. collect=true → 批量建采集任务（过滤后零候选不建不落键）──
  const collected = params.collect && afterFans.length > 0 ? collectTasks(ctx, afterFans, clientId) : undefined;

  // ── 5. 候选标注（exists/has_subtitle 复用 check-exists SQL；items 截前 100 控 result_json 体积）──
  const byVid = querySubtitleExists(ctx.db, 'bilibili', afterFans.map((it) => it.bvid));
  const items = afterFans.slice(0, 100).map((it) => {
    const has = byVid.get(it.bvid);
    return { ...it, exists: has !== undefined, has_subtitle: has === true };
  });
  const inDb = items.filter((it) => it.exists).length;
  console.log(`[jobs:find job=${ctx.jobId}] 完成 pages=${pagesFetched} raw_total=${rawTotal} candidates=${all.length} after_date=${afterDate} after_fans=${afterFans.length} unknown_fans=${unknownFans} in_db=${inDb}`);
  return {
    keyword: params.keyword,
    pages_fetched: pagesFetched,
    raw_total: rawTotal,
    candidates: all.length,
    filtered_since: filteredSince,
    filtered_fans: filteredFans,
    unknown_fans: unknownFans,
    ...(collected ? { collected } : {}),
    items,
  };
}
