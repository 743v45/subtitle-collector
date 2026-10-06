// comments collect 编排层·类型与纯函数（C4，规格唯一来源 docs/plans/comments/PLAN.md §4.2-§4.8/附录 A）。
// 三拆（对齐 asr 先例，PLAN §7.2「超出就照 asr 三拆再拆 comments-run.ts」）：
//   本文件=类型 + 判定纯函数 + 原始条目裁剪 + 回执构建；I/O 适配在 [comments-net.ts](./comments-net.ts)；
//   编排循环在 [comments-collect.ts](./comments-collect.ts)。
// 流程概要：定位（server getVideo + extra.aid/view 回查）→ wbi keys 进程缓存（nav）→
//   full 游标遍历（mode=2 时间序，next_offset 不透明黑盒包裹 {"offset":原文} 透传，A.3 裁定①）
//   / incremental 水位追新（direction 不携带，裁定②）→ 楼中楼翻全（page.count 实时分母）
//   → 完整轮守卫（仅完整轮 ingest full_scan:true 触发 missing 对账 + pins 先清后打）
//   → 内嵌 verify。写库只走 server HTTP（「CLI 永不写库」D4）。
// 已登记偏差（详见 C4 交付报告）：① full_scan 标记批复用末条 raw 条目承载（ingest 端点要求
//   replies 非空，伪代码的独立 marker 调用会 400）；② 增量轮增长判定/refresh-roots 的「库内已采楼数/
//   库内 like 降序 top-N」缺 per-root 查询端点（C2 只有 count/verify 聚合），以「本轮已见楼数」安全方向
//   退化（宁多翻不漏翻），refresh-roots 重翻域=本轮所见根。
import { readFileSync } from 'node:fs';
import { defaultSleep } from '../asr-net.js';
import { nextMainPageArgs, type MainCursor } from '../bili-comments.js';

export const BILI_API_DEFAULT = 'https://api.bilibili.com';
export const WEB_LOCATION = 1315875; // wbi/main 固定参数（PLAN §8.3）

/** collect 对 server 的最小客户端面（ServerClient 满足；测试注入 mock）。 */
export interface CommentsClient {
  getVideo(source: string, vid: string): Promise<Record<string, unknown> | null>;
  commentsCount(bvid: string): Promise<Record<string, unknown>>;
  commentsIngest(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  commentsVerify(bvid: string): Promise<Record<string, unknown>>;
}

export interface CollectDeps {
  client: CommentsClient;
  cookie: string;            // Cookie 头原样值（必配，CLI 装配已校验）
  cookieFrom?: string;       // cookie 来源描述（日志用：文件路径）
  biliApi?: string;          // 默认 BILI_API_DEFAULT（COLLECTOR_BILI_API/测试指向 mock）
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  now?: () => number;
  random?: () => number;
}

export interface CollectOpts {
  bvid?: string;
  aid?: string;
  mode: 'auto' | 'full' | 'incremental';
  sort: 'hot' | 'time';
  maxPages: number;        // 0=不限
  maxFloorPages: number;   // 0=不限
  refreshRoots: number;    // 增量轮附带 top-N 强制重翻
  maxRequests: number;     // 单轮 B 站请求预算（默认 600）
  dryRun: boolean;
  pageIntervalMs: number;  // 页间隔基数（±30% 抖动）
  batchSize: number;       // ingest 批大小
  bvidFile?: string;
}

/** 定位/参数类硬失败（CLI 按 code 映射退出码：ARGS/aid_mismatch→2，video_not_found→5，其余→1）。 */
export class CollectError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'CollectError'; this.code = code; }
}

export type WbiKeys = { img_key: string; sub_key: string } | null;
export interface RootInfo { rpid: string; rcount: number; like: number }
export type RawEntry = Record<string, unknown>;
export type PinTag = { rpid_str: string; kind: string };

// ── 原始条目子集（§4.1：CLI 只砍不用的顶层键以控传输体量；服务端 parseReplyRow 解析归一）──

const ENTRY_KEYS = [
  'rpid', 'rpid_str', 'root', 'root_str', 'parent', 'parent_str', 'dialog', 'dialog_str',
  'mid', 'mid_str', 'member', 'content', 'like', 'rcount', 'count', 'ctime',
  'state', 'invisible', 'folder', 'up_action', 'reply_control',
] as const;

export function pickEntry(raw: unknown): RawEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: RawEntry = {};
  for (const k of ENTRY_KEYS) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

const entryStr = (e: RawEntry, strKey: string, numKey: string): string | null => {
  const s = e[strKey];
  if (typeof s === 'string' && s !== '') return s;
  const n = e[numKey];
  return typeof n === 'number' && Number.isFinite(n) ? String(n) : null;
};
export const entryRpid = (e: RawEntry): string | null => entryStr(e, 'rpid_str', 'rpid');
export const entryRoot = (e: RawEntry): string => entryStr(e, 'root_str', 'root') ?? '0';
const entryNum = (e: RawEntry, k: string): number =>
  typeof e[k] === 'number' && Number.isFinite(e[k]) ? (e[k] as number) : 0;
export const entryRcount = (e: RawEntry): number => entryNum(e, 'rcount');
export const entryLike = (e: RawEntry): number => entryNum(e, 'like');

/** [parse] 命中计数（§4.7：字段命中率 x/total，<100% 附缺失样本 rpid ≤5）。 */
export function parseHitStats(entries: RawEntry[]): {
  total: number; member: number; content: number; ctime: number; like: number;
  emote: number; pics: number; missing: string[];
} {
  const s = { total: entries.length, member: 0, content: 0, ctime: 0, like: 0, emote: 0, pics: 0, missing: [] as string[] };
  for (const e of entries) {
    const rpid = entryRpid(e) ?? '?';
    const c = e.content as Record<string, unknown> | undefined;
    if (e.member != null) s.member++; else if (s.missing.length < 5) s.missing.push(rpid);
    if (c != null && typeof c === 'object') {
      s.content++;
      if (typeof e.ctime === 'number') s.ctime++; else if (s.missing.length < 5) s.missing.push(rpid);
      if (typeof e.like === 'number') s.like++;
      if (c.emote != null) s.emote++;
      s.pics += Array.isArray(c.picture) ? (c.picture as unknown[]).length : 0;
    } else if (s.missing.length < 5 && e.member == null) s.missing.push(rpid);
  }
  return s;
}

// ── 纯判定函数（§7.2：编排循环抽纯函数，直测 §4.4 判停表）──

export type MainStop =
  | { stop: true; reason: string; partial: boolean }
  | { stop: false; next: string | null };

/** 主列表单页后的判停决策（§4.4，判定序：空页护栏 → 水位/游标 → max-pages）。 */
export function shouldStopMain(a: {
  mode: 'full' | 'incremental';
  cursor: MainCursor | null;
  usedOffset: string | null;   // 本页请求所用 offset（首页 null）
  rowCount: number;
  emptyPages: number;          // 计入本页后的连续空页数
  minCtime: number | null;
  watermark: number;
  pagesDone: number;
  maxPages: number;            // 0=不限
}): MainStop {
  if (a.emptyPages >= 2) return { stop: true, reason: 'empty_pages_suspicious', partial: true };
  if (a.mode === 'incremental' && a.rowCount > 0 && a.minCtime != null && a.minCtime <= a.watermark) {
    return { stop: true, reason: 'watermark', partial: false };
  }
  const next = nextMainPageArgs(a.usedOffset, { cursor: a.cursor });
  if (next === null) {
    if (a.cursor?.is_end) return { stop: true, reason: 'is_end', partial: false };
    if (a.usedOffset !== null && a.cursor?.next_offset === a.usedOffset) {
      return { stop: true, reason: 'cursor_spin', partial: true };
    }
    return { stop: true, reason: 'cursor_missing', partial: true };
  }
  if (a.maxPages > 0 && a.pagesDone >= a.maxPages) {
    return { stop: true, reason: 'max_pages_cap', partial: true };
  }
  return { stop: false, next };
}

/** 楼中楼单页后的判停决策（§4.4/§4.5）：count>0 用 got>=count；缺失/0 用连续 2 空页（防首页即停）。 */
export function shouldStopFloor(a: {
  rowCount: number;
  emptyPages: number;
  got: number;
  pageCount: number | null;
  pn: number;
  maxFloorPages: number;   // 0=不限
}): { stop: boolean; reason: 'count_reached' | 'empty_pages' | 'floor_pages_cap' | null; partial: boolean } {
  if (a.emptyPages >= 2) return { stop: true, reason: 'empty_pages', partial: false };
  if (a.pageCount != null && a.pageCount > 0 && a.got >= a.pageCount) {
    return { stop: true, reason: 'count_reached', partial: false };
  }
  if (a.maxFloorPages > 0 && a.pn >= a.maxFloorPages) {
    return { stop: true, reason: 'floor_pages_cap', partial: true };
  }
  return { stop: false, reason: null, partial: false };
}

/** 完整轮守卫（§3.3/§4.3：is_end + 无风控/空页异常 + 伪完整轮 activeRows×1.2 < max(all_count, stat.reply)）。 */
export function completeRoundGuard(a: {
  isEndReached: boolean;
  riskAbort: boolean;
  emptySuspicious: boolean;
  activeRows: number | null;   // count 端点复查；null=查询失败（跳过伪完整判定，不拦完整轮）
  allCount: number | null;
  statReply: number | null;
}): { complete: boolean; suspicious: boolean } {
  const external = Math.max(a.allCount ?? 0, a.statReply ?? 0);
  const suspicious = a.activeRows != null && external > 0 && a.activeRows * 1.2 < external;
  return { complete: a.isEndReached && !a.riskAbort && !a.emptySuspicious && !suspicious, suspicious };
}

/** refresh-roots 选取（like 降序 top-N；域=本轮所见根——库内全域选取缺端点，见头部偏差②）。 */
export function selectRefreshRoots(roots: RootInfo[], n: number): RootInfo[] {
  return [...roots].sort((x, y) => (y.like - x.like) || (x.rpid < y.rpid ? -1 : 1)).slice(0, Math.max(0, n));
}

/** fetchBiliJson 错误码 → 数字（'bili_12002' → 12002；非 bili_<n> 形态 → null）。 */
export function biliCodeNum(code: string): number | null {
  const m = /^bili_(-?\d+)$/.exec(code);
  return m ? Number(m[1]) : null;
}

export function readBvidFile(path: string): string[] {
  let text: string;
  try { text = readFileSync(path, 'utf-8'); } catch {
    throw new CollectError('ARGS', `--bvid-file 不可读: ${path}`);
  }
  const bvids = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  if (bvids.length === 0) throw new CollectError('ARGS', `--bvid-file 无有效行(每行一个 BV，# 注释): ${path}`);
  return bvids;
}

// ── 轮内状态与回执 ──

export interface RoundState {
  dryRun: boolean;
  dryRows: number;
  biliRequests: number;
  reqKinds: { nav: number; view: number; main: number; floor: number };
  pages: { main: number; floor: number };
  fetched: { roots: number; floors: number; previews: number; pins: number };
  store: { inserted: number; updated: number; requests: number };
  buffer: RawEntry[];
  batchSeq: number;
  ingestFailStreak: number;
  pins: PinTag[];
  lastEntry: RawEntry | null;
  allCount: number | null;
  statReply: number | null;
  upperMid: string | null;
  rootInfo: Map<string, RootInfo>;
  /** 根 → 本轮已见楼层 rpid 集合（唯一计数；预览+专翻共用，增量轮无增长跳过的依据） */
  floorSeen: Map<string, Set<string>>;
  /** 最近一次 ingest 成功响应的 missing 对账结果（full_scan 标记批产生；§4.8 missing 段） */
  lastMissing: { candidates: number; confirmed: number } | null;
  isEndReached: boolean;
  riskAbort: boolean;
  emptySuspicious: boolean;
  commentsDisabled: boolean;
  stopped: { reason: string; partial: boolean } | null;
  lastMainPage: number;
}

export const newRoundState = (): RoundState => ({
  dryRun: false, dryRows: 0, biliRequests: 0, reqKinds: { nav: 0, view: 0, main: 0, floor: 0 },
  pages: { main: 0, floor: 0 }, fetched: { roots: 0, floors: 0, previews: 0, pins: 0 },
  store: { inserted: 0, updated: 0, requests: 0 },
  buffer: [], batchSeq: 0, ingestFailStreak: 0, pins: [], lastEntry: null,
  allCount: null, statReply: null, upperMid: null,
  rootInfo: new Map(), floorSeen: new Map(), lastMissing: null,
  isEndReached: false, riskAbort: false, emptySuspicious: false, commentsDisabled: false,
  stopped: null, lastMainPage: 0,
});

export interface RoundCtx {
  bvid: string;
  aid: string;
  title: string | null;
  mode: 'full' | 'incremental';
  sort: 'hot' | 'time';
  watermark: number;
  scanStart: number;
  batchId: string;
  opts: CollectOpts;
}

export interface CollectVideoReceipt {
  ok: true;
  bvid: string;
  dry_run: boolean;
  partial: boolean;
  partial_reason?: string;
  video: { bvid: string; aid: string | null; title: string | null };
  mode: 'full' | 'incremental';
  sort: 'hot' | 'time';
  pages: { main: number; floor: number };
  fetched: { roots: number; floors: number; previews: number; pins: number; total: number };
  store: { inserted: number; updated: number; requests: number } | { would_requests: number; rows: number };
  bili_requests: number;
  elapsed_ms: number;
  missing: { candidates: number; confirmed: number } | null;
  verify: Record<string, unknown> | null;
  stat_reply: { view: number | null; all_count: number | null };
  comments_disabled?: boolean;
}

export interface CollectBatchReceipt {
  ok: boolean;
  batch: true;
  dry_run: boolean;
  total: number;
  succeeded: number;
  failed: number;
  results: Array<CollectVideoReceipt | { bvid: string; ok: false; error: string; code: string }>;
}

export const logOf = (deps: CollectDeps) => deps.log ?? (() => {});
export const nowOf = (deps: CollectDeps) => deps.now ?? Date.now;

export function isRiskCode(code: string): boolean {
  return ['risk_control', 'bili_-412', 'bili_-352', 'bili_-799', 'bili_-509'].includes(code);
}

/** 页间隔：基数 ×(1±30%) 抖动（§8.1，1400-2600ms @2000 基数）。 */
export async function pageInterval(deps: CollectDeps, opts: CollectOpts): Promise<void> {
  const r = deps.random ?? Math.random;
  await (deps.sleep ?? defaultSleep)(Math.round(opts.pageIntervalMs * (1 + (r() * 0.6 - 0.3))));
}

/** 回执构建（§4.8；total=roots+floors，预览不计；dry-run store 段为 would_requests/rows）。 */
export function buildReceipt(
  st: RoundState, ctx: RoundCtx, elapsedMs: number,
  missing: { candidates: number; confirmed: number } | null,
  verify: Record<string, unknown> | null,
): CollectVideoReceipt {
  const total = st.fetched.roots + st.fetched.floors;
  const partial = st.stopped?.partial === true;
  const receipt: CollectVideoReceipt = {
    ok: true,
    bvid: ctx.bvid,
    dry_run: st.dryRun,
    partial,
    video: { bvid: ctx.bvid, aid: ctx.aid, title: ctx.title },
    mode: ctx.mode,
    sort: ctx.sort,
    pages: { ...st.pages },
    fetched: { ...st.fetched, total },
    store: st.dryRun
      ? { would_requests: st.store.requests, rows: st.dryRows }
      : { ...st.store },
    bili_requests: st.biliRequests,
    elapsed_ms: elapsedMs,
    missing,
    verify,
    stat_reply: { view: st.statReply, all_count: st.allCount },
  };
  if (partial && st.stopped) receipt.partial_reason = st.stopped.reason;
  if (st.commentsDisabled) receipt.comments_disabled = true;
  return receipt;
}

/** 内嵌 verify 投影（§4.8 回执四字段；stderr 日志由调用方带更全指标）。 */
export function projectVerify(v: Record<string, unknown>): Record<string, unknown> {
  const integ = (v.integrity ?? {}) as Record<string, unknown>;
  const cov = (v.coverage ?? {}) as Record<string, unknown>;
  return {
    coverage: typeof cov.ratio === 'number' ? cov.ratio : null,
    rcount_mismatch: typeof integ.rcount_mismatch === 'number' ? integ.rcount_mismatch : null,
    orphan_floor: typeof integ.orphan_floor === 'number' ? integ.orphan_floor : null,
    dangling_parent: typeof integ.dangling_parent === 'number' ? integ.dangling_parent : null,
  };
}
