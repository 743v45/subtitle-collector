// tags 命令组：视频标签（list / apply / remove）。
// 读写分工遵循 CLI 不变量（db.ts:1-2）：list 直连只读 SQLite；apply/remove 是写操作走 HTTP ServerClient。
// AI 打标工作流：agent 会话 sub search 读字幕 → 判断 → tags apply BV... --names "..." --source ai。
import { Command } from 'commander';
import { ServerClient, ServerUnreachableError, ServerResponseError } from '../http.js';
import { emitResult, emitError } from '../output.js';
import { getCliContext } from '../context.js';
import { openReadonlyDb } from '../db.js';
import { listTags, type TagSource } from '../../db/tags.js';

// ── 纯处理函数（可测：注入依赖，不直接碰 stdout/exit） ──

/** `tags list`：直读只读 DB（不走 server）。source 过滤档位（该档计数 >0 才列）。 */
export function tagsList(
  dbPath: string,
  opts: { source?: TagSource; q?: string; topN?: number },
): { items: ReturnType<typeof listTags>; total: number } {
  const db = openReadonlyDb(dbPath);
  try {
    const items = listTags(db, opts);
    return { items, total: items.length };
  } finally {
    db.close();
  }
}

/** `tags apply <bvid...>`：经 server 批量打标（打标即建标）。 */
export async function tagsApply(
  client: ServerClient,
  bvids: string[],
  names: string[],
  source: TagSource,
): Promise<unknown> {
  return client.applyTags(bvids, names, source);
}

/** `tags remove <bvid...>`：经 server 批量移除（source 省略删全档）。 */
export async function tagsRemove(
  client: ServerClient,
  bvids: string[],
  names: string[],
  source?: TagSource,
): Promise<unknown> {
  return client.removeTags(bvids, names, source);
}

// ── commander 装配 ──

function parseNames(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

function isTagSource(v: string): v is TagSource {
  return v === 'manual' || v === 'batch' || v === 'ai';
}

export function buildTagsCommand(): Command {
  const cmd = new Command('tags')
    .description('视频标签库（list 直读 DB；apply/remove 走 server HTTP）');

  cmd.command('list')
    .description('标签库列表（含各档计数；--source 过滤该档计数>0 的标签）')
    .option('--source <source>', '档位过滤 manual|batch|ai')
    .option('--q <keyword>', '名称模糊')
    .option('--topN <n>', '最多返回条数（默认 500）', '500')
    .action((opts) => {
      const ctx = getCliContext();
      try {
        if (opts.source && !isTagSource(opts.source)) {
          emitError(`--source 必须是 manual/batch/ai（bili 档只读视频自带，不独立成列）`, "ARGS");
          return;
        }
        emitResult(tagsList(ctx.dbPath, {
          source: opts.source as TagSource | undefined,
          q: opts.q,
          topN: Math.min(500, Math.max(1, Number(opts.topN) || 500)),
        }), ctx.format);
      } catch (err) {
        emitError(`读取标签库失败: ${(err as Error).message}`, 'DB_UNREADABLE');
      }
    });

  cmd.command('apply <bvid...>')
    .description('批量打标（打标即建标；视频需已入库）')
    .requiredOption('--names <csv>', '标签名，逗号分隔（如 "ai,面试题"）')
    .option('--source <source>', '档位 manual|batch|ai（默认 manual）', 'manual')
    .action(async (bvids: string[], opts) => {
      const ctx = getCliContext();
      if (!isTagSource(opts.source)) { emitError('--source 必须是 manual|batch|ai', 'ARGS'); return; }
      const names = parseNames(opts.names);
      if (names.length === 0) { emitError('--names 不能为空', 'ARGS'); return; }
      try {
        const out = await tagsApply(new ServerClient(ctx.serverUrl, ctx.token), bvids, names, opts.source);
        emitResult(out, ctx.format);
      } catch (err) {
        if (err instanceof ServerUnreachableError) emitError(`server 不可达: ${err.message}（COLLECTOR_SERVER 指对了吗？）`, 'SERVER_UNREACHABLE');
        else if (err instanceof ServerResponseError) emitError(`server 拒绝: ${err.message}`, 'RUNTIME');
        else emitError(`打标失败: ${(err as Error).message}`, 'RUNTIME');
      }
    });

  cmd.command('remove <bvid...>')
    .description('批量移除标签（--source 省略删该名字全部三档）')
    .requiredOption('--names <csv>', '标签名，逗号分隔')
    .option('--source <source>', '只删该档 manual|batch|ai（省略删全档）')
    .action(async (bvids: string[], opts) => {
      const ctx = getCliContext();
      if (opts.source && !isTagSource(opts.source)) { emitError('--source 必须是 manual|batch|ai', 'ARGS'); return; }
      const names = parseNames(opts.names);
      if (names.length === 0) { emitError('--names 不能为空', 'ARGS'); return; }
      try {
        const out = await tagsRemove(new ServerClient(ctx.serverUrl, ctx.token), bvids, names, opts.source as TagSource | undefined);
        emitResult(out, ctx.format);
      } catch (err) {
        if (err instanceof ServerUnreachableError) emitError(`server 不可达: ${err.message}`, 'SERVER_UNREACHABLE');
        else if (err instanceof ServerResponseError) emitError(`server 拒绝: ${err.message}`, 'RUNTIME');
        else emitError(`移除失败: ${(err as Error).message}`, 'RUNTIME');
      }
    });

  return cmd;
}
