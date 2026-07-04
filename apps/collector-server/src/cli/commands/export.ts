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
import { writeFileSync } from 'node:fs';
import { getCliContext } from '../main.js';
import { emitResult, emitError } from '../output.js';
import { openReadonlyDb } from '../db.js';
import { getVideo, getVersionPayload } from '../../db/queries.js';
import type { VideoListItemAdvanced, PageResult, VideoSortKey } from '../../db/advanced.js';
import { convertSubtitle, type SubtitleFormat } from '../subtitleFormat.js';
// videos.ts 暴露 videosList（camelCase opts → snake_case filter）+ normalizeTimestamp，export videos 直接复用查询逻辑。
import { videosList, normalizeTimestamp } from './videos.js';
import type { VideosListOpts } from './videos.js';

const SUBTITLE_FORMATS = ['srt', 'vtt', 'txt', 'json'] as const;
const VIDEOS_FORMATS = ['json', 'csv', 'ndjson'] as const;
const SORT_KEYS = ['first_seen', 'published_at', 'title', 'duration', 'view'] as const;
export type ExportVideosFormat = (typeof VIDEOS_FORMATS)[number];

// ── export subtitle 纯处理 ──

export interface ExportSubtitleOpts {
  source: string;
  sourceVid: string;
  track?: string;        // --track <lan>，精确匹配 subtitle_tracks.lan
  versionId?: number;    // --version <id>，优先于 track
  format: SubtitleFormat;
}

export type SubtitleResolveResult =
  | { kind: 'ok'; payload: unknown; text: string; format: SubtitleFormat; versionId: number }
  | { kind: 'not_found'; message: string };

/**
 * 解析字幕版本 + 转格式。优先级：--version >（--track | 默认轨）的默认版本。
 * 视频 / 轨 / 版本不存在返回 { kind: 'not_found', message }，便于 action 直 emitError NOT_FOUND。
 * convertSubtitle 在 payload 结构不符时会抛（数据损坏，理论不会发生；若发生则向上冒泡为 RUNTIME）。
 *
 * 默认轨 / 默认版本的判定复用 queries.getVideo 的 is_default 标记：
 *   - 默认轨 = 排序后首个（CC中文 > AI中文 > en > 其他）
 *   - 每个轨各自的默认 version = origin 优先级（external > manual > asr）首个，不跨轨串台
 */
export function resolveSubtitle(db: Database.Database, opts: ExportSubtitleOpts): SubtitleResolveResult {
  const fmt = opts.format;

  // 1. 显式 version id 优先
  if (opts.versionId !== undefined) {
    const v = getVersionPayload(db, opts.versionId);
    if (!v) return { kind: 'not_found', message: `subtitle_version not found: id=${opts.versionId}` };
    return { kind: 'ok', payload: v.payload, text: convertSubtitle(v.payload, fmt), format: fmt, versionId: v.id };
  }

  // 2. 按 source + sourceVid 取视频详情（getVideo 已标 is_default 轨 / 每轨 is_default version）
  const detail = getVideo(db, opts.source, opts.sourceVid);
  if (!detail) return { kind: 'not_found', message: `video not found: ${opts.source}/${opts.sourceVid}` };

  // 3. 选轨：--track 精确匹配 lan；否则取 is_default 轨
  const track = opts.track !== undefined
    ? detail.tracks.find((t) => t.lan === opts.track)
    : detail.tracks.find((t) => (t as { is_default?: boolean }).is_default);
  if (!track) {
    const msg = opts.track !== undefined
      ? `track not found: lan=${opts.track} in ${opts.source}/${opts.sourceVid}`
      : `${opts.source}/${opts.sourceVid} 无字幕轨`;
    return { kind: 'not_found', message: msg };
  }

  // 4. 选版本：该轨 is_default version
  const ver = track.versions.find((v) => (v as { is_default?: boolean }).is_default);
  if (!ver) {
    return { kind: 'not_found', message: `track lan=${track.lan ?? '(无)'} 无字幕版本` };
  }

  const v = getVersionPayload(db, ver.id);
  if (!v) return { kind: 'not_found', message: `subtitle_version not found: id=${ver.id}` };
  return { kind: 'ok', payload: v.payload, text: convertSubtitle(v.payload, fmt), format: fmt, versionId: v.id };
}

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
  sort?: string; desc?: boolean; page?: string; size?: string; output?: string;
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

function parseSort(raw: string | undefined): VideoSortKey | undefined {
  if (raw === undefined) return undefined;
  if (!(SORT_KEYS as readonly string[]).includes(raw)) {
    return emitError(`非法 --sort: ${raw}（可选: ${SORT_KEYS.join('|')}）`, 'ARGS');
  }
  return raw as VideoSortKey;
}

function parseSubtitleFormat(raw: string | undefined): SubtitleFormat {
  if (raw === undefined) return 'srt';
  if (!(SUBTITLE_FORMATS as readonly string[]).includes(raw)) {
    return emitError(`非法 --sub-format: ${raw}（可选: ${SUBTITLE_FORMATS.join('|')}）`, 'ARGS');
  }
  return raw as SubtitleFormat;
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
    .option('--track-type <type>', '字幕轨类型（1=AI 2=CC），精确')
    .option('--has-subtitle', '仅含至少一条字幕版本的视频')
    .option('--since <ts>', '起始时间（Unix 秒/毫秒 或 ISO8601），比对 first_seen_at')
    .option('--until <ts>', '结束时间，比对 first_seen_at')
    .option('--min-duration <s>', '最小时长（秒）')
    .option('--max-duration <s>', '最大时长（秒）')
    .option('--sort <key>', '排序键：first_seen|published_at|title|duration|view')
    .option('--desc', '降序（默认升序）')
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
        desc: raw.desc,
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

  return exp;
}
