// collector-cli 汇总命令组：stats overview / stats count。
// 设计参考 [设计文档 §3.2](docs/superpowers/specs/2026-07-05-collector-cli-design.md)。
// 架构同 videos.ts：commander 薄包装 + 纯处理函数。措辞：字幕（subtitle），非弹幕。

import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { getCliContext } from '../main.js';
import { emitResult, emitError } from '../output.js';
import { openReadonlyDb } from '../db.js';
import { countOverview, aggregateStats } from '../../db/advanced.js';
import type { Overview, KeyValue, StatsGroupBy, VideoFilter } from '../../db/advanced.js';
import { normalizeTimestamp } from './videos.js';

// ── 纯处理函数 ──

// stats overview 纯处理：总览计数（视频/轨/版本/UP/语言/分区 + first_seen 时间范围）。
export function statsOverview(db: Database.Database): Overview {
  return countOverview(db);
}

export interface StatsCountOpts {
  by: StatsGroupBy;
  topN?: number;
  filter?: VideoFilter;  // 已解析（数值字段为数字、since/until 为毫秒）
}

// stats count 纯处理：分组聚合计数，委托 aggregateStats（默认 Top 20）。
export function statsCount(db: Database.Database, opts: StatsCountOpts): KeyValue[] {
  return aggregateStats(db, opts.by, opts.filter ?? {}, opts.topN ?? 20);
}

// ── commander 装配 ──

const STATS_GROUP_BY = ['creator', 'tname', 'lang', 'track-type'] as const;

interface StatsCountRawOpts {
  by?: string;
  top?: string;
  q?: string; creator?: string; source?: string; tid?: string; tname?: string; tag?: string; lang?: string;
  trackType?: string; hasSubtitle?: boolean; since?: string; until?: string; minDuration?: string; maxDuration?: string;
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

// --by 必填且限定 4 值；commander 的 requiredOption 兜底缺失，这里再校验取值。
function parseGroupBy(raw: string | undefined): StatsGroupBy {
  if (raw === undefined || !(STATS_GROUP_BY as readonly string[]).includes(raw)) {
    return emitError(`非法 --by: ${raw ?? '(缺失)'}（可选: ${STATS_GROUP_BY.join('|')}）`, 'ARGS');
  }
  return raw as StatsGroupBy;
}

function openDbOrEmit(dbPath: string): Database.Database {
  try { return openReadonlyDb(dbPath); }
  catch (err) { return emitError((err as Error).message, 'DB_UNREADABLE'); }
}

export function buildStatsCommand(): Command {
  const stats = new Command('stats')
    .description('数据汇总（直连 SQLite 只读）：overview / count');

  stats
    .command('overview')
    .description('总览：视频/轨/版本/UP/语言/分区数 + first_seen 时间范围')
    .action(() => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      emitResult(statsOverview(db), ctx.format);
    });

  stats
    .command('count')
    .description('按维度分组计数（默认 Top 20）；过滤项同 videos list')
    .requiredOption('--by <kind>', '分组维度：creator|tname|lang|track-type')
    .option('--top <n>', 'Top N（默认 20）')
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
    .action((raw: StatsCountRawOpts) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      // VideoFilter 用 snake_case（对齐 advanced.ts），从 camelCase 原始选项转换
      const filter: VideoFilter = {
        q: raw.q,
        creator: raw.creator,
        source: raw.source,
        tid: parseNum(raw.tid, '--tid'),
        tname: raw.tname,
        tag: raw.tag,
        lang: raw.lang,
        track_type: parseNum(raw.trackType, '--track-type'),
        has_subtitle: raw.hasSubtitle,
        since: parseTime(raw.since, '--since'),
        until: parseTime(raw.until, '--until'),
        min_duration: parseNum(raw.minDuration, '--min-duration'),
        max_duration: parseNum(raw.maxDuration, '--max-duration'),
      };
      const data = statsCount(db, {
        by: parseGroupBy(raw.by),
        topN: parseNum(raw.top, '--top'),
        filter,
      });
      emitResult(data, ctx.format);
    });

  return stats;
}
