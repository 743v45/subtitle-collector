// danmaku collect 编排层·类型与纯函数（2026-10-07 弹幕采集解冻，规格唯一来源 docs/plans/danmaku/PLAN.md
// §4.2-§4.7/§2.2）。四拆对齐 comments 先例：本文件=类型 + 判定纯函数 + view/extra 解析 + 回执构建；
// I/O 适配在 [danmaku-net.ts](./danmaku-net.ts)；编排循环在 [danmaku-collect.ts](./danmaku-collect.ts)；
// CLI 装配在 [danmaku.ts](./danmaku.ts)。写库只走 server HTTP（D4「CLI 永不写库」）。
// 与评论的差异：cookie 可选（D9 匿名可用）、无 wbi 签名、段循环无游标（seg 单调递增，304 越界哨兵）。
import { defaultSleep } from '../asr-net.js';
import { segmentsForDuration, type DanmakuItem } from '../bili-danmaku.js';

export const BILI_API_DEFAULT = 'https://api.bilibili.com';

/** collect 对 server 的最小客户端面（ServerClient 满足；测试注入 mock）。 */
export interface DanmakuClient {
  getVideo(source: string, vid: string): Promise<Record<string, unknown> | null>;
  danmakuCount(bvid: string): Promise<Record<string, unknown>>;
  danmakuIngest(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  danmakuVerify(bvid: string): Promise<Record<string, unknown>>;
}

export interface DanmakuDeps {
  client: DanmakuClient;
  cookie: string | null;     // 可选（D9 匿名可用）；null = 匿名跑
  cookieFrom?: string;       // cookie 来源（文件路径）；缺省日志记 anonymous
  biliApi?: string;          // 默认 BILI_API_DEFAULT（COLLECTOR_BILI_API/测试指向 mock）
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  now?: () => number;
  random?: () => number;
}

export interface DanmakuOpts {
  bvid?: string;
  aid?: number;
  page: 'all' | number;      // 多 P 选择：all=全采 / n=只采第 n 个分 P（§4.2）
  maxSegments: number;       // 单 P 段数上限（0=不限，以 N=ceil(duration/360) 为准）
  maxRequests: number;       // 单轮 B 站请求预算（默认 300；用尽 → partial request_budget）
  segmentIntervalMs: number; // 段间隔基数 ms（±30% 抖动）
  batchSize: number;         // ingest 批大小（默认 2000）
  dryRun: boolean;
  cookieFile?: string;
}

/** 定位/参数类硬失败（CLI 按 code 映射退出码：ARGS/aid_mismatch→2，video_not_found→5，其余→1）。 */
export class DanmakuError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'DanmakuError'; this.code = code; }
}

/** 分 P 定位信息（view.pages / extra.pages / extra.cid+videos.duration 三路归一）。 */
export interface PageMeta { cid: number; page: number; part: string; duration: number }

/** 风控判定（§4.5）：HTTP 412 / bili-status-code 头或 JSON code ∈ {-412,-352,-799,-509}。-403 不退避（协议变化）。 */
export const RISK_CODES = [-412, -352, -799, -509];
export function isRiskNum(n: number | null): boolean {
  return n != null && (n === -412 || RISK_CODES.includes(n));
}

// ── §4.2 参数解析与纯判定 ──

/** 非负整数选项解析（非法 → DanmakuError ARGS，CLI 映射退 2）。 */
export function intOpt(v: string | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new DanmakuError('ARGS', `--${name} 需非负整数,收到: ${v}`);
  return n;
}

/** collect 纯参数校验 + DanmakuOpts 装配（§4.2）。--bvid+--aid 同给合法（交叉校验由编排层比对 extra/view）；
 * --page 值域 all|正整数；cookieFile 只透传（文件 I/O 在 CLI 装配层，纯参数错先报）。 */
export function parseCollectOpts(raw: {
  bvid?: string; aid?: string; page?: string; maxSegments?: string; maxRequests?: string;
  segmentIntervalMs?: string; batchSize?: string; dryRun?: boolean; cookieFile?: string;
}): DanmakuOpts {
  if (!raw.bvid && !raw.aid) throw new DanmakuError('ARGS', '需要 --bvid 或 --aid');
  let aid: number | undefined;
  if (raw.aid !== undefined) {
    const n = Number(raw.aid);
    if (!Number.isInteger(n) || n <= 0) throw new DanmakuError('ARGS', `--aid 需正整数,收到: ${raw.aid}`);
    aid = n;
  }
  const pageRaw = raw.page ?? 'all';
  let page: 'all' | number;
  if (pageRaw === 'all') page = 'all';
  else {
    const n = Number(pageRaw);
    if (!Number.isInteger(n) || n < 1) throw new DanmakuError('ARGS', `--page 必须是 all 或正整数,收到: ${pageRaw}`);
    page = n;
  }
  return {
    bvid: raw.bvid,
    aid,
    page,
    maxSegments: intOpt(raw.maxSegments, 'max-segments', 0),
    maxRequests: intOpt(raw.maxRequests, 'max-requests', 300),
    segmentIntervalMs: intOpt(raw.segmentIntervalMs, 'segment-interval-ms', 1000),
    batchSize: intOpt(raw.batchSize, 'batch-size', 2000),
    dryRun: !!raw.dryRun,
    cookieFile: raw.cookieFile,
  };
}

/** --page 过滤（§4.2：all=全采 / n=按 pages[].page 精确匹配；越界 → ARGS 退 2 带观测分 P 数）。 */
export function selectPages(pages: PageMeta[], pageArg: 'all' | number): PageMeta[] {
  if (pageArg === 'all') return pages;
  const hit = pages.find((p) => p.page === pageArg);
  if (!hit) {
    const known = pages.map((p) => p.page).join(',');
    throw new DanmakuError('ARGS', `--page ${pageArg} 越界(库内/回查共 ${pages.length} 个分 P: ${known || '无'})`);
  }
  return [hit];
}

/** 段循环判停（§4.4）：seg 超预期段数 N → segments_done（正常）；显式 --max-segments 触顶 → segments_cap（partial）。 */
export function shouldStopSeg(seg: number, expectedN: number, maxSegments: number):
  { stop: boolean; reason?: 'segments_done' | 'segments_cap' } {
  if (seg > expectedN) return { stop: true, reason: 'segments_done' };
  if (maxSegments > 0 && seg > maxSegments) return { stop: true, reason: 'segments_cap' };
  return { stop: false };
}

/**
 * 段循环迭代前置门（§4.3/§4.4 纯,自 danmaku-collect.ts 下沉;2026-10-07 圈复杂度重构）：
 * 每段开跑前依固定次序归一判定 —— 预算用尽（partial request_budget）→ 已硬停（静默断,
 * 硬停原因已由失败路径写入）→ shouldStopSeg（N 正常收口 / segments_cap）。stop=false 才真正发请求。
 */
export function segGate(
  biliRequests: number, maxRequests: number, stoppedPartial: boolean,
  seg: number, expectedN: number, maxSegments: number,
): { stop: false } | { stop: true; reason: 'request_budget' | 'stopped' | 'segments_done' | 'segments_cap' } {
  if (biliRequests >= maxRequests) return { stop: true, reason: 'request_budget' };
  if (stoppedPartial) return { stop: true, reason: 'stopped' };
  const segStop = shouldStopSeg(seg, expectedN, maxSegments);
  return segStop.stop ? { stop: true, reason: segStop.reason ?? 'segments_done' } : { stop: false };
}

// ── 段失败/空段判定（§4.4/§4.5 纯函数,自 danmaku-collect.ts 下沉;2026-10-07 圈复杂度重构）──

/** §4.4:单段连续失败上限（≥3 → 终止 partial seg_fail）。 */
export const SEG_FAIL_LIMIT = 3;

export type SegFailReason = 'risk_abort' | 'protocol_403' | 'need_login' | 'seg_fail';

/**
 * 单段失败 → 判停归一（§4.4/§4.5,纯）：风控终态（三档退避已在 fetchSeg 内走完）→ risk_abort;
 * -403 弹幕接口无 wbi,出现即协议变化不退避 → protocol_403;-101 需登录 → need_login;
 * 其余失败只累计连击,触顶 SEG_FAIL_LIMIT → seg_fail。返回 null = 继续采（不打停）。
 * biliCode 收宽到 string|number|null：http 形态的 bili-status-code 头是字符串,=== 数值比较天然不中。
 */
export function segFailStop(kind: string, biliCode: number | string | null | undefined, streak: number):
  { reason: SegFailReason } | null {
  if (kind === 'risk_abort') return { reason: 'risk_abort' };
  if (kind === 'code' && biliCode === -403) return { reason: 'protocol_403' };
  if (kind === 'code' && biliCode === -101) return { reason: 'need_login' };
  if (streak >= SEG_FAIL_LIMIT) return { reason: 'seg_fail' };
  return null;
}

/** §4.5 空段→非空段警示判定（纯）：有前段、前段全空（fetched=0）、本段非空 → 分段规则疑似改版。 */
export const segPatternChanged = (elemsCount: number, stat: PageStat | undefined): boolean =>
  elemsCount > 0 && stat != null && stat.segments_fetched > 0 && stat.fetched === 0;

// ── view / extra 响应解析（纯）──

/** pages 数组条目校验归一（cid+duration 必备；page 缺省按序号补）。 */
function normPages(raw: unknown): PageMeta[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: PageMeta[] = [];
  for (const p of list) {
    const e = p as { cid?: unknown; page?: unknown; part?: unknown; duration?: unknown };
    if (typeof e.cid === 'number' && e.cid > 0 && typeof e.duration === 'number' && e.duration > 0) {
      out.push({
        cid: e.cid,
        page: typeof e.page === 'number' && e.page > 0 ? e.page : out.length + 1,
        part: typeof e.part === 'string' ? e.part : '',
        duration: e.duration,
      });
    }
  }
  return out;
}

/** view 响应 data → 定位信息（§4.1 D5/D8）：aid/bvid 必备；pages 优先，单 P 兜底走根 cid+duration。 */
export function viewMetaFromData(data: Record<string, unknown>):
  { ok: true; aid: string; bvid: string; title: string | null; pages: PageMeta[]; statDanmaku: number | null }
  | { ok: false; error: string } {
  const aid = typeof data.aid === 'number' && data.aid > 0 ? data.aid : null;
  const bvid = typeof data.bvid === 'string' && data.bvid !== '' ? data.bvid : null;
  if (!aid || !bvid) {
    return { ok: false, error: `view 响应缺 aid/bvid: aid=${String(data.aid)} bvid=${String(data.bvid)}` };
  }
  const pages = normPages(data.pages).length > 0
    ? normPages(data.pages)
    : normPages([{ cid: data.cid, page: 1, part: '', duration: data.duration }]);
  if (pages.length === 0) return { ok: false, error: 'view 响应无可用分 P(pages/cid+duration 均缺失)' };
  const stat = data.stat as { danmaku?: unknown } | undefined;
  const statDanmaku = stat && typeof stat.danmaku === 'number' ? stat.danmaku : null;
  return {
    ok: true, aid: String(aid), bvid,
    title: typeof data.title === 'string' ? data.title : null,
    pages, statDanmaku,
  };
}

/** 库内 video 行 extra → 分 P 列表（§4.3：extra.pages 优先；单 P 兜底 extra.cid + videos.duration）。 */
export function extraPagesOf(video: Record<string, unknown>): PageMeta[] {
  let extra: unknown = video.extra;
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch { return []; }
  }
  if (extra == null || typeof extra !== 'object') return [];
  const ex = extra as Record<string, unknown>;
  const pages = normPages(ex.pages);
  if (pages.length > 0) return pages;
  const duration = typeof video.duration === 'number' ? video.duration : null;
  if (typeof ex.cid === 'number' && ex.cid > 0 && duration != null && duration > 0) {
    return [{ cid: ex.cid, page: 1, part: '', duration }];
  }
  return [];
}

export const extraAidOf = (video: Record<string, unknown>): string | null => {
  let extra: unknown = video.extra;
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch { return null; }
  }
  const aid = extra != null && typeof extra === 'object' ? (extra as Record<string, unknown>).aid : null;
  return aid != null ? String(aid) : null;
};

export const titleOf = (video: Record<string, unknown>): string | null =>
  typeof video.title === 'string' ? video.title : null;

// ── 轮内状态与回执（§4.6）──

/** 单 P 采集统计（回执 pages[] 与段完整性 §5.2：expected/fetched 是采集时点事实，不落库）。 */
export interface PageStat {
  cid: number;
  page: number;
  duration_s: number;
  segments_expected: number;
  segments_fetched: number;
  fetched: number;
}

export interface DmState {
  dryRun: boolean;
  dryRows: number;
  biliRequests: number;
  reqKinds: { view: number; seg: number };
  store: { inserted: number; updated: number; requests: number };
  buffer: DanmakuItem[];
  batchSeq: number;
  ingestFailStreak: number;
  /** 单段连续失败计数（≥3 → 终止 partial，§4.4；成功即清零） */
  segFailStreak: number;
  pageStats: PageStat[];
  riskAbort: boolean;
  stopped: { reason: string; partial: boolean } | null;
}

export const newState = (): DmState => ({
  dryRun: false, dryRows: 0, biliRequests: 0, reqKinds: { view: 0, seg: 0 },
  store: { inserted: 0, updated: 0, requests: 0 },
  buffer: [], batchSeq: 0, ingestFailStreak: 0, segFailStreak: 0,
  pageStats: [], riskAbort: false, stopped: null,
});

export interface DmCtx {
  bvid: string;
  aid: string;
  title: string | null;
  batchId: string;
  statDanmaku: number | null;
  opts: DanmakuOpts;
}

export interface DanmakuReceipt {
  ok: true;
  dry_run: boolean;
  partial: boolean;
  partial_reason?: string;
  video: { bvid: string; aid: number; title: string | null };
  pages: PageStat[];
  fetched_total: number;
  store: { inserted: number; updated: number; requests: number } | { would_requests: number; would_rows: number };
  before_rows: number;
  after_rows: number;
  bili_requests: number;
  elapsed_ms: number;
  stat_danmaku: { view: number | null };
  verify: Record<string, unknown> | null;
}

export const logOf = (deps: DanmakuDeps) => deps.log ?? (() => {});
export const nowOf = (deps: DanmakuDeps) => deps.now ?? Date.now;

/** 段间隔：基数 ×(1±30%) 抖动（§4.5，700-1300ms @1000 基数）。 */
export async function segInterval(deps: DanmakuDeps, opts: DanmakuOpts): Promise<void> {
  const r = deps.random ?? Math.random;
  await (deps.sleep ?? defaultSleep)(Math.round(opts.segmentIntervalMs * (1 + (r() * 0.6 - 0.3))));
}

/** count 响应 → rows（缺省 0；响应形态异常由调用方先验 ok）。 */
export const rowsOf = (r: Record<string, unknown>): number =>
  typeof r.rows === 'number' ? r.rows : 0;

/** 回执构建（§4.6；dry-run store 段为 would_requests/would_rows；partial 附 partial_reason）。 */
export function buildReceipt(
  st: DmState, ctx: DmCtx, elapsedMs: number,
  rows: { before: number; after: number },
  verify: Record<string, unknown> | null,
): DanmakuReceipt {
  const partial = st.stopped?.partial === true;
  const receipt: DanmakuReceipt = {
    ok: true,
    dry_run: st.dryRun,
    partial,
    video: { bvid: ctx.bvid, aid: Number(ctx.aid), title: ctx.title },
    pages: st.pageStats.map((p) => ({ ...p })),
    fetched_total: st.pageStats.reduce((s, p) => s + p.fetched, 0),
    store: st.dryRun
      ? { would_requests: st.store.requests, would_rows: st.dryRows }
      : { ...st.store },
    before_rows: rows.before,
    after_rows: rows.after,
    bili_requests: st.biliRequests,
    elapsed_ms: elapsedMs,
    stat_danmaku: { view: ctx.statDanmaku },
    verify,
  };
  if (partial && st.stopped) receipt.partial_reason = st.stopped.reason;
  return receipt;
}

/** [danmaku] 完成/停直线尾注（对齐 comments-flow stopTag）。 */
export function stopTag(st: DmState): string {
  return st.stopped ? ` [${st.stopped.partial ? 'partial' : 'stop'}:${st.stopped.reason}]` : ' [complete]';
}

/** 单段预期段数（§2.2 N=ceil(duration/360)；编排层日志与 collectPage 用）。 */
export const segCountOf = (p: PageMeta): number => segmentsForDuration(p.duration);
