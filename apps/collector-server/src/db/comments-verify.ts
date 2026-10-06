import type Database from 'better-sqlite3';
import { depthHistogram, likeStats, upStats, ipStats } from './comments-stats.js';
import type { CommentRecord } from './comments.js';

// comments 树完整性校验（PLAN §5.1 R0-R9 / §5.3 verify 回执结构）。
// 从 db/comments.ts 拆出（模块 ≤400 行纪律）：R4 覆盖率口径为纯函数可直测；
// 统计段（depth/like/up/ip）在 comments-stats.ts。全量行载入后 JS 判定（单视频评论量级 ≤数千行）。

// ── R4 覆盖率纯逻辑（与 db 解耦，便于直测 fallback/clamp/overshoot 口径）──

export interface RootCoverageInput {
  rootRpid: string;
  /** 楼中楼接口 page.count 实时分母（调用方采集轮传入）；null/≤0 时 fallback 根行 rcount */
  pageCount: number | null;
  /** 根行 rcount 快照（fallback 分母） */
  rcount: number;
  /** 库内该根楼中楼实采数 */
  actualFloors: number;
}

export interface CoverageSummary {
  mismatch: number;
  samples: string[];
  overshoot: number;
  floorCovered: number;
  floorExpected: number;
  ratio: number;
}

/**
 * 逐根对账（PLAN §5.1 R4 / §5.3 coverage）：
 * 分母 = pageCount(>0，来源 'page.count') 优先，否则 rcount(>0，来源 'rcount fallback')，否则该楼不计入；
 * 缺口 = max(0, 分母−实采)；实采 > 分母 clamp 为 0 并计 overshoot（双来源重复幂等吸收但计数可暂超）；
 * ratio = Σ min(实采,分母) / Σ 分母（无有效分母的空视频按 1=无缺失处理）。
 */
export function coverageOfRoots(entries: RootCoverageInput[], sampleLimit = 10): CoverageSummary {
  let mismatch = 0;
  let overshoot = 0;
  let floorCovered = 0;
  let floorExpected = 0;
  const samples: Array<{ rootRpid: string; gap: number; source: string }> = [];
  for (const e of entries) {
    let denominator: number;
    let source: string;
    if (e.pageCount != null && e.pageCount > 0) {
      denominator = e.pageCount;
      source = 'page.count';
    } else if (e.rcount > 0) {
      denominator = e.rcount;
      source = 'rcount fallback';
    } else {
      continue; // 分母 ≤0 的楼不计入分子分母（§5.3）
    }
    const gap = Math.max(0, denominator - e.actualFloors);
    floorCovered += Math.min(e.actualFloors, denominator);
    floorExpected += denominator;
    if (e.actualFloors > denominator) overshoot++;
    if (gap > 0) {
      mismatch++;
      samples.push({ rootRpid: e.rootRpid, gap, source });
    }
  }
  samples.sort((a, b) => b.gap - a.gap || (a.rootRpid < b.rootRpid ? -1 : 1)); // top = 缺口大者优先
  return {
    mismatch,
    samples: samples.slice(0, sampleLimit).map((s) => `${s.rootRpid}(缺 ${s.gap},分母=${s.source})`),
    overshoot,
    floorCovered,
    floorExpected,
    ratio: floorExpected > 0 ? Math.round((floorCovered / floorExpected) * 10000) / 10000 : 1,
  };
}

export interface VerifyTreeOptions {
  /** R4：根 rpid → 楼中楼接口 page.count 实时分母（采集轮内 verify 传入；缺省走 rcount fallback） */
  rootPageCounts?: Record<string, number>;
  /** R9 外部总量参照 = max(cursor.all_count, view stat.reply)（PLAN §5.1）；缺省/0 跳过 R9 */
  externalTotal?: number | null;
  /** R4 mismatch 样本上限（§5.1 取 top 10） */
  mismatchSampleLimit?: number;
}

export interface VerifyTreeResult {
  counts: {
    roots: number;
    floors: number;
    total: number;
    pins: number;
    missing_candidates: number;
    missing_confirmed: number;
  };
  integrity: {
    triple_inconsistent: number;      // R0 error
    orphan_floor: number;             // R1 error
    dangling_parent: number;          // R2 error
    dangling_dialog: number;          // R3 warn
    rcount_mismatch: number;          // R4
    rcount_mismatch_samples: string[];
    overshoot: number;                // R4 实采>分母楼数
    field_anomaly: number;            // R5 warn（reply_total < rcount；§5.3 示例未列键名，取规则名「字段自洽」）
    dup_rpid: number;                 // R6 error（UNIQUE 下恒 0，防御性断言）
    time_anomaly: number;             // R8 warn
    root_count_gap: number;           // R9 warn
  };
  depth: { max: number; histogram: Record<string, number> };
  like: { p50: number; p90: number; p99: number; max: number; zero_pct: number };
  coverage: { floor_covered: number; floor_expected: number; ratio: number };
  up: { up_replied: number; up_liked: number; is_up_rows: number };
  ip: { known_pct: number; top: Array<[string, number]> };
}

/**
 * 树完整性校验 + 统计（ok/bvid 由调用方包装进回执）。
 * R6 走内存 Set 防御性断言（UNIQUE 约束下恒 0，触发即库损坏）。
 * R9 口径：库内侧为「活跃评论行数」（全部行扣除确认缺失的根）——B 站 all_count/stat.reply 是
 * 评论区总量口径（含楼中楼），与根数直接对比会对任何有楼视频恒报 gap（§5.3 示例
 * roots=95/total=1893 而 root_count_gap=0 佐证；与 PLAN §5.1 R9 字面「活跃根数」的偏离在此登记）。
 */
export function verifyTree(
  db: Database.Database,
  videoId: number,
  opts: VerifyTreeOptions = {},
): VerifyTreeResult {
  const rows = db.prepare('SELECT * FROM comments WHERE video_id = ?').all(videoId) as CommentRecord[];
  const byRpid = new Map(rows.map((r) => [r.rpid_str, r]));
  const roots = rows.filter((r) => r.is_root === 1);
  const floors = rows.filter((r) => r.is_root !== 1);

  // R0：根行要求 is_root=1 且 root='0' 且 parent='0'；楼行要求 root!=='0' 且 is_root=0（含 is_root 派生一致性）
  const tripleInconsistent = rows.filter((r) => {
    const rootShape = r.root_rpid === '0';
    if ((r.is_root === 1) !== rootShape) return true;
    return rootShape ? r.parent_rpid !== '0' : r.parent_rpid === '0';
  }).length;
  // R1：非根行 root 指向库内不存在的行（本视频域内判树完整性）
  const orphanFloor = floors.filter((r) => r.root_rpid !== '0' && !byRpid.has(r.root_rpid)).length;
  // R2：parent 悬空
  const danglingParent = rows.filter((r) => r.parent_rpid !== '0' && !byRpid.has(r.parent_rpid)).length;
  // R3：dialog 悬空（指向既不在库也非自身；直回根 dialog=自身 不算）
  const danglingDialog = rows.filter((r) =>
    r.dialog_rpid !== '0' && r.dialog_rpid !== r.rpid_str && !byRpid.has(r.dialog_rpid)).length;
  // R5：历史总数 < 可见数，必是异常
  const fieldAnomaly = rows.filter((r) => r.reply_total < r.rcount).length;
  // R6：重复 rpid（防御性断言）
  const dupRpid = rows.length - byRpid.size;
  // R8：楼中楼行发布早于其根行
  const timeAnomaly = floors.filter((r) => {
    if (r.ctime_s == null) return false;
    const root = byRpid.get(r.root_rpid);
    return root != null && root.ctime_s != null && r.ctime_s < root.ctime_s;
  }).length;

  // R7：missing 分档（仅根评论）
  const missingCandidates = roots.filter((r) => r.missing_since != null).length;
  const missingConfirmed = roots.filter((r) =>
    r.missing_since != null && r.last_seen_at < r.missing_since).length;

  // R4：逐根对账（分母优先 page.count，fallback rcount）
  const floorCountByRoot = new Map<string, number>();
  for (const f of floors) floorCountByRoot.set(f.root_rpid, (floorCountByRoot.get(f.root_rpid) ?? 0) + 1);
  const coverage = coverageOfRoots(roots.map((r) => ({
    rootRpid: r.rpid_str,
    pageCount: opts.rootPageCounts?.[r.rpid_str] ?? null,
    rcount: r.rcount,
    actualFloors: floorCountByRoot.get(r.rpid_str) ?? 0,
  })), opts.mismatchSampleLimit ?? 10);

  // R9：活跃行数 vs 外部总量，相对偏差 >10%
  const activeRows = rows.filter((r) =>
    !(r.is_root === 1 && r.missing_since != null && r.last_seen_at < r.missing_since)).length;
  const external = opts.externalTotal ?? null;
  const rootCountGap = external != null && external > 0
    && Math.abs(activeRows - external) / external > 0.1 ? 1 : 0;

  return {
    counts: {
      roots: roots.length,
      floors: floors.length,
      total: rows.length,
      pins: rows.filter((r) => r.pin_kind != null).length,
      missing_candidates: missingCandidates,
      missing_confirmed: missingConfirmed,
    },
    integrity: {
      triple_inconsistent: tripleInconsistent,
      orphan_floor: orphanFloor,
      dangling_parent: danglingParent,
      dangling_dialog: danglingDialog,
      rcount_mismatch: coverage.mismatch,
      rcount_mismatch_samples: coverage.samples,
      overshoot: coverage.overshoot,
      field_anomaly: fieldAnomaly,
      dup_rpid: dupRpid,
      time_anomaly: timeAnomaly,
      root_count_gap: rootCountGap,
    },
    depth: depthHistogram(rows),
    like: likeStats(rows),
    coverage: {
      floor_covered: coverage.floorCovered,
      floor_expected: coverage.floorExpected,
      ratio: coverage.ratio,
    },
    up: upStats(rows),
    ip: ipStats(rows),
  };
}
