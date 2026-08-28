// collector-cli 导出命令组：export subtitle / export videos。
// 设计参考 [设计文档 §3.2](docs/superpowers/specs/2026-07-05-collector-cli-design.md)。
// 架构同 videos.ts：commander 薄包装 + 纯处理函数。措辞：字幕（subtitle），非弹幕。
//
// 命名注意（避坑）：export subtitle 的字幕格式用 `--sub-format` 而非 `--format`，
// 因为 commander 的 program 级 `--format`（全局输出格式 json|ndjson|csv|table）会吞掉
// 子命令同名 option，导致子命令收不到值。export videos 的格式语义与全局 --format 重合
// （json|ndjson|csv），故直接复用全局 ctx.format，不再定义自己的 --format。

import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCliContext } from '../context.js';
import { emitResult, emitError } from '../output.js';
import { openReadonlyDb } from '../db.js';
import type { VideoListItemAdvanced, PageResult } from '../../db/advanced.js';
import { VIDEO_SORT_KEYS } from '../../db/advanced.js';
// resolveSubtitle 已下沉 subtitleFormat.ts（2026-08-23 断环：bundle.ts 也用它，原在本文件会构成 bundle ↔ export 循环）
import { convertSubtitle, resolveSubtitle, type SubtitleFormat } from '../subtitleFormat.js';
import { buildBundle, FILENAME_PARTS, type FilenamePart } from '../bundle.js';
// videos.ts 暴露 videosList（camelCase opts → snake_case filter）+ normalizeTimestamp + parseSort/parseDesc
// （排序键清单单一事实源 db/advanced.ts VIDEO_SORT_KEYS），export videos/bundle 直接复用查询与解析逻辑。
import { videosList, normalizeTimestamp, parseSort, parseDesc, type VideosListOpts } from './videos.js';

const SUBTITLE_FORMATS = ['srt', 'vtt', 'txt', 'json'] as const;
const VIDEOS_FORMATS = ['json', 'csv', 'ndjson'] as const;
export type ExportVideosFormat = (typeof VIDEOS_FORMATS)[number];

// ── export videos 文件序列化（-o 写文件用；stdout 走 emitResult）──

// 字段顺序固定，便于脚本按列消费。
const VIDEO_CSV_FIELDS = [
  'id', 'source', 'source_vid', 'title', 'creator_name', 'creator_source_uid',
  'duration', 'published_at', 'first_seen_at', 'track_count',
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * 把视频列表结果序列化为文件内容（-o 用）。stdout 路径不走这里（走 emitResult，受全局 --format 影响）。
 * - json：美化整个 {total,page,size,items}
 * - ndjson：每行一个 item JSON
 * - csv：首行表头 + 各行（字段固定）
 */
export function serializeVideosResult(
  result: PageResult<VideoListItemAdvanced>,
  format: ExportVideosFormat,
): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2) + '\n';
  }
  if (format === 'ndjson') {
    return result.items.map((it) => JSON.stringify(it)).join('\n') + '\n';
  }
  // csv
  const lines: string[] = [VIDEO_CSV_FIELDS.join(',')];
  for (const r of result.items) {
    const row = r as unknown as Record<string, unknown>;
    lines.push(VIDEO_CSV_FIELDS.map((f) => csvEscape(row[f])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ── commander 装配 ──

interface SubtitleRawOpts {
  track?: string;
  version?: string;
  subFormat?: string;   // --sub-format：字幕格式 srt|vtt|txt|json
  output?: string;
}

interface VideosRawOpts {
  q?: string; creator?: string; source?: string; tid?: string; tname?: string; tag?: string; lang?: string;
  trackType?: string; hasSubtitle?: boolean; since?: string; until?: string; minDuration?: string; maxDuration?: string;
  sort?: string; desc?: string | boolean; page?: string; size?: string; output?: string;
}

// export bundle 原始选项：过滤器同 videos list（去分页去 -o）+ bundle 专属三项。
// VideosRawOpts（export videos 的）缺 subtitle-q/paid/min-view/max-view（其装配未暴露），这里补齐。
interface BundleRawOpts extends Omit<VideosRawOpts, 'page' | 'size' | 'output'> {
  subtitleQ?: string;
  paid?: boolean;
  minView?: string;
  maxView?: string;
  out?: string;
  track?: string;
  limit?: string;
  force?: boolean;
  nameOrder?: string;      // --name-order：videos/ 文件名组件与顺序（逗号分隔）
}

function parseNum(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return emitError(`${name} 不是合法数字: ${raw}`, 'ARGS');
  return n;
}

function parseTime(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  try { return normalizeTimestamp(raw); }
  catch (err) { return emitError(`${name}: ${(err as Error).message}`, 'ARGS'); }
}

function parseSubtitleFormat(raw: string | undefined): SubtitleFormat {
  if (raw === undefined) return 'srt';
  if (!(SUBTITLE_FORMATS as readonly string[]).includes(raw)) {
    return emitError(`非法 --sub-format: ${raw}（可选: ${SUBTITLE_FORMATS.join('|')}）`, 'ARGS');
  }
  return raw as SubtitleFormat;
}

// --name-order 解析：逗号分隔组件（id|name|time|author 的无子集排列），undefined 走 buildBundle 默认 id,name
function parseNameOrder(raw: string | undefined): FilenamePart[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return emitError(`--name-order 为空（可选组件: ${FILENAME_PARTS.join('|')}）`, 'ARGS');
  const seen = new Set<string>();
  for (const p of parts) {
    if (!(FILENAME_PARTS as readonly string[]).includes(p)) {
      return emitError(`非法 --name-order 组件: ${p}（可选: ${FILENAME_PARTS.join('|')}）`, 'ARGS');
    }
    if (seen.has(p)) return emitError(`--name-order 组件重复: ${p}`, 'ARGS');
    seen.add(p);
  }
  return parts as FilenamePart[];
}

function openDbOrEmit(dbPath: string): Database.Database {
  try { return openReadonlyDb(dbPath); }
  catch (err) { return emitError((err as Error).message, 'DB_UNREADABLE'); }
}

export function buildExportCommand(): Command {
  const exp = new Command('export')
    .description('导出字幕 / 视频列表（直连 SQLite 只读）：subtitle / videos');

  // export subtitle <source> <sourceVid>
  exp
    .command('subtitle <source> <sourceVid>')
    .description('导出视频字幕为 srt/vtt/txt/json；不指定 track/version 则取默认轨默认版本')
    .option('--track <lan>', '指定字幕轨 lan（精确，如 zh-Hans）')
    .option('--version <id>', '指定 subtitle_version id（优先于 --track）')
    .option('--sub-format <fmt>', '字幕格式：srt|vtt|txt|json（默认 srt）')
    .option('-o, --output <file>', '写入文件（不指定则字幕正文写 stdout）')
    .action((source: string, sourceVid: string, raw: SubtitleRawOpts) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      const format = parseSubtitleFormat(raw.subFormat);
      const r = resolveSubtitle(db, {
        source,
        sourceVid,
        track: raw.track,
        versionId: parseNum(raw.version, '--version'),
        format,
      });
      if (r.kind === 'not_found') {
        emitError(r.message, 'NOT_FOUND');
      }
      if (raw.output) {
        // -o 写文件：所有格式统一写 convertSubtitle 文本（含 json 的美化 JSON），返回结构化回执
        writeFileSync(raw.output, r.text);
        emitResult(
          { ok: true, path: raw.output, bytes: Buffer.byteLength(r.text), format: r.format, version_id: r.versionId },
          ctx.format,
        );
      } else if (format === 'json') {
        // 字幕 json 格式：payload 当结构化对象经 emitResult 包装（默认美化 JSON，受全局 --format 影响）
        emitResult(r.payload, ctx.format);
      } else {
        // srt/vtt/txt：纯文本直接写 stdout，不走 JSON 包装（agent 友好：纯字幕输出）
        process.stdout.write(r.text);
      }
    });

  // export videos（过滤项同 videos list，格式复用全局 --format：json/csv/ndjson；table 不支持）
  exp
    .command('videos')
    .description('导出视频列表为 json/csv/ndjson（过滤项同 videos list；格式由全局 --format 控制）')
    .option('--q <text>', '标题 / UP 名模糊匹配')
    .option('--creator <name>', 'UP 名模糊匹配')
    .option('--source <src>', '视频来源（精确）')
    .option('--tid <id>', '分区 tid（精确）')
    .option('--tname <name>', '分区名模糊匹配')
    .option('--tag <tag>', '标签名模糊匹配')
    .option('--lang <lang>', '字幕语言模糊匹配')
    .option('--track-type <type>', '字幕轨类型（1=AI 2=CC 3=翻译轨），精确')
    .option('--has-subtitle', '仅含至少一条字幕版本的视频')
    .option('--since <ts>', '起始时间（Unix 秒/毫秒 或 ISO8601），比对 first_seen_at')
    .option('--until <ts>', '结束时间，比对 first_seen_at')
    .option('--min-duration <s>', '最小时长（秒）')
    .option('--max-duration <s>', '最大时长（秒）')
    .option('--sort <key>', `排序键：${VIDEO_SORT_KEYS.join('|')}`)
    .option('--desc [value]', '降序（默认降序，对齐 HTTP；升序传 --desc=false）')
    .option('--page <n>', '页码（从 1 起，默认 1）')
    .option('--size <n>', '每页条数（默认 20）')
    .option('-o, --output <file>', '写入文件（不指定则写 stdout）')
    .action((raw: VideosRawOpts) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      const opts: VideosListOpts = {
        q: raw.q,
        creator: raw.creator,
        source: raw.source,
        tid: parseNum(raw.tid, '--tid'),
        tname: raw.tname,
        tag: raw.tag,
        lang: raw.lang,
        trackType: parseNum(raw.trackType, '--track-type'),
        hasSubtitle: raw.hasSubtitle,
        since: parseTime(raw.since, '--since'),
        until: parseTime(raw.until, '--until'),
        minDuration: parseNum(raw.minDuration, '--min-duration'),
        maxDuration: parseNum(raw.maxDuration, '--max-duration'),
        sort: parseSort(raw.sort),
        desc: parseDesc(raw.desc),
        page: parseNum(raw.page, '--page'),
        size: parseNum(raw.size, '--size'),
      };
      // 复用 videos.ts 的查询逻辑（camelCase opts → listVideosFiltered）
      const result = videosList(db, opts);
      // 格式复用全局 --format（json|ndjson|csv）；table 是人类浏览视图，与"导出数据"语义冲突，拒绝
      if (ctx.format === 'table') {
        emitError('export videos 不支持 table 格式（仅 json|ndjson|csv）', 'ARGS');
      }
      const format = ctx.format as ExportVideosFormat;
      if (raw.output) {
        const content = serializeVideosResult(result, format);
        writeFileSync(raw.output, content);
        emitResult(
          { ok: true, path: raw.output, bytes: Buffer.byteLength(content), format, total: result.total, page: result.page, size: result.size },
          ctx.format,
        );
      } else {
        emitResult(result, format);
      }
    });

  // export bundle（分析原料包：manifest.json + videos/*.txt + ANALYZE.md；分析在会话完成，产物落盘 analysis/<主题>/）
  exp
    .command('bundle')
    .description('按条件批量导出分析原料包（manifest.json + videos/*.txt + ANALYZE.md）；过滤器同 videos list（无分页）')
    .requiredOption('--out <dir>', '输出目录（已存在且非空时需 --force；同名文件覆盖，不清理多余旧文件）')
    .option('--track <lan>', '统一覆盖字幕轨（默认各视频默认轨：CC中文>AI中文>en）')
    .option('--limit <n>', '最多导出视频数（默认 500）')
    .option('--force', '允许写入已存在且非空的 --out 目录')
    .option('--name-order <parts>', `videos/ 文件名组件及顺序，逗号分隔：${FILENAME_PARTS.join('|')}（默认 id,name 即 <id>-<标题>；time=发布日期，author=UP 名）`)
    // —— 过滤器（同 export videos，去分页去 -o）——
    .option('--q <text>', '标题 / UP 名模糊匹配')
    .option('--creator <name>', 'UP 名模糊匹配')
    .option('--source <src>', '视频来源（精确）')
    .option('--tid <id>', '分区 tid（精确）')
    .option('--tname <name>', '分区名模糊匹配')
    .option('--tag <tag>', '标签名模糊匹配')
    .option('--subtitle-q <text>', '字幕正文关键词模糊匹配')
    .option('--lang <lang>', '字幕语言模糊匹配')
    .option('--track-type <type>', '字幕轨类型（1=AI 2=CC 3=翻译轨），精确')
    .option('--has-subtitle', '仅含至少一条字幕版本的视频')
    .option('--paid', '仅付费视频')
    .option('--since <ts>', '起始时间（Unix 秒/毫秒 或 ISO8601），比对 first_seen_at')
    .option('--until <ts>', '结束时间，比对 first_seen_at')
    .option('--min-duration <s>', '最小时长（秒）')
    .option('--max-duration <s>', '最大时长（秒）')
    .option('--min-view <n>', '最小播放量')
    .option('--max-view <n>', '最大播放量')
    .option('--sort <key>', `排序键：${VIDEO_SORT_KEYS.join('|')}`)
    .option('--desc [value]', '降序（默认降序，对齐 HTTP；升序传 --desc=false）')
    .action((raw: BundleRawOpts) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      if (!raw.out) return emitError('--out 必填', 'ARGS');
      if (existsSync(raw.out) && readdirSync(raw.out).length > 0 && !raw.force) {
        return emitError(`--out 目录已存在且非空: ${raw.out}（覆盖请加 --force）`, 'ARGS');
      }
      const filters: VideosListOpts = {
        q: raw.q, creator: raw.creator, source: raw.source,
        tid: parseNum(raw.tid, '--tid'), tname: raw.tname, tag: raw.tag,
        subtitleQ: raw.subtitleQ, lang: raw.lang,
        trackType: parseNum(raw.trackType, '--track-type'),
        hasSubtitle: raw.hasSubtitle, paid: raw.paid,
        since: parseTime(raw.since, '--since'), until: parseTime(raw.until, '--until'),
        minDuration: parseNum(raw.minDuration, '--min-duration'), maxDuration: parseNum(raw.maxDuration, '--max-duration'),
        minView: parseNum(raw.minView, '--min-view'), maxView: parseNum(raw.maxView, '--max-view'),
        sort: parseSort(raw.sort), desc: parseDesc(raw.desc),
      };
      const built = buildBundle(db, {
        filters, track: raw.track, limit: parseNum(raw.limit, '--limit') ?? 500,
        now: Date.now(), nameOrder: parseNameOrder(raw.nameOrder),
      });
      mkdirSync(join(raw.out, 'videos'), { recursive: true });
      for (const f of built.files) writeFileSync(join(raw.out, f.path), f.content);
      emitResult({
        ok: true, path: raw.out,
        videos_total: built.manifest.total_matched, exported: built.manifest.exported,
        with_subtitle: built.manifest.videos.filter((v) => v.subtitle).length,
        without_subtitle: built.manifest.videos.filter((v) => !v.subtitle).length,
        files: built.files.length,
      }, ctx.format);
    });

  return exp;
}
