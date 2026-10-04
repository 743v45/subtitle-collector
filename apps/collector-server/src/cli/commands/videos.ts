// collector-cli 数据查询命令组：videos list / get / get-by-id。
// 设计参考 [设计文档 §3.1](docs/superpowers/specs/2026-07-05-collector-cli-design.md)。
//
// 架构：commander 薄包装（action 内 openReadonlyDb → 调纯函数 → emitResult）
// + 纯处理函数（接 db 实例 + 解析后的 opts，返回数据，便于单测）。
// 措辞：字幕（subtitle），非弹幕。

import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { getCliContext } from '../context.js';
import { emitResult, emitError } from '../output.js';
import { openDbOrEmit } from '../db.js';
import { listVideosFiltered, getVideoByDbId, VIDEO_SORT_KEYS } from '../../db/advanced.js';
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
  creatorId?: number;       // --creator-id（creators.id 精确）
  creatorUid?: string;      // --creator-uid（creators.source_uid 精确，如 B 站 mid）
  source?: string;
  tid?: number;
  tname?: string;
  tag?: string;
  tags?: string[];          // CLI --tags（CSV 解析后；精确 AND 语义）
  tagSource?: string[];     // --tag-source（CSV 解析后；六档子集，收窄 tag/tags 匹配档位或单独存在性）
  dateField?: 'first_seen' | 'published_at';  // --date-field（since/until 比对列，缺省 first_seen）
  lang?: string;
  trackType?: number;       // CLI --track-type（camelCase）
  hasSubtitle?: boolean;
  paid?: boolean;           // 仅付费视频（v.paid = 1）
  since?: number;           // 已规范化的毫秒时间戳，比对 --date-field 指定列（默认 first_seen_at）
  until?: number;
  minDuration?: number;     // 秒
  maxDuration?: number;
  minView?: number;         // 最小播放量
  maxView?: number;         // 最大播放量
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
    creator_id: opts.creatorId,
    creator_uid: opts.creatorUid,
    source: opts.source,
    tid: opts.tid,
    tname: opts.tname,
    tag: opts.tag,
    tags: opts.tags,
    tag_source: opts.tagSource,
    date_field: opts.dateField,
    subtitle_q: opts.subtitleQ,
    lang: opts.lang,
    track_type: opts.trackType,
    has_subtitle: opts.hasSubtitle,
    paid: opts.paid,
    since: opts.since,
    until: opts.until,
    min_duration: opts.minDuration,
    max_duration: opts.maxDuration,
    min_view: opts.minView,
    max_view: opts.maxView,
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

// 字符串 → VideoSortKey；非法 → ARGS。undefined 透传。导出供 export.ts 复用（键清单单一事实源）。
export function parseSort(raw: string | undefined): VideoSortKey | undefined {
  if (raw === undefined) return undefined;
  if (!(VIDEO_SORT_KEYS as readonly string[]).includes(raw)) {
    return emitError(`非法 --sort: ${raw}（可选: ${VIDEO_SORT_KEYS.join('|')}）`, 'ARGS');
  }
  return raw as VideoSortKey;
}

// --desc 解析（2026-08-25 全端点排序）：缺省 true（CLI 缺省从升序改降序，对齐 HTTP 与 web 默认视角）；
// 裸 --desc → true；--desc=false|0|no → false（升序）；值非法 → ARGS。导出供各列表命令复用。
export function parseDesc(raw: string | boolean | undefined): boolean {
  if (raw === undefined) return true;
  if (typeof raw === 'boolean') return raw;
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return emitError(`非法 --desc: ${raw}（可选 true|false，缺省 true）`, 'ARGS');
}

// --tags CSV 解析（2026-09-22 复数精确 AND 过滤）：逗号分隔、trim、滤空项；
// 空串/全逗号解析为空数组 → 返回 undefined 按未传处理（DB 层空数组本就不过滤，这里归一）。
// 导出供 export.ts / stats.ts 复用（对齐 parseSort/parseDesc 先例）；split 先例 tags.ts parseNames。
export function parseTagsCsv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const tags = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

// 标签档位全集（六档）：与 db/tag-match.ts tagMatchCond / http/filter.ts 口径一致。
// db 层未导出常量（HTTP 面亦就地内联同清单），CLI 侧同清单内联；改档位时三处同改。
const TAG_SOURCES = ['manual', 'batch', 'ai', 'system', 'bili', 'season'] as const;

// --tag-source 解析（P1-6，cli-completeness #5 余量）：逗号分隔档位、trim、滤空项；
// 空串/全逗号 → undefined 按未传处理（对齐 parseTagsCsv 归一）；非法档位 → ARGS
// （CLI 严格校验对齐 parseSort 先例；HTTP 面非法值静默忽略，交互形态不同故不照搬）。
export function parseTagSource(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const sources = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (sources.length === 0) return undefined;
  const bad = sources.filter((s) => !(TAG_SOURCES as readonly string[]).includes(s));
  if (bad.length > 0) {
    return emitError(`非法 --tag-source: ${bad.join(',')}（可选: ${TAG_SOURCES.join('|')}）`, 'ARGS');
  }
  return sources;
}

// --date-field 解析（P1-6）：合法值域以 db 层为准（advanced.ts VideoFilter.date_field）；
// 非法 → ARGS（同上，CLI 严格校验；HTTP 面非法值静默忽略）。
export function parseDateField(raw: string | undefined): 'first_seen' | 'published_at' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'first_seen' || raw === 'published_at') return raw;
  return emitError(`非法 --date-field: ${raw}（可选: first_seen|published_at）`, 'ARGS');
}

// commander 解析出的原始选项（字符串/布尔），action 内转成 VideosListOpts。
interface ListRawOpts {
  q?: string;
  creator?: string;
  creatorId?: string;
  creatorUid?: string;
  source?: string;
  tid?: string;
  tname?: string;
  tag?: string;
  tags?: string;
  tagSource?: string;
  dateField?: string;
  lang?: string;
  trackType?: string;
  hasSubtitle?: boolean;
  paid?: boolean;
  since?: string;
  until?: string;
  minDuration?: string;
  maxDuration?: string;
  minView?: string;
  maxView?: string;
  sort?: string;
  desc?: string | boolean; // --desc [value]：裸 flag → true；=false/0/no → 升序；缺省 → true（降序）
  page?: string;
  subtitleQ?: string;
  size?: string;
}

// 字符串 → 数字；非法 → ARGS。undefined 透传（filter 不应用）。
export function parseNum(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return emitError(`${name} 不是合法数字: ${raw}`, 'ARGS');
  }
  return n;
}

// since/until 字符串 → 毫秒数字；格式非法（normalizeTimestamp 抛错）→ ARGS。
export function parseTime(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  try {
    return normalizeTimestamp(raw);
  } catch (err) {
    return emitError(`${name}: ${(err as Error).message}`, 'ARGS');
  }
}

// openDbOrEmit 已上收 db.ts（共用，含 DB-only 命令组的显式 --server 忽略警告，2026-10-02）。

export function buildVideosCommand(): Command {
  const videos = new Command('videos')
    .description('查询视频（直连 SQLite 只读）：list / get / get-by-id');

  videos
    .command('list')
    .description('按条件过滤视频列表，返回 {total,page,size,items}')
    .option('--q <text>', '标题 / UP 名模糊匹配')
    .option('--creator <name>', 'UP 名模糊匹配')
    .option('--creator-id <id>', 'UP 库内 id 精确（creators.id；UP 详情页拉该 UP 视频场景）')
    .option('--creator-uid <uid>', 'UP 平台 uid 精确（creators.source_uid，如 B 站 mid；免 mid→id 两跳）')
    .option('--source <src>', '视频来源（精确，如 bilibili）')
    .option('--tid <id>', '分区 tid（精确）')
    .option('--tname <name>', '分区名模糊匹配')
    .option('--tag <tag>', '标签名模糊匹配（extra.tags[].tag_name）')
    .option('--tags <csv>', '标签名精确匹配，逗号分隔多个，AND 语义（与 --tag 模糊单值互补）')
    .option('--tag-source <csv>', `标签档位过滤，逗号分隔 ${TAG_SOURCES.join('|')} 的子集（与 --tag/--tags 搭配收窄匹配档位；单独传=该档位有任一标签）`)
    .option('--date-field <field>', 'since/until 比对的时间列：first_seen|published_at（默认 first_seen）')
    .option('--subtitle-q <text>', '字幕正文关键词模糊匹配（命中 subtitle_versions.payload）')
    .option('--lang <lang>', '字幕语言模糊匹配（如 zh 命中 zh-Hans）')
    .option('--track-type <type>', '字幕轨类型（1=AI 2=CC 3=翻译轨），精确')
    .option('--has-subtitle', '仅含至少一条字幕版本的视频')
    .option('--paid', '仅付费视频（v.paid = 1）')
    .option('--since <ts>', '起始时间（Unix 秒/毫秒 或 ISO8601），比对 --date-field 指定列（默认 first_seen_at）')
    .option('--until <ts>', '结束时间（Unix 秒/毫秒 或 ISO8601），比对 --date-field 指定列（默认 first_seen_at）')
    .option('--min-duration <s>', '最小时长（秒）')
    .option('--max-duration <s>', '最大时长（秒）')
    .option('--min-view <n>', '最小播放量')
    .option('--max-view <n>', '最大播放量')
    .option('--sort <key>', `排序键：${VIDEO_SORT_KEYS.join('|')}（updated_at=最近有动静：重采/变更）`)
    .option('--desc [value]', '降序（默认降序，对齐 HTTP；升序传 --desc=false）')
    .option('--page <n>', '页码（从 1 起，默认 1）')
    .option('--size <n>', '每页条数（默认 20）')
    .action((raw: ListRawOpts) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      const opts: VideosListOpts = {
        q: raw.q,
        creator: raw.creator,
        creatorId: parseNum(raw.creatorId, '--creator-id'),
        creatorUid: raw.creatorUid,
        source: raw.source,
        tid: parseNum(raw.tid, '--tid'),
        tname: raw.tname,
        tag: raw.tag,
        tags: parseTagsCsv(raw.tags),
        tagSource: parseTagSource(raw.tagSource),
        dateField: parseDateField(raw.dateField),
        subtitleQ: raw.subtitleQ,
        lang: raw.lang,
        trackType: parseNum(raw.trackType, '--track-type'),
        hasSubtitle: raw.hasSubtitle,
        paid: raw.paid,
        since: parseTime(raw.since, '--since'),
        until: parseTime(raw.until, '--until'),
        minDuration: parseNum(raw.minDuration, '--min-duration'),
        maxDuration: parseNum(raw.maxDuration, '--max-duration'),
        minView: parseNum(raw.minView, '--min-view'),
        maxView: parseNum(raw.maxView, '--max-view'),
        sort: parseSort(raw.sort),
        desc: parseDesc(raw.desc),
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
