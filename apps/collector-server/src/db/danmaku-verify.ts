import type Database from 'better-sqlite3';
import { danmakuCount } from './danmaku.js';

// danmaku 校验统计（PLAN §5.1 R1-R5 / §5.3 verify 回执结构）。
// 从 db/danmaku.ts 的职责拆出（模块 ≤400 行纪律，对齐 comments-verify.ts 先例）：
// R1/R2 完整性走 SQL 聚合；R3/R4/R5 统计段 SQL 取数 + JS 收口（单视频弹幕量级 ≤数千行，
// 全量载入亦可，但可 SQL 聚合的不载行——学 comments-verify 折中）。

export interface VerifyDanmakuResult {
  counts: {
    rows: number;
    pages: number;
    by_page: Array<{ cid: number; page: number; rows: number }>;
  };
  timeline: {
    min_progress_ms: number | null;
    max_progress_ms: number | null;
    /** 60s 直方图（仅 progress_ms >= 0 的行——负值高级弹幕无分钟位置，R1 单独计数；
     *  from_ms = progress_ms 整除 60000 后还原的桶起点，升序） */
    histogram_60s: Array<{ from_ms: number; rows: number }>;
    /** 峰值分钟（rows 最大桶；并列取 from_ms 小者；无桶=无正点行 → null） */
    peak_minute: { from_ms: number; rows: number } | null;
  };
  /** mode 值分布（键 = mode 十进制字符串；SQL GROUP BY 升序出键） */
  mode: Record<string, number>;
  /** weight 分位（仅非空 weight 行；无行 → null——0 是合法权重不作占位） */
  weight: { p50: number | null; p90: number | null; max: number | null };
  integrity: {
    /** COUNT(*) vs COUNT(DISTINCT id_str)（UNIQUE 下恒 0，防御性断言，触发即库损坏） */
    dup_id: number;
    /** R1：非高级弹幕（mode < 7，SQL 三值逻辑自动排除 NULL mode）出现负时间点 */
    negative_progress: number;
  };
  ctime: { min_s: number | null; max_s: number | null };
}

/** nearest-rank 分位：sorted 为升序数组，q∈(0,1]；空数组回落 null（对齐 comments-stats 先例，0 是合法权重不作占位） */
function percentile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length, Math.max(1, Math.ceil(q * sortedAsc.length))) - 1;
  return sortedAsc[idx];
}

/**
 * 弹幕校验 + 统计（PLAN §5.1 / §5.3；ok/bvid 由调用方包装进回执）。
 * 口径备注：
 * - min/max_progress_ms 取全部非空原值（含 -1）——§2.3 原值保留；直方图仅正点行（>= 0）。
 * - 整除分桶：SQLite 整数除法向零截断，progress_ms >= 0 守卫下即 floor 语义。
 * - negative_progress 条件逐字对齐 R1：progress_ms IS NOT NULL AND progress_ms < 0 AND mode < 7。
 */
export function verifyDanmaku(db: Database.Database, videoId: number): VerifyDanmakuResult {
  const counts = danmakuCount(db, videoId);

  // R4：60s 桶直方图 + 峰值分钟（SQL GROUP BY 一次出全量桶）
  const buckets = db.prepare(`
    SELECT (progress_ms / 60000) * 60000 AS from_ms, COUNT(*) AS rows_count
    FROM danmaku
    WHERE video_id = ? AND progress_ms >= 0
    GROUP BY from_ms ORDER BY from_ms ASC
  `).all(videoId) as Array<{ from_ms: number; rows_count: number }>;
  const histogram = buckets.map((b) => ({ from_ms: b.from_ms, rows: b.rows_count }));
  // 峰值并列取 from_ms 小者：升序扫 + 严格大于替换
  let peak: { from_ms: number; rows: number } | null = null;
  for (const b of histogram) {
    if (peak == null || b.rows > peak.rows) peak = b;
  }

  // R1：负时间点且非高级弹幕（mode < 7；NULL mode 由三值逻辑自动排除）
  const { negative_progress: negativeProgress } = db.prepare(`
    SELECT COUNT(*) AS negative_progress FROM danmaku
    WHERE video_id = ? AND progress_ms IS NOT NULL AND progress_ms < 0 AND mode < 7
  `).get(videoId) as { negative_progress: number };

  // R3：mode 值分布（NULL 不入分布；键升序）
  const modeRows = db.prepare(`
    SELECT mode, COUNT(*) AS rows_count FROM danmaku
    WHERE video_id = ? AND mode IS NOT NULL
    GROUP BY mode ORDER BY mode ASC
  `).all(videoId) as Array<{ mode: number; rows_count: number }>;
  const mode: Record<string, number> = {};
  for (const m of modeRows) mode[String(m.mode)] = m.rows_count;

  // R3：weight 分位（非空值升序取数，JS nearest-rank）
  const weights = (db.prepare(`
    SELECT weight FROM danmaku
    WHERE video_id = ? AND weight IS NOT NULL
    ORDER BY weight ASC
  `).all(videoId) as Array<{ weight: number }>).map((r) => r.weight);

  // R2 + R5：dup_id 防御断言、ctime 范围
  const { total, distinctTotal, minCtimeS, maxCtimeS } = db.prepare(`
    SELECT COUNT(*) AS total,
           COUNT(DISTINCT id_str) AS distinctTotal,
           MIN(ctime_s) AS minCtimeS,
           MAX(ctime_s) AS maxCtimeS
    FROM danmaku WHERE video_id = ?
  `).get(videoId) as {
    total: number;
    distinctTotal: number;
    minCtimeS: number | null;
    maxCtimeS: number | null;
  };

  return {
    counts: {
      rows: counts.rows,
      pages: counts.pages.length,
      by_page: counts.pages,
    },
    timeline: {
      min_progress_ms: counts.min_progress_ms,
      max_progress_ms: counts.max_progress_ms,
      histogram_60s: histogram,
      peak_minute: peak,
    },
    mode,
    weight: {
      p50: percentile(weights, 0.5),
      p90: percentile(weights, 0.9),
      max: weights.length > 0 ? weights[weights.length - 1] : null,
    },
    integrity: {
      dup_id: total - distinctTotal,
      negative_progress: negativeProgress,
    },
    ctime: { min_s: minCtimeS, max_s: maxCtimeS },
  };
}
