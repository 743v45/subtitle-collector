// export bundle 弹幕导出（C6，PLAN docs/plans/danmaku/PLAN.md §6）：
// manifest danmaku 摘要批量查询（IN + GROUP BY 防 N+1，§6.2）+ danmaku/<BV号>.md 时间轴正文渲染（§6.1）。
// 从 bundle.ts 拆出独立模块（模块 ≤400 行纪律，对齐 bundle-comments 先例）；时间轴查询复用
// db/danmaku.ts 的 danmakuTimeline（C1 产物，注释明示「供 bundle 正文与导出」）。
// 措辞：弹幕（danmaku），与字幕（subtitle）/评论（comment）三类分离——字幕=语音转写轨，
// 评论=评论区两层树，弹幕=画面上滚动的时间轴弹幕（PLAN 头部措辞边界）。
// 峰值/分桶口径（§6.2，与 danmaku-verify R4 直方图同构）：progress_ms>=0 按 60000ms 整除分桶
// （SQLite 整数除法向零截断，非负守卫下即 floor），先按 (video_id, cid, 桶) 计数（多 P 同分钟
// 不合并）再对视频取 max；负值/NULL（高级弹幕无时间点）不计峰值、不进分钟桶，渲染时归各 P
// 「无时间点」小节（保真原池不丢行）。

import type Database from 'better-sqlite3';
import type { DanmakuRecord } from '../db/danmaku.js';

// ── manifest 摘要（§6.2）──

/** manifest video 条目的 danmaku 摘要统计（file 由组装方按 danmaku/<source_vid>.md 补齐，BundleCommentsStats 同款拆法） */
export interface BundleDanmakuStats {
  rows: number;              // 总条数（含无时间点条目）
  pages: number;             // 分 P 数（COUNT(DISTINCT cid)，0 行 P 不计）
  peak_minute_rows: number;  // 峰值分钟条数（(video,cid,60s 桶) 最大桶计数；无正点行 = 0）
  last_collected_at: number; // MAX(last_seen_at) 毫秒
}

export interface BundleDanmakuMeta extends BundleDanmakuStats {
  file: string;              // 「danmaku/<BV号>.md」相对 bundle 根
}

/**
 * 批量取全视频弹幕统计（§6.2 实现要点）：stats 与峰值各一条聚合查询算全量视频（防 N+1，
 * 对齐 commentsMetaByVideoIds 先例）。库内 0 弹幕的视频不在返回 Map——组装方以 'danmaku' in v
 * 判别省略字段；全负值/NULL（无正点行）视频峰值保持 0（行仍在 Map，入 Map 条件是 rows>0）。
 */
export function danmakuMetaByVideoIds(
  db: Database.Database,
  ids: number[],
): Map<number, BundleDanmakuStats> {
  const map = new Map<number, BundleDanmakuStats>();
  if (ids.length === 0) return map;
  const ph = ids.map(() => '?').join(',');
  const stats = db.prepare(
    `SELECT video_id,
            COUNT(*) AS rows_count,
            COUNT(DISTINCT cid) AS pages,
            MAX(last_seen_at) AS last_collected_at
       FROM danmaku WHERE video_id IN (${ph})
       GROUP BY video_id`,
  ).all(...ids) as Array<{
    video_id: number; rows_count: number; pages: number; last_collected_at: number;
  }>;
  for (const s of stats) {
    map.set(s.video_id, {
      rows: s.rows_count, pages: s.pages,
      peak_minute_rows: 0, last_collected_at: s.last_collected_at,
    });
  }
  // 峰值分钟：先按 (video_id, cid, 60s 桶) 计数，JS 对视频取 max（两条简单 GROUP BY + JS 聚合，
  // comments 先例同款；不用嵌套子查询——IN 占位符免传两遍，多 P 同分钟桶天然隔离不合并）。
  // progress_ms >= 0 守卫排除负值（-1 高级弹幕）与 NULL（三值逻辑自动过滤）。
  const peakByVideo = new Map<number, number>();
  for (const b of db.prepare(
    `SELECT video_id, cid, progress_ms / 60000 AS bucket, COUNT(*) AS bucket_rows
       FROM danmaku
      WHERE video_id IN (${ph}) AND progress_ms >= 0
      GROUP BY video_id, cid, bucket`,
  ).all(...ids) as Array<{ video_id: number; cid: number; bucket: number; bucket_rows: number }>) {
    const cur = peakByVideo.get(b.video_id) ?? 0;
    if (b.bucket_rows > cur) peakByVideo.set(b.video_id, b.bucket_rows);
  }
  for (const [videoId, peak] of peakByVideo) {
    const s = map.get(videoId);
    if (s) s.peak_minute_rows = peak;
  }
  return map;
}

// ── danmaku/<BV号>.md 正文渲染（§6.1）──

const dateFromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** 毫秒 → `分:秒`（两位补零、分钟位不封顶——弹幕以「分钟」为口径，>1h 视频第 90 分钟即 90:00；非负入参下即 floor） */
function mmss(progressMs: number): string {
  const sec = Math.floor(progressMs / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 60s 桶区间标签：`00:00-01:00`（起点=桶起点，终点=起点+60s） */
const bucketLabel = (fromMs: number): string => `${mmss(fromMs)}-${mmss(fromMs + 60000)}`;

/** mode 尾注（§6.1）：mode 1 滚动为默认形态不加注；mode>1（4 底部/5 顶部/7 高级…）尾注 `[M<mode>]`；NULL 不加 */
const modeTag = (r: DanmakuRecord): string => (r.mode != null && r.mode > 1 ? ` [M${r.mode}]` : '');

/** 有时间点弹幕行：`[MM:SS] 内容[ [M<mode>]]`（content 理论非空，NULL 兜底空串） */
const timedLine = (r: DanmakuRecord): string => `[${mmss(r.progress_ms ?? 0)}] ${r.content ?? ''}${modeTag(r)}`;

/** 单 P 内有正点行分桶：分钟 → 行（升序沿用入参序；负值/NULL 由调用方另行收集） */
function bucketsOf(rows: DanmakuRecord[]): Map<number, DanmakuRecord[]> {
  const byBucket = new Map<number, DanmakuRecord[]>();
  for (const r of rows) {
    if (r.progress_ms == null || r.progress_ms < 0) continue;
    const m = Math.floor(r.progress_ms / 60000);
    const list = byBucket.get(m);
    if (list) list.push(r);
    else byBucket.set(m, [r]);
  }
  return byBucket;
}

/** 单 P 分组：页码取组内首行（同 cid 的 page 恒一致）、分钟桶、无时间点行（负值/NULL，§2.3 高级弹幕形态）单列 */
interface PGroup {
  page: number;
  cid: number;
  buckets: Map<number, DanmakuRecord[]>;
  timeless: DanmakuRecord[];
}

/** timeline → P 分组（按 cid 升序——timeline 序本就 cid 升序，显式排序防入参漂移；页码取组内首行，同 cid 的 page 恒一致） */
function groupsOf(timeline: DanmakuRecord[]): PGroup[] {
  const byCid = new Map<number, DanmakuRecord[]>();
  for (const r of timeline) {
    const list = byCid.get(r.cid);
    if (list) list.push(r);
    else byCid.set(r.cid, [r]);
  }
  return [...byCid.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cid, rows]) => ({
      page: rows[0].page, cid,
      buckets: bucketsOf(rows),
      timeless: rows.filter((r) => r.progress_ms == null || r.progress_ms < 0),
    }));
}

/** 峰值分钟（头部统计行）：与 danmakuMetaByVideoIds 的 SQL 口径同构（(cid,60s 桶) 计数取视频 max，并列取分钟小者）——两实现的对账由 bundle-danmaku.test.ts 峰值用例守漂移 */
function peakOf(groups: PGroup[]): { fromMs: number; rows: number } | undefined {
  let peak: { fromMs: number; rows: number } | undefined;
  for (const g of groups) {
    for (const [minute, bucketRows] of g.buckets) {
      const fromMs = minute * 60000;
      if (!peak || bucketRows.length > peak.rows
        || (bucketRows.length === peak.rows && fromMs < peak.fromMs)) {
        peak = { fromMs, rows: bucketRows.length };
      }
    }
  }
  return peak;
}

/** 单 P 正文行：分钟桶小节（桶内 progress 升序逐条）+ 无时间点小节（有行才出）；prefix 为多 P 时的 `P<N> ` 前缀，单 P 传空串 */
function groupLines(g: PGroup, prefix: string): string[] {
  const lines: string[] = [];
  for (const minute of [...g.buckets.keys()].sort((a, b) => a - b)) {
    const rows = g.buckets.get(minute)!;
    lines.push(`## ${prefix}${bucketLabel(minute * 60000)}(${rows.length} 条)`);
    for (const r of rows) lines.push(timedLine(r));
    lines.push('');
  }
  if (g.timeless.length > 0) {
    lines.push(`## ${prefix}无时间点(${g.timeless.length} 条)`);
    for (const r of g.timeless) lines.push(`- ${r.content ?? ''}${modeTag(r)}`);
    lines.push('');
  }
  return lines;
}

/**
 * 渲染单视频弹幕时间轴正文（§6.1 格式；纯函数，timeline 由 danmakuTimeline 保证 cid/progress_ms/id 升序）。
 * - 头部：`# 弹幕 · <source_vid>` + 统计行（采集日/总条数/分 P 数/峰值分钟区间，可有的段才带——
 *   全部无正点行时峰值段省略）+ 说明行；
 * - 多 P：每 P 一个 `## P<page> cid=<cid>` 分组，桶小节标题前缀 `P<page> ` 防跨 P 重名；单 P 直接桶小节；
 * - P 内按 60s 桶分小节 `## [P<N> ]MM:SS-MM:SS(N 条)`，桶内按 progress 升序逐条 `[MM:SS] 内容`；
 * - 无时间点行（progress 负值/NULL）归 P 末尾「无时间点(N 条)」小节（不进分钟桶、行首无时间戳）；
 * - 调用约定：全 0 弹幕不应调用（bundle.ts 挂点以 stats 存在即 rows>0 判定，comments 同款）。
 * 实现三拆（圈复杂度静态门）：groupsOf 分组 / peakOf 峰值 / groupLines 单 P 正文，本函数只做装配。
 */
export function renderDanmakuMd(
  video: { source_vid: string; title: string },
  meta: BundleDanmakuStats,
  timeline: DanmakuRecord[],
): string {
  const groups = groupsOf(timeline);
  const peak = peakOf(groups);
  const peakSeg = peak ? ` · 峰值分钟 ${bucketLabel(peak.fromMs)}(${peak.rows} 条)` : '';
  const lines: string[] = [
    `# 弹幕 · ${video.source_vid}`,
    `> 采集 ${dateFromMs(meta.last_collected_at)} · 共 ${meta.rows} 条 · ${meta.pages} 个分 P${peakSeg}`,
    '> 按 progress 时间升序;`[M]`=mode(1 滚动 5 顶部 4 底部);时间轴为弹幕显示时间。',
    '',
  ];
  const multi = groups.length > 1;
  for (const g of groups) {
    if (multi) lines.push(`## P${g.page} cid=${g.cid}`, '');
    lines.push(...groupLines(g, multi ? `P${g.page} ` : ''));
  }
  return `${lines.join('\n')}\n`;
}
