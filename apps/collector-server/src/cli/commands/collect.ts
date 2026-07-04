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

  return collect;
}
