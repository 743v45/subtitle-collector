// collector-cli 数据查询命令组：videos list / get / get-by-id。
// 设计参考 [设计文档 §3.1](docs/superpowers/specs/2026-07-05-collector-cli-design.md)。
//
// 架构：commander 薄包装（action 内 openReadonlyDb → 调纯函数 → emitResult）
// + 纯处理函数（接 db 实例 + 解析后的 opts，返回数据，便于单测）。
// 措辞：字幕（subtitle），非弹幕。

import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { getCliContext } from '../main.js';
import { emitResult, emitError } from '../output.js';
import { openReadonlyDb } from '../db.js';
import { listVideosFiltered, getVideoByDbId } from '../../db/advanced.js';
import * as queries from '../../db/queries.js';
import type {
  VideoSortKey,
  VideoListItemAdvanced,
  PageResult,
  ListFilter,
} from '../../db/advanced.js';
import type { VideoDetail } from '../../db/queries.js';

// ── 时间规范化（导出供 changes 命令组复用）──
// 接受 Unix 秒、毫秒或 ISO8601 字符串，统一返回毫秒。
// 启发式：纯数字 < 1e12 视为秒 × 1000，≥ 1e12 视为毫秒；非纯数字串走 Date.parse。
export function normalizeTimestamp(v: string | number): number {
  if (typeof v === 'number') {
    return v < 1e12 ? v * 1000 : v;
  }
  const trimmed = v.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid timestamp: ${JSON.stringify(v)}`);
  }
  return ms;
}

// ── 纯处理函数 opts 类型（解析后；since/until 已是毫秒数字）──
export interface VideosListOpts {
  q?: string;
  creator?: string;
  source?: string;
  tid?: number;
  tname?: string;
  tag?: string;
  lang?: string;
  trackType?: number;       // CLI --track-type（camelCase）
  hasSubtitle?: boolean;
  since?: number;           // 已规范化的毫秒时间戳，比对 first_seen_at
  until?: number;
  minDuration?: number;     // 秒
  maxDuration?: number;
  sort?: VideoSortKey;
  desc?: boolean;
  page?: number;
  subtitleQ?: string;        // 字幕正文关键词模糊匹配（命中 subtitle_versions.payload）
  size?: number;
}

// videos list 纯处理：camelCase opts → snake_case filter → listVideosFiltered。
export function videosList(
  db: Database.Database,
  opts: VideosListOpts,
): PageResult<VideoListItemAdvanced> {
  const filter: ListFilter = {
    q: opts.q,
    creator: opts.creator,
    source: opts.source,
    tid: opts.tid,
    tname: opts.tname,
    tag: opts.tag,
    subtitle_q: opts.subtitleQ,
    lang: opts.lang,
    track_type: opts.trackType,
    has_subtitle: opts.hasSubtitle,
    since: opts.since,
    until: opts.until,
    min_duration: opts.minDuration,
    max_duration: opts.maxDuration,
    sort: opts.sort,
    desc: opts.desc,
    page: opts.page,
    size: opts.size,
  };
  return listVideosFiltered(db, filter);
}

// videos get <source> <source_vid> 纯处理：取详情（含轨/版本，默认标记），null 表示未找到。
export function videosGet(
  db: Database.Database,
  source: string,
  sourceVid: string,
): VideoDetail | null {
  return queries.getVideo(db, source, sourceVid);
}

// videos get-by-id <id> 纯处理：按 db 自增 id 取详情，null 表示未找到。
export function videosGetById(
  db: Database.Database,
  id: number,
): VideoDetail | null {
  return getVideoByDbId(db, id);
}

// ── commander 装配 ──

const SORT_KEYS = ['first_seen', 'published_at', 'title', 'duration', 'view'] as const;

// commander 解析出的原始选项（字符串/布尔），action 内转成 VideosListOpts。
interface ListRawOpts {
  q?: string;
  creator?: string;
  source?: string;
  tid?: string;
  tname?: string;
  tag?: string;
  lang?: string;
  trackType?: string;
  hasSubtitle?: boolean;
  since?: string;
  until?: string;
  minDuration?: string;
  maxDuration?: string;
  sort?: string;
  desc?: boolean;
  page?: string;
  subtitleQ?: string;
  size?: string;
}

// 字符串 → 数字；非法 → ARGS。undefined 透传（filter 不应用）。
function parseNum(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return emitError(`${name} 不是合法数字: ${raw}`, 'ARGS');
  }
  return n;
}

// 字符串 → VideoSortKey；非法 → ARGS。undefined 透传。
function parseSort(raw: string | undefined): VideoSortKey | undefined {
  if (raw === undefined) return undefined;
  if (!(SORT_KEYS as readonly string[]).includes(raw)) {
    return emitError(`非法 --sort: ${raw}（可选: ${SORT_KEYS.join('|')}）`, 'ARGS');
  }
  return raw as VideoSortKey;
}

// since/until 字符串 → 毫秒数字；格式非法（normalizeTimestamp 抛错）→ ARGS。
function parseTime(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  try {
    return normalizeTimestamp(raw);
  } catch (err) {
    return emitError(`${name}: ${(err as Error).message}`, 'ARGS');
  }
}

// 打开只读 DB；失败 → DB_UNREADABLE。emitError 返回 never，两条路径都满足返回类型。
function openDbOrEmit(dbPath: string): Database.Database {
  try {
    return openReadonlyDb(dbPath);
  } catch (err) {
    return emitError((err as Error).message, 'DB_UNREADABLE');
  }
}

export function buildVideosCommand(): Command {
  const videos = new Command('videos')
    .description('查询视频（直连 SQLite 只读）：list / get / get-by-id');

  videos
    .command('list')
    .description('按条件过滤视频列表，返回 {total,page,size,items}')
    .option('--q <text>', '标题 / UP 名模糊匹配')
    .option('--creator <name>', 'UP 名模糊匹配')
    .option('--source <src>', '视频来源（精确，如 bilibili）')
    .option('--tid <id>', '分区 tid（精确）')
    .option('--tname <name>', '分区名模糊匹配')
    .option('--tag <tag>', '标签名模糊匹配（extra.tags[].tag_name）')
    .option('--subtitle-q <text>', '字幕正文关键词模糊匹配（命中 subtitle_versions.payload）')
    .option('--lang <lang>', '字幕语言模糊匹配（如 zh 命中 zh-Hans）')
    .option('--track-type <type>', '字幕轨类型（1=AI 2=CC），精确')
    .option('--has-subtitle', '仅含至少一条字幕版本的视频')
    .option('--since <ts>', '起始时间（Unix 秒/毫秒 或 ISO8601），比对 first_seen_at')
    .option('--until <ts>', '结束时间（Unix 秒/毫秒 或 ISO8601），比对 first_seen_at')
    .option('--min-duration <s>', '最小时长（秒）')
    .option('--max-duration <s>', '最大时长（秒）')
    .option('--sort <key>', '排序键：first_seen|published_at|title|duration|view')
    .option('--desc', '降序（默认升序）')
    .option('--page <n>', '页码（从 1 起，默认 1）')
    .option('--size <n>', '每页条数（默认 20）')
    .action((raw: ListRawOpts) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      const opts: VideosListOpts = {
        q: raw.q,
        creator: raw.creator,
        source: raw.source,
        tid: parseNum(raw.tid, '--tid'),
        tname: raw.tname,
        tag: raw.tag,
        subtitleQ: raw.subtitleQ,
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
      const data = videosList(db, opts);
      emitResult(data, ctx.format);
    });

  videos
    .command('get <source> <sourceVid>')
    .description('按 source + source_vid 取视频详情（含字幕轨/版本，默认标记）')
    .action((source: string, sourceVid: string) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      const data = videosGet(db, source, sourceVid);
      if (data === null) {
        emitError(`video not found: ${source}/${sourceVid}`, 'NOT_FOUND');
      }
      emitResult(data, ctx.format);
    });

  videos
    .command('get-by-id <id>')
    .description('按数据库自增 id 取视频详情')
    .action((idRaw: string) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      const id = Number(idRaw);
      if (!Number.isFinite(id)) {
        emitError(`<id> 不是合法数字: ${idRaw}`, 'ARGS');
      }
      const data = videosGetById(db, id);
      if (data === null) {
        emitError(`video not found: id=${id}`, 'NOT_FOUND');
      }
      emitResult(data, ctx.format);
    });

  return videos;
}
