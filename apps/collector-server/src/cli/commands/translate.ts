// translate 命令组：补翻工作流（pending / source / fill）。
// 消费方是 agent 会话（Claude Code）——「系统出工具、智能在会话」，对齐 AI 打标链路。
//   ① translate pending   查缺口：有轨但无任何中文轨的视频清单（DB 只读）
//   ② translate source    取原料：源轨逐行 `行号\t原文` 文本（DB 只读）
//   ③ translate fill      写回：译文行 → server POST /api/translate/fill（写走 server，对齐 tags apply 先例）
// 补翻轨契约：lan='zh-manual'（与 http/translate.ts ZH_MANUAL_LAN、db/queries.ts trackPriority 三方共同约定）。

import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { ServerClient, ServerUnreachableError, ServerResponseError } from '../http.js';
import { emitResult, emitError, logInfo } from '../output.js';
import { getCliContext } from '../context.js';
import { openReadonlyDb } from '../db.js';
import { getVideo, getVersionPayload } from '../../db/queries.js';
import { extractBody } from '../subtitleFormat.js';
import { normalizeTimestamp } from './videos.js';

// 「有中文」判定集合（pending 排除条件）：B 站原生/AI/自动翻译中文 + 补翻轨本身。
// zh-Hant 繁体也算有中文——不强制补简体。精确列举（不用 LIKE 'zh%'），可测试、防误伤。
const ZH_LANS = ['zh', 'zh-Hant', 'zh-Hans', 'ai-zh', 'zh-manual'] as const;

// ── 纯处理函数（可测：注入依赖，不直接碰 stdout/exit） ──

export interface PendingLangInfo { lan: string | null; lan_doc: string | null; lines: number | null }

export interface PendingItem {
  source: string; source_vid: string; title: string;
  creator_name: string | null; duration: number | null;
  published_at: number | null; first_seen: number; langs: PendingLangInfo[];
}

export interface TranslatePendingOpts {
  from?: string; creator?: string; since?: number; until?: number;
  page?: number; size?: number; sort?: 'first_seen' | 'published_at'; asc?: boolean;
}

/**
 * `translate pending`：有轨但无任何中文轨的视频清单。
 * 每项 langs 带各源轨默认版本行数（应用层 parse payload），供模型挑视频挑语言。
 */
export function translatePending(
  dbPath: string,
  opts: TranslatePendingOpts,
): { total: number; page: number; size: number; items: PendingItem[] } {
  const db = openReadonlyDb(dbPath);
  try {
    const page = Math.max(1, opts.page ?? 1);
    const size = Math.min(200, Math.max(1, opts.size ?? 20));
    const params: unknown[] = [];
    // 过滤条件：EXISTS 有轨 / NOT EXISTS 中文轨 / 可选 --from（有该源语言轨）/ --creator 模糊 / --since/--until 入库时间窗
    let where = `WHERE EXISTS (SELECT 1 FROM subtitle_tracks t WHERE t.video_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM subtitle_tracks t WHERE t.video_id = v.id AND t.lan IN (${ZH_LANS.map(() => '?').join(',')}))`;
    params.push(...ZH_LANS);
    if (opts.from) {
      where += ' AND EXISTS (SELECT 1 FROM subtitle_tracks t WHERE t.video_id = v.id AND t.lan = ?)';
      params.push(opts.from);
    }
    if (opts.creator) {
      where += ' AND c.name LIKE ?';
      params.push(`%${opts.creator}%`);
    }
    if (opts.since !== undefined) { where += ' AND v.first_seen_at >= ?'; params.push(opts.since); }
    if (opts.until !== undefined) { where += ' AND v.first_seen_at <= ?'; params.push(opts.until); }

    const sortCol = opts.sort === 'published_at' ? 'v.published_at' : 'v.first_seen_at';
    const dir = opts.asc ? 'ASC' : 'DESC';
    const total = (db.prepare(
      `SELECT COUNT(*) AS c FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}`,
    ).get(...params) as { c: number }).c;
    const rows = db.prepare(`
      SELECT v.source, v.source_vid, v.title, c.name AS creator_name, v.duration, v.published_at, v.first_seen_at
      FROM videos v LEFT JOIN creators c ON c.id = v.creator_id
      ${where}
      ORDER BY ${sortCol} ${dir}, v.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, size, (page - 1) * size) as Array<Omit<PendingItem, 'langs'>>;

    const items: PendingItem[] = rows.map((r) => ({ ...r, langs: sourceLangs(db, r.source, r.source_vid) }));
    logInfo(`[translate:pending] 候选 ${total} 个（本页 ${items.length}），可用源语言已逐轨标注行数`);
    return { total, page, size, items };
  } finally {
    db.close();
  }
}

// 单视频源语言轨清单（pending 项内嵌复用）：每轨默认版本 body 行数；payload 解析失败 → lines:null（不崩整页）
function sourceLangs(db: ReturnType<typeof openReadonlyDb>, source: string, sourceVid: string): PendingLangInfo[] {
  const detail = getVideo(db, source, sourceVid);
  if (!detail) return [];
  return detail.tracks.map((t) => {
    let lines: number | null = null;
    const ver = t.versions[0]; // getVideo 已按 versionPriority 排序，[0] 即默认版本
    if (ver) {
      try { lines = extractBody(getVersionPayload(db, ver.id)?.payload).length; } catch { lines = null; }
    }
    return { lan: t.lan, lan_doc: t.lan_doc, lines };
  });
}

/** `translate source`：源轨逐行 `行号\t原文`。content 内换行替换为空格——保证「一行=一条 body.content」契约。 */
export function translateSource(
  dbPath: string,
  source: string,
  sourceVid: string,
  fromLan?: string,
): { text: string; lan: string; versionId: number; lines: number } {
  const db = openReadonlyDb(dbPath);
  try {
    const detail = getVideo(db, source, sourceVid);
    if (!detail) throw new Error(`视频不存在: ${source}/${sourceVid}`);
    // 源轨选择：显式 --from 精确匹配；缺省取优先级排序后首个轨（若它是中文轨则报错——该视频不需要补翻）
    const track = fromLan
      ? detail.tracks.find((t) => t.lan === fromLan) ?? throwErr(`源轨不存在: lan=${fromLan}（可用: ${detail.tracks.map((t) => t.lan).join(', ')}）`)
      : detail.tracks[0] ?? throwErr('该视频没有任何字幕轨');
    if (!fromLan && track.lan && (ZH_LANS as readonly string[]).includes(track.lan)) {
      throw new Error(`默认轨已是中文（${track.lan}），无需补翻；确需重翻请显式 --from <lan>`);
    }
    const ver = track.versions[0] ?? throwErr('源轨没有任何版本');
    const payload = getVersionPayload(db, ver.id)?.payload;
    const body = extractBody(payload); // 结构校验 + 提取
    const text = body
      .map((b, i) => `${i + 1}\t${b.content.replace(/[\r\n]+/g, ' ').trim()}`)
      .join('\n') + '\n';
    return { text, lan: track.lan ?? '', versionId: ver.id, lines: body.length };
  } finally {
    db.close();
  }
}

// throw 表达式辅助（TS 无 throw expression；保持调用点单行）
function throwErr(msg: string): never { throw new Error(msg); }

/** `translate fill` 译文文件解析：剥离 BOM/可选行号前缀，去首尾空行；中间空行保留（空译文占位）。 */
export function parseTranslatedFile(text: string): string[] {
  let lines = text.replace(/^\uFEFF/, '').split('\n').map((l) => l.replace(/\r$/, ''));
  lines = lines.map((l) => l.replace(/^\d+\t/, '')); // 剥离模型回传的可选行号前缀
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/** `translate fill`：读译文文件 → 本地预校验行数（--db 源轨）→ POST server 写回。 */
export async function translateFill(
  client: ServerClient,
  dbPath: string,
  source: string,
  sourceVid: string,
  fromLan: string,
  filePath: string,
): Promise<unknown> {
  const lines = parseTranslatedFile(readFileSync(filePath, 'utf8'));
  if (lines.length === 0) throw new Error(`译文文件为空: ${filePath}`);
  // 本地预校验行数（快速失败，不用等 server 往返；server 端仍会再校验——库错位时第二道拦截）
  const src = translateSource(dbPath, source, sourceVid, fromLan);
  if (lines.length !== src.lines) {
    throw new Error(`译文行数不符: 源字幕 ${src.lines} 行（lan=${src.lan}），译文 ${lines.length} 行——用 translate source 的行号对齐，空译文行保留占位`);
  }
  return client.translateFill(source, sourceVid, fromLan, lines);
}

// ── commander 装配 ──

function parseNum(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) { emitError(`${name} 不是合法数字: ${raw}`, 'ARGS'); return undefined; }
  return n;
}

function parseTime(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  try { return normalizeTimestamp(raw); }
  catch (err) { emitError(`${name}: ${(err as Error).message}`, 'ARGS'); return undefined; }
}

export function buildTranslateCommand(): Command {
  const cmd = new Command('translate')
    .description('补翻工作流（pending/source 直读 DB；fill 走 server HTTP 写入 zh-manual 轨）');

  cmd.command('pending')
    .description('查缺口：有轨但无任何中文轨的视频清单（含各源语言行数）')
    .option('--from <lan>', '只看有该源语言轨的视频（如 ai-en）')
    .option('--creator <keyword>', 'UP 主名称模糊')
    .option('--since <time>', '入库时间下界（first_seen）')
    .option('--until <time>', '入库时间上界（first_seen）')
    .option('--page <n>', '页码（默认 1）', '1')
    .option('--size <n>', '页大小（默认 20，上限 200）', '20')
    .option('--sort <key>', '排序键 first_seen|published_at（默认 first_seen）', 'first_seen')
    .option('--asc', '升序（默认降序——最新入库在前）')
    .action((opts) => {
      const ctx = getCliContext();
      if (opts.sort !== 'first_seen' && opts.sort !== 'published_at') {
        emitError(`--sort 必须是 first_seen|published_at`, 'ARGS');
        return;
      }
      const since = parseTime(opts.since, '--since'); if (opts.since !== undefined && since === undefined) return;
      const until = parseTime(opts.until, '--until'); if (opts.until !== undefined && until === undefined) return;
      try {
        emitResult(translatePending(ctx.dbPath, {
          from: opts.from, creator: opts.creator, since, until,
          page: parseNum(opts.page, '--page'), size: parseNum(opts.size, '--size'),
          sort: opts.sort, asc: opts.asc,
        }), ctx.format);
      } catch (err) {
        emitError(`查询待补翻清单失败: ${(err as Error).message}`, 'DB_UNREADABLE');
      }
    });

  cmd.command('source <bvid>')
    .description('取原料：源轨逐行 `行号\\t原文` 文本（stdout 纯文本；翻译后行数须一致）')
    .option('--from <lan>', '源语言轨（精确匹配 lan；缺省取默认优先级首个非中文轨）')
    .option('--source <source>', '视频来源（默认 bilibili；YouTube 用 youtube）', 'bilibili')
    .option('-o, --output <file>', '写入文件（缺省 stdout）')
    .action((bvid: string, opts) => {
      const ctx = getCliContext();
      try {
        const r = translateSource(ctx.dbPath, opts.source, bvid, opts.from);
        logInfo(`[translate:source] ${opts.source}/${bvid} lan=${r.lan} version=${r.versionId} 行数=${r.lines}`);
        if (opts.output) writeFileSync(opts.output, r.text);
        else process.stdout.write(r.text); // 纯文本直写（对齐 export subtitle 先例），不走 emitResult
      } catch (err) {
        emitError(`取源字幕失败: ${(err as Error).message}`, 'DB_UNREADABLE');
      }
    });

  cmd.command('fill <bvid>')
    .description('写回补翻：译文文件（每行一条，可带行号前缀）→ server 校验行对齐+拷贝时间轴入库')
    .requiredOption('--from <lan>', '源语言轨（时间轴从该轨拷贝）')
    .requiredOption('--file <path>', '译文文件路径')
    .option('--source <source>', '视频来源（默认 bilibili）', 'bilibili')
    .action(async (bvid: string, opts) => {
      const ctx = getCliContext();
      try {
        const out = await translateFill(new ServerClient(ctx.serverUrl, ctx.token), ctx.dbPath, opts.source, bvid, opts.from, opts.file);
        emitResult(out, ctx.format);
      } catch (err) {
        if (err instanceof ServerUnreachableError) emitError(`server 不可达: ${err.message}（COLLECTOR_SERVER 指对了吗？）`, 'SERVER_UNREACHABLE');
        else if (err instanceof ServerResponseError) emitError(`server 拒绝: ${err.message}`, 'RUNTIME');
        else emitError(`补翻写回失败: ${(err as Error).message}`, 'RUNTIME');
      }
    });

  return cmd;
}
