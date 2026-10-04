// comments 统计段（PLAN §5.3 verify 回执的 depth/like/up/ip 四段）。
// 从 db/comments.ts 的 verifyTree 拆出（模块 ≤400 行纪律）；行入参用结构化最小类型
// （不 import comments.ts，避免 db 内部环），CommentRecord 天然满足。
// 时间口径提醒：ctime_s 是 B 站原值 unix 秒；本模块只用 like/is_up/ip/parent 链，不涉时间换算。

// ── 树深度：按 parent 链算（楼内互复链可 >2；根恒深度 1，直回根的楼中楼=2）──

interface DepthRow {
  rpid_str: string;
  parent_rpid: string;
  is_root: number;
}

export interface DepthStats {
  max: number;
  histogram: Record<string, number>; // 键为深度字符串（JSON 对象键），如 { "1": 95, "2": 280 }
}

/**
 * 深度直方图。边界处理对齐 PLAN §2.4：
 * - 悬空 parent（被回复条已删）→ 上提挂楼根，深度记 2；
 * - parent='0' 但 is_root=0（R0 违例脏行）→ 按根深度 1 处理（防丢行）；
 * - 环防御：parent 链成环（不应发生）→ 按深度 2 收口，不无限递归。
 */
export function depthHistogram(rows: DepthRow[]): DepthStats {
  const byRpid = new Map(rows.map((r) => [r.rpid_str, r]));
  const memo = new Map<string, number>();
  const inProgress = new Set<string>();
  const depthOf = (r: DepthRow): number => {
    const known = memo.get(r.rpid_str);
    if (known !== undefined) return known;
    if (r.is_root === 1 || r.parent_rpid === '0') {
      memo.set(r.rpid_str, 1);
      return 1;
    }
    if (inProgress.has(r.rpid_str)) return 2; // 环防御
    inProgress.add(r.rpid_str);
    const parent = byRpid.get(r.parent_rpid);
    const d = parent ? depthOf(parent) + 1 : 2; // 悬空 parent 上提挂楼根
    inProgress.delete(r.rpid_str);
    memo.set(r.rpid_str, d);
    return d;
  };
  const histogram: Record<string, number> = {};
  let max = 0;
  for (const r of rows) {
    const d = depthOf(r);
    const key = String(d);
    histogram[key] = (histogram[key] ?? 0) + 1;
    if (d > max) max = d;
  }
  return { max, histogram };
}

// ── 点赞分位（全部评论行；nearest-rank 法，确定性可测）──

interface LikeRow {
  like_count: number;
}

export interface LikeStats {
  p50: number;
  p90: number;
  p99: number;
  max: number;
  zero_pct: number; // 0 赞占比，两位小数
}

/** nearest-rank 分位：sorted 为升序数组，q∈(0,1]；空数组回落 0 */
function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length, Math.max(1, Math.ceil(q * sortedAsc.length))) - 1;
  return sortedAsc[idx];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

export function likeStats(rows: LikeRow[]): LikeStats {
  const values = rows.map((r) => r.like_count ?? 0).sort((a, b) => a - b);
  const zeros = values.filter((v) => v === 0).length;
  return {
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p99: percentile(values, 0.99),
    max: values.length > 0 ? values[values.length - 1] : 0,
    zero_pct: values.length > 0 ? round2(zeros / values.length) : 0,
  };
}

// ── UP 互动计数（§5.3 up 段）──

interface UpRow {
  up_like: number;
  up_reply: number;
  is_up: number;
}

export function upStats(rows: UpRow[]): { up_replied: number; up_liked: number; is_up_rows: number } {
  return {
    up_replied: rows.filter((r) => r.up_reply === 1).length,
    up_liked: rows.filter((r) => r.up_like === 1).length,
    is_up_rows: rows.filter((r) => r.is_up === 1).length,
  };
}

// ── IP 属地分布（§5.3 ip 段：已知占比 + top N）──

interface IpRow {
  ip_location: string | null;
}

export function ipStats(rows: IpRow[], topN = 5): { known_pct: number; top: Array<[string, number]> } {
  const known = rows.filter((r) => r.ip_location != null && r.ip_location !== '');
  const counts = new Map<string, number>();
  for (const r of known) counts.set(r.ip_location as string, (counts.get(r.ip_location as string) ?? 0) + 1);
  // 同计数按地名升序 tie，保证确定性
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, topN)
    .map(([loc, n]) => [loc, n] as [string, number]);
  return { known_pct: rows.length > 0 ? round2(known.length / rows.length) : 0, top };
}
