// collect yt-search 命令组：YouTube 关键词搜索（类 bilibili collect search，2026-08-24）。
// 链路：CLI → server 透传 WS action "yt-search" → 扩展 fetch 结果页 SSR HTML + InnerTube search
// 续页（经 youtube tab）→ 回执候选。--since-days 相对时间过滤（null 保留）→ --collect 对未入库
// 串行采集（复用 collectYtVideosRun：判重 + sleep 防风控 + 失败分类）。
// 扩展侧解析/编排见 apps/subtitle-collector/yt-search.mjs（本文件只做 CLI 胶水）。
// 措辞：字幕（subtitle），非弹幕。
import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { ServerClient } from '../http.js';
import { emitResult, emitError } from '../output.js';
import { getCliContext } from '../context.js';
import { openReadonlyDb } from '../db.js';
import {
  type CollectClient,
  type CommandResp,
  DEFAULT_COLLECT_TIMEOUT_MS,
  resolveClientId,
  sendExtCommand,
  collectYtVideosRun,
  collectDedupe,
  handleHttpError,
} from './collect.js';

/** 单条搜索候选（扩展 yt-search 回执 data.items 形状，对齐 YtChannelVideoItem）。 */
export interface YtSearchItem {
  vid: string;
  title?: string | null;
  created?: number | null; // unix 秒（publishedTimeText 相对时间估算）
  play?: number | null;
  length?: string | null;
  pic?: string | null;
}

/** yt-search 命令选项（commander 层映射）。 */
export interface YtSearchOpts { order?: string; pages?: number; }

/** `collect yt-search <keyword>`：下发 yt-search action，成功响应体原样透传。 */
export async function collectYtSearch(
  client: CollectClient,
  clientId: string,
  keyword: string,
  opts: YtSearchOpts,
  timeout: number,
): Promise<unknown> {
  return sendExtCommand(client, clientId, 'yt-search',
    { keyword, order: opts.order ?? 'relevance', pages: opts.pages ?? 1 }, timeout);
}

/** --since-days 过滤：sinceUnix 为空 → 不过滤；created==null 保留（相对时间解析失败防漏采，
 *  对齐 collect yt-videos 的过滤口径）。 */
export function filterYtBySince(items: YtSearchItem[], sinceUnix: number | null): YtSearchItem[] {
  if (sinceUnix == null) return items;
  return items.filter((it) => it.created == null || it.created >= sinceUnix);
}

/** 参数校验 + since-days 归一（非法走 emitError ARGS 退 2；返回发布时间下限 UNIX 秒或 null）。 */
export function validateYtSearchArgs(opts: {
  order: string; pages: number; sinceDays?: number; timeout: number;
}): number | null {
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
  if (opts.sinceDays != null && opts.sinceDays < 0) emitError(`invalid --since-days: ${opts.sinceDays}`, 'ARGS');
  if (opts.pages < 1 || opts.pages > 10) emitError(`invalid --pages: ${opts.pages}（1-10）`, 'ARGS');
  if (!['relevance', 'newest', 'views'].includes(opts.order)) {
    emitError(`invalid --order: ${opts.order}（relevance | newest | views）`, 'ARGS');
  }
  return opts.sinceDays != null ? Math.floor(Date.now() / 1000) - opts.sinceDays * 86400 : null;
}

/** --collect 编排：判重（已入库跳过）→ 串行 fetch-youtube-subtitle（collectYtVideosRun 内
 *  sleep 防风控 + 失败分类）→ 汇总字段。 */
async function ytSearchCollect(
  client: CollectClient,
  clientId: string,
  db: Database.Database,
  items: YtSearchItem[],
  sleepMs: number,
  timeout: number,
): Promise<Record<string, unknown>> {
  const vids = items.map((it) => it.vid).filter(Boolean);
  const collected = await collectYtVideosRun(client, clientId, db, vids, sleepMs, timeout);
  const { collected: already } = collectDedupe(db, vids, 'youtube');
  return { collected_now: collected.length, already_in_db: already.length, results: collected };
}

/** commander 装配（在 collect.ts buildCollectCommand 注册，保持主命令文件薄）。 */
export function buildYtSearchCommand(): Command {
  const cmd = new Command('yt-search');
  cmd.description('YouTube 关键词搜视频，返回候选列表（不入库；--collect 对未入库逐个采集）')
    .argument('<keyword>', '搜索关键词')
    .option('--order <o>', '排序：relevance（默认）| newest（最新上传）| views（播放量）', 'relevance')
    .option('--pages <n>', '翻多少页（默认 1，每页约 20 条；上限 10）', (v) => Number.parseInt(v, 10), 1)
    .option('--since-days <n>', '只保留近 N 天发布的视频（相对时间估算过滤；null 保留）', (v) => Number.parseInt(v, 10))
    .option('--collect', '对未入库视频逐个采集字幕（串行 navigate 采集，每条约 1 分钟，慢但稳）')
    .option('--sleep <ms>', '--collect 逐条采集间隔毫秒（默认 1500）', (v) => Number.parseInt(v, 10), 1500)
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '等扩展回执的超时毫秒（默认 180000，多页含节流需较久）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (keyword: string, opts: {
      order: string; pages: number; sinceDays?: number; collect?: boolean; sleep: number;
      client?: string; timeout: number;
    }) => {
      const sinceUnix = validateYtSearchArgs(opts);
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const resp = await collectYtSearch(client as CollectClient, clientId, keyword,
          { order: opts.order, pages: opts.pages }, opts.timeout) as CommandResp<{
            raw_total?: number | null; pages_fetched?: number; items?: YtSearchItem[];
            diag?: Record<string, unknown>;
          }>;
        const d = resp.result ?? {};
        const items = filterYtBySince(d.items ?? [], sinceUnix);
        const summary = {
          keyword, order: opts.order,
          raw_total: d.raw_total ?? null, pages_fetched: d.pages_fetched ?? 1,
          count: items.length, items,
          // 解析命中计数透传（§9 可观察性：0 命中/结构漂移时先看它，不盲猜）
          diag: d.diag ?? null,
        };
        if (!opts.collect) {
          emitResult(summary, ctx.format);
        } else {
          let db: Database.Database;
          try { db = openReadonlyDb(ctx.dbPath); } catch (err) {
            emitError(err instanceof Error ? err.message : String(err), 'DB_UNREADABLE');
          }
          const extra = await ytSearchCollect(client as CollectClient, clientId, db, items, opts.sleep, opts.timeout);
          emitResult({ ...summary, ...extra }, ctx.format);
        }
      } catch (err) {
        // 旧扩展不认识 yt-search action → 明确指向更新（对齐 season 的 EXT_UPDATE 语义）
        if (err instanceof Error && err.message.includes('unknown action')) {
          emitError(`扩展版本过旧（不认识 yt-search）,请更新扩展后重试: ${err.message}`, 'EXT_UPDATE');
        }
        handleHttpError(err);
      }
    });
  return cmd;
}
