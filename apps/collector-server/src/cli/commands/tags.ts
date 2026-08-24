// tags 命令组：视频标签（list / apply / remove）。
// 读写分工遵循 CLI 不变量（db.ts:1-2）：list 直连只读 SQLite；apply/remove 是写操作走 HTTP ServerClient。
// AI 打标工作流：agent 会话 sub search 读字幕 → 判断 → tags apply BV... --names "..." --scope ai --source bilibili。
// 命名约定（2026-08-24 全局统一）：--source=平台（默认 bilibili）；--scope=档位（manual|batch|ai|system）。
import { Command } from 'commander';
import { ServerClient, ServerUnreachableError, ServerResponseError } from '../http.js';
import { emitResult, emitError } from '../output.js';
import { getCliContext } from '../context.js';
import { openReadonlyDb } from '../db.js';
import { listTags, type TagSource } from '../../db/tags.js';

// ── 纯处理函数（可测：注入依赖，不直接碰 stdout/exit） ──

/** `tags list`：直读只读 DB（不走 server）。scope 过滤档位（该档计数 >0 才列）；source 平台收窄计数。 */
export function tagsList(
  dbPath: string,
  opts: { scope?: TagSource; source?: string; q?: string; topN?: number },
): { items: ReturnType<typeof listTags>; total: number } {
  const db = openReadonlyDb(dbPath);
  try {
    const items = listTags(db, opts);
    return { items, total: items.length };
  } finally {
    db.close();
  }
}

/** `tags apply <vid...>`：经 server 批量打标（打标即建标）。vid=平台视频 ID（--source 定平台）。 */
export async function tagsApply(
  client: ServerClient,
  vids: string[],
  names: string[],
  scope: TagSource,
  platform: 'bilibili' | 'youtube' = 'bilibili',
): Promise<unknown> {
  return client.applyTags(vids, names, scope, platform);
}

/** `tags remove <vid...>`：经 server 批量移除（scope 省略删全档）。 */
export async function tagsRemove(
  client: ServerClient,
  vids: string[],
  names: string[],
  scope?: TagSource,
  platform: 'bilibili' | 'youtube' = 'bilibili',
): Promise<unknown> {
  return client.removeTags(vids, names, scope, platform);
}

// ── commander 装配 ──

function parseNames(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

function isTagSource(v: string): v is TagSource {
  // 与 db/tags.ts 档位同步（2026-08-23 +system：系统状态标，采集链路自动打/摘，回填脚本也走 apply）
  return v === 'manual' || v === 'batch' || v === 'ai' || v === 'system';
}

function isPlatform(v: string): v is 'bilibili' | 'youtube' {
  return v === 'bilibili' || v === 'youtube';
}

export function buildTagsCommand(): Command {
  const cmd = new Command('tags')
    .description('视频标签库（list 直读 DB；apply/remove 走 server HTTP）');

  cmd.command('list')
    .description('标签库列表（含各档计数；--scope 过滤该档计数>0 的标签，--source 平台收窄计数）')
    .option('--scope <scope>', '档位过滤 manual|batch|ai|system')
    .option('--source <src>', '平台过滤（bilibili|youtube），计数只算该平台视频')
    .option('--q <keyword>', '名称模糊')
    .option('--topN <n>', '最多返回条数（默认 500）', '500')
    .action((opts) => {
      const ctx = getCliContext();
      try {
        if (opts.scope && !isTagSource(opts.scope)) {
          emitError(`--scope 必须是 manual/batch/ai/system（bili 档只读视频自带，不独立成列）`, "ARGS");
          return;
        }
        if (opts.source && !isPlatform(opts.source)) {
          emitError(`--source 必须是 bilibili/youtube`, "ARGS");
          return;
        }
        emitResult(tagsList(ctx.dbPath, {
          scope: opts.scope as TagSource | undefined,
          source: opts.source,
          q: opts.q,
          topN: Math.min(500, Math.max(1, Number(opts.topN) || 500)),
        }), ctx.format);
      } catch (err) {
        emitError(`读取标签库失败: ${(err as Error).message}`, 'DB_UNREADABLE');
      }
    });

  cmd.command('apply <vid...>')
    .description('批量打标（打标即建标；视频需已入库。vid=平台视频 ID：B 站 BV 号 / YouTube 11 位 ID）')
    .requiredOption('--names <csv>', '标签名，逗号分隔（如 "ai,面试题"）')
    .option('--scope <scope>', '档位 manual|batch|ai|system（默认 manual；system=系统状态标如 no-subtitle，采集链路自动打）', 'manual')
    .option('--source <src>', '视频来源平台（默认 bilibili）', 'bilibili')
    .action(async (vids: string[], opts) => {
      const ctx = getCliContext();
      if (!isTagSource(opts.scope)) { emitError('--scope 必须是 manual/batch/ai/system', 'ARGS'); return; }
      if (!isPlatform(opts.source)) { emitError('--source 必须是 bilibili/youtube', 'ARGS'); return; }
      const names = parseNames(opts.names);
      if (names.length === 0) { emitError('--names 不能为空', 'ARGS'); return; }
      try {
        const out = await tagsApply(new ServerClient(ctx.serverUrl, ctx.token), vids, names, opts.scope, opts.source);
        emitResult(out, ctx.format);
      } catch (err) {
        if (err instanceof ServerUnreachableError) emitError(`server 不可达: ${err.message}（COLLECTOR_SERVER 指对了吗？）`, 'SERVER_UNREACHABLE');
        else if (err instanceof ServerResponseError) emitError(`server 拒绝: ${err.message}`, 'RUNTIME');
        else emitError(`打标失败: ${(err as Error).message}`, 'RUNTIME');
      }
    });

  cmd.command('remove <vid...>')
    .description('批量移除标签（--scope 省略删该名字全部四档）')
    .requiredOption('--names <csv>', '标签名，逗号分隔')
    .option('--scope <scope>', '只删该档 manual|batch|ai|system（省略删全档）')
    .option('--source <src>', '视频来源平台（默认 bilibili）', 'bilibili')
    .action(async (vids: string[], opts) => {
      const ctx = getCliContext();
      if (opts.scope && !isTagSource(opts.scope)) { emitError('--scope 必须是 manual/batch/ai/system', 'ARGS'); return; }
      if (!isPlatform(opts.source)) { emitError('--source 必须是 bilibili/youtube', 'ARGS'); return; }
      const names = parseNames(opts.names);
      if (names.length === 0) { emitError('--names 不能为空', 'ARGS'); return; }
      try {
        const out = await tagsRemove(new ServerClient(ctx.serverUrl, ctx.token), vids, names, opts.scope as TagSource | undefined, opts.source);
        emitResult(out, ctx.format);
      } catch (err) {
        if (err instanceof ServerUnreachableError) emitError(`server 不可达: ${err.message}（COLLECTOR_SERVER 指对了吗？）`, 'SERVER_UNREACHABLE');
        else if (err instanceof ServerResponseError) emitError(`server 拒绝: ${err.message}`, 'RUNTIME');
        else emitError(`移除失败: ${(err as Error).message}`, 'RUNTIME');
      }
    });

  return cmd;
}
