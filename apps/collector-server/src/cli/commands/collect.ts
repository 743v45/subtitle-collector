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
const DEFAULT_COLLECT_TIMEOUT_MS = 15000;

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
export async function collectUpperVideosAll(
  client: CollectClient,
  clientId: string,
  mid: string,
  size: number,
  timeout: number,
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
  // 用最后一次外层包装 + 合并后的全量 data，保持与单页输出形状一致。
  return {
    ...(lastResp ?? { ok: true }),
    result: {
      ...(lastResp?.result ?? { ok: true }),
      ok: true,
      data: { total, items: allItems },
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
    .option('--client <id>', '扩展 client_id')
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (mid: string, opts: { page: number; size: number; all?: boolean; client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = opts.all
          ? await collectUpperVideosAll(client as CollectClient, clientId, mid, opts.size, opts.timeout)
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

  return collect;
}
