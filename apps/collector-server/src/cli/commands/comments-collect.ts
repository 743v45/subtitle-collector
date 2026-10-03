// comments collect 编排循环（C4，规格唯一来源 docs/plans/comments/PLAN.md §4.3-§4.8）。
// 纯判定在 comments-run.ts、I/O 适配在 comments-net.ts、单视频阶段函数（prepareRound/
// completeRoundStep/finishRound）在 comments-flow.ts、CLI 装配在 commands/comments.ts
//（2026-10-04 质量门重构：超复杂函数按职责拆出，行为与日志逐字不变）。
// 主流程 collectOne：定位 → count 模式判定 → wbi keys → 主列表游标遍历（mode=2 时间序；hot 快照前置；
// 增量按水位停）→ 楼中楼翻全（page.count 实时分母）→ 冲尾批 → 完整轮守卫（count 复查+伪完整判定）
// → full_scan 标记批（偏差①，见 comments-run.ts 头注）→ 内嵌 verify → 回执（§4.8）。
import {
  biliCodeNum, entryLike, entryRcount, entryRpid, entryRoot, isRiskCode, logOf,
  newRoundState, pageInterval, parseHitStats, pickEntry, readBvidFile,
  selectRefreshRoots, shouldStopFloor, shouldStopMain,
  type CollectBatchReceipt, type CollectDeps, type CollectOpts, type CollectVideoReceipt,
  type MainStop, type RawEntry, type RoundState, type WbiKeys,
} from './comments-run.js';
import {
  fetchMainPage, flushBuffer, flushRemainder, handleMainFailure, loadWbi, sleepMs,
} from './comments-net.js';
import { completeRoundStep, finishRound, prepareRound } from './comments-flow.js';
import { fetchBiliJson } from '../asr-net.js';
import { isEmptyShell, parseFloorPage, parseMain, replyDiag, type MainCursor } from '../bili-comments.js';

/** 原始条目吸收（主列表页：根形条目计根+rootInfo，楼形条目计预览并记 floorSeen）。
 * rpid 重复（游标重叠/置顶双出现）只更新观测不重复计数——根/楼计数=唯一 rpid 数，与 verify 对齐。
 * 所有 picked 条目进攒批缓冲（§4.2 --batch-size 随到随冲；幂等 upsert,重复 rpid 服务端去重）。 */
function absorbMainRows(st: RoundState, raws: RawEntry[]): void {
  for (const raw of raws) {
    const rpid = entryRpid(raw);
    if (!rpid) continue; // rpid 不可定位 → 服务端也会弃，本地不计数
    st.lastEntry = raw;
    st.buffer.push(raw);
    if (entryRoot(raw) === '0') {
      if (!st.rootInfo.has(rpid)) st.fetched.roots++;
      st.rootInfo.set(rpid, { rpid, rcount: entryRcount(raw), like: entryLike(raw) });
    } else {
      const root = entryRoot(raw);
      const seen = st.floorSeen.get(root);
      if (seen) seen.add(rpid); else st.floorSeen.set(root, new Set([rpid]));
      st.fetched.previews++;
    }
  }
}

/** 原始条目吸收（楼中楼页：根形条目=内嵌根行刷新 rootInfo 不计根；楼形计楼）。
 * 全部 picked 条目（含内嵌根行,幂等 upsert）进攒批缓冲。返回本页楼数。 */
function absorbFloorRows(st: RoundState, raws: RawEntry[]): number {
  let floors = 0;
  for (const raw of raws) {
    const rpid = entryRpid(raw);
    if (!rpid) continue;
    st.lastEntry = raw;
    st.buffer.push(raw);
    if (entryRoot(raw) === '0') {
      st.rootInfo.set(rpid, { rpid, rcount: entryRcount(raw), like: entryLike(raw) });
      continue;
    }
    const root = entryRoot(raw);
    const seen = st.floorSeen.get(root);
    if (seen) {
      if (!seen.has(rpid)) { seen.add(rpid); st.fetched.floors++; floors++; }
    } else {
      st.floorSeen.set(root, new Set([rpid]));
      st.fetched.floors++;
      floors++;
    }
  }
  return floors;
}

/** data.replies 顶层条目裁剪（置顶/主列表共用形态）。 */
function rawRepliesOf(data: Record<string, unknown>): RawEntry[] {
  const list = Array.isArray(data.replies) ? data.replies : [];
  const out: RawEntry[] = [];
  for (const r of list) {
    const e = pickEntry(r);
    if (e && entryRpid(e)) out.push(e);
  }
  return out;
}

/** 置顶三类别裁剪（§2.5：置顶本体入库唯一路径，随首页批走）。 */
function rawPinsOf(data: Record<string, unknown>): RawEntry[] {
  const top = (data.top ?? {}) as Record<string, unknown>;
  const out: RawEntry[] = [];
  for (const kind of ['admin', 'upper', 'vote'] as const) {
    const e = pickEntry(top[kind]);
    if (e && entryRpid(e)) out.push(e);
  }
  return out;
}

// ── 主列表页消化子步（自 processMainPage 拆出，2026-10-04 质量门重构）──

/** [fetch] main 取数行日志（§4.7；?? 缺省占位逐字保留）。 */
function mainFetchLog(
  log: (m: string) => void, st: RoundState, parsed: ReturnType<typeof parseMain>,
  page: number, status?: number, bytes?: number,
): void {
  const topKind = parsed.pins.map((p) => p.kind).join('+');
  log(`[fetch] main page=${page} http=${status ?? '-'} bytes=${bytes ?? '-'} code=0 roots=${parsed.roots.length} previews=${parsed.previews.length} top=${topKind || '-'} all_count=${parsed.cursor?.all_count ?? '-'} is_end=${parsed.cursor?.is_end ?? '-'}(累计 B 站请求 ${st.biliRequests})`);
}

/** all_count 哨兵捕获（完整轮守卫伪完整判定输入）。 */
function captureAllCount(st: RoundState, parsed: ReturnType<typeof parseMain>): void {
  if (parsed.cursor?.all_count != null) st.allCount = parsed.cursor.all_count;
}

/** upper.mid 捕获（ingest upper_mid 字段；0/'0'/'' 视为缺失不捕获）。 */
function captureUpperMid(st: RoundState, data: Record<string, unknown>): void {
  if (st.upperMid == null) {
    const um = (data.upper as { mid?: unknown } | undefined)?.mid;
    if (um != null && um !== 0 && um !== '0' && um !== '') st.upperMid = String(um);
  }
}

/** 置顶标记登记（full 轮标记批 pins 先清后打的打值清单；同 rpid 重复出现只记一次）。 */
function registerPins(st: RoundState, parsed: ReturnType<typeof parseMain>): void {
  for (const p of parsed.pins) {
    if (p.row.rpid_str && !st.pins.some((q) => q.rpid_str === p.row.rpid_str)) {
      st.pins.push({ rpid_str: p.row.rpid_str, kind: p.kind });
    }
  }
}

/** 页面形态告警：空壳形态（旧接口特征）与 v_voucher 风控凭证——如实报告不走自动化（§8.5）。 */
function pageDiagnostics(log: (m: string) => void, data: Record<string, unknown>, page: number): void {
  if (isEmptyShell(data)) log(`[parse] main page=${page} 空壳形态(page 全 0+replies null,旧接口特征) ${replyDiag(data)}`);
  if (data.v_voucher != null) log(`[fetch] main page=${page} 响应带 v_voucher 风控凭证——如实报告不走自动化(§8.5) ${replyDiag(data)}`);
}

/** 根条目最小 ctime（增量水位判停的推进参考；无 ctime 样本 → null）。 */
function minCtimeOf(rawRoots: RawEntry[]): number | null {
  const ctimes = rawRoots.map((e) => (typeof e.ctime === 'number' ? e.ctime : null)).filter((v): v is number => v != null);
  return ctimes.length > 0 ? Math.min(...ctimes) : null;
}

/** 主列表单页消化（§4.3 parseMain 步 + §4.7 [fetch]/[parse] 日志 + 攒批冲刷）。
 * 返回 cursor=parseCursor 产物（MainCursor 形态：next_offset 已从 pagination_reply 提升）——
 * runMain 判停必须喂解析态而非 data.cursor 原文（原文 next_offset 嵌在 pagination_reply 下，
 * 直接透传会使 nextMainPageArgs 取空 → 首页反复重取/cursor_spin 误判，2026-10-04 修正）。 */
async function processMainPage(
  deps: CollectDeps, st: RoundState, ctx: Parameters<typeof flushBuffer>[2],
  data: Record<string, unknown>, page: number, status?: number, bytes?: number,
): Promise<{ rowCount: number; minCtime: number | null; empty: boolean; cursor: MainCursor | null }> {
  const log = logOf(deps);
  const parsed = parseMain(data);
  mainFetchLog(log, st, parsed, page, status, bytes);
  captureAllCount(st, parsed);
  captureUpperMid(st, data);
  const rawRoots = rawRepliesOf(data);
  const rawPins = rawPinsOf(data);
  st.fetched.pins += rawPins.length;
  registerPins(st, parsed);
  const stats = parseHitStats(rawRoots);
  log(`[parse] main page=${page} 根评论 ${stats.member}/${stats.total} member ${stats.content}/${stats.total} content ${stats.ctime}/${stats.total} ctime ${stats.like}/${stats.total} like | 预览 ${parsed.previews.length} | emote=${stats.emote} pics=${stats.pics}${stats.missing.length ? ` | 缺失样本=${stats.missing.join(',')}` : ''}`);
  pageDiagnostics(log, data, page);
  absorbMainRows(st, rawRoots);
  absorbMainRows(st, rawPins);
  await flushBuffer(deps, st, ctx, { page, sort: ctx.sort });
  return { rowCount: rawRoots.length, minCtime: minCtimeOf(rawRoots), empty: rawRoots.length === 0, cursor: parsed.cursor };
}

/** 热评快照（§4.2 --sort hot：full 轮首页 mode=3 快照随到随冲；主遍历仍从 mode=2 首页开始）。
 * 快照页失败降级继续时间序遍历（不拦整轮）。 */
async function hotSnapshot(deps: CollectDeps, st: RoundState, ctx: Parameters<typeof flushBuffer>[2], box: { keys: WbiKeys }): Promise<void> {
  const log = logOf(deps);
  log('[fetch] main sort=hot 快照页(mode=3,随到随冲)');
  const r = await fetchMainPage(deps, st, box, ctx.aid, '', 3);
  if (!r.ok) {
    log(`[fetch] hot 快照页失败 code=${r.code} → 降级继续时间序遍历`);
    return;
  }
  await processMainPage(deps, st, ctx, r.data, 0, r.status, r.bytes);
  await pageInterval(deps, ctx.opts);
}

// ── 遍历判停子步（自 runMain/crawlFloors 拆出，2026-10-04 质量门重构）──

/** B 站请求预算闸（runMain/crawlFloors 共用）：用尽 → partial request_budget。 */
function budgetStop(deps: CollectDeps, st: RoundState, ctx: Parameters<typeof flushBuffer>[2]): boolean {
  if (st.biliRequests < ctx.opts.maxRequests) return false;
  logOf(deps)(`[fetch] B 站请求预算用尽(${ctx.opts.maxRequests}) → partial(重跑幂等续采)`);
  st.stopped = { reason: 'request_budget', partial: true };
  return true;
}

/** 主遍历判停落地：原因日志 + 观测旗标 + stopped 写入。
 * 页内攒批冲刷若已置硬停（ingest_fail）则优先保留——is_end 等正常终态不得覆盖硬停
 *（as {…|null} 读：processMainPage 经闭包改写 stopped，TS 判定收窄已失效）。 */
function noteMainStop(
  deps: CollectDeps, st: RoundState, page: number,
  stop: Extract<MainStop, { stop: true }>, data: Record<string, unknown>,
): void {
  const log = logOf(deps);
  if (stop.reason === 'cursor_spin') log(`[fetch] main page=${page} next_offset 与上页相同(打转护栏) ${replyDiag(data)}`);
  if (stop.reason === 'cursor_missing') log(`[fetch] main page=${page} 游标缺失(next_offset 空且非 is_end) ${replyDiag(data)}`);
  if (stop.reason === 'empty_pages_suspicious') st.emptySuspicious = true;
  if (stop.reason === 'is_end') st.isEndReached = true;
  const halted = (st.stopped as { partial?: boolean } | null)?.partial === true;
  if (!halted) st.stopped = { reason: stop.reason, partial: stop.partial };
}

/** 主列表遍历（§4.3 步 4/5；预算/空页/水位/游标/max-pages 判停见 shouldStopMain）。 */
async function runMain(deps: CollectDeps, st: RoundState, ctx: Parameters<typeof flushBuffer>[2], box: { keys: WbiKeys }): Promise<void> {
  if (ctx.mode === 'full' && ctx.sort === 'hot') await hotSnapshot(deps, st, ctx, box);
  let offset: string | null = null;
  let emptyPages = 0;
  let pagesDone = 0;
  for (;;) {
    if (st.stopped) return;
    if (budgetStop(deps, st, ctx)) return;
    const page = pagesDone + 1;
    const r = await fetchMainPage(deps, st, box, ctx.aid, offset ?? '', 2);
    if (!r.ok) { handleMainFailure(deps, st, r, page); return; }
    pagesDone = page;
    st.pages.main = page;
    st.lastMainPage = page;
    const { rowCount, minCtime, empty, cursor } = await processMainPage(deps, st, ctx, r.data, page, r.status, r.bytes);
    emptyPages = empty ? emptyPages + 1 : 0;
    const stop = shouldStopMain({
      mode: ctx.mode, cursor, usedOffset: offset, rowCount, emptyPages, minCtime,
      watermark: ctx.watermark, pagesDone, maxPages: ctx.opts.maxPages,
    });
    if (stop.stop) {
      noteMainStop(deps, st, page, stop, r.data);
      return;
    }
    offset = stop.next;
    await pageInterval(deps, ctx.opts);
  }
}

/** B 站 JSON 请求（楼中楼等直拼 URL；deps 透传 cookie/fetch/sleep/log）。 */
function biliJson(deps: CollectDeps, url: string) {
  return fetchBiliJson({ cookie: deps.cookie, fetchImpl: deps.fetchImpl, sleep: deps.sleep, log: deps.log }, url);
}

/** 楼中楼取数失败归一（§4.6）：-101 cookie 失效终止 / 12002·12061 按无楼终态 /
 * 风控系 riskAbort / 其余如实失败 partial。 */
function floorFailure(
  deps: CollectDeps, st: RoundState, root: { rpid: string; rcount: number }, pn: number,
  r: { ok: false; code: string; message: string },
): void {
  const log = logOf(deps);
  const num = biliCodeNum(r.code);
  if (r.code === 'need_login') {
    log(`[fetch] floor root=${root.rpid} pn=${pn} code=-101 → cookie 失效,终止本轮(partial)`);
    st.stopped = { reason: 'need_login', partial: true };
    return;
  }
  if (num === 12002 || num === 12061) {
    log(`[fetch] floor root=${root.rpid} pn=${pn} code=${num} → 按无楼处理(评论区关闭/楼已删,正常终态)`);
    return;
  }
  if (isRiskCode(r.code)) st.riskAbort = true;
  log(`[fetch] floor root=${root.rpid} pn=${pn} 失败 code=${r.code} message=${r.message} → 终止本轮(partial)`);
  st.stopped = { reason: r.code, partial: true };
}

/** 单根楼中楼翻全（§4.5：/x/v2/reply/reply ps=20 无 wbi；分母=data.page.count 实时值，
 * 缺失/0 → 连续 2 空页护栏；data.root 内嵌根行刷新 rootInfo；12002/12061 按无楼终态）。 */
async function crawlFloors(
  deps: CollectDeps, st: RoundState, ctx: Parameters<typeof flushBuffer>[2],
  root: { rpid: string; rcount: number },
): Promise<void> {
  const log = logOf(deps);
  const biliApi = deps.biliApi ?? 'https://api.bilibili.com';
  let pn = 1;
  let got = 0;
  let emptyPages = 0;
  for (;;) {
    if (st.stopped?.partial) return; // 仅硬停拦;is_end/watermark 常态放行（2026-10-04 修正）
    if (budgetStop(deps, st, ctx)) return;
    const url = `${biliApi}/x/v2/reply/reply?type=1&oid=${encodeURIComponent(ctx.aid)}&root=${encodeURIComponent(root.rpid)}&pn=${pn}&ps=20&sort=0`;
    st.biliRequests++;
    st.reqKinds.floor++;
    const r = await biliJson(deps, url);
    if (!r.ok) { floorFailure(deps, st, root, pn, r); return; }
    const data = r.data;
    const raws: RawEntry[] = [];
    const rootEntry = pickEntry(data.root);
    if (rootEntry && entryRpid(rootEntry)) raws.push(rootEntry);
    raws.push(...rawRepliesOf(data));
    const parsed = parseFloorPage(data);
    const floors = absorbFloorRows(st, raws);
    got += floors;
    st.pages.floor++;
    log(`[fetch] floor root=${root.rpid} pn=${pn} http=${r.status ?? '-'} bytes=${r.bytes ?? '-'} rows=${floors} count=${parsed.pageCount ?? '-'} got=${got}(累计 B 站请求 ${st.biliRequests})`);
    await flushBuffer(deps, st, ctx, { page: null, sort: null });
    // 空页计数先并入本轮再判停：连续 2 空页=第 2 次空取后即停，不多发第 3 请求（2026-10-04 修正）
    emptyPages = floors === 0 ? emptyPages + 1 : 0;
    const stop = shouldStopFloor({
      rowCount: floors, emptyPages, got, pageCount: parsed.pageCount, pn,
      maxFloorPages: ctx.opts.maxFloorPages,
    });
    if (stop.stop) {
      if (stop.reason === 'floor_pages_cap') {
        st.stopped = { reason: 'floor_pages_cap', partial: true };
        log(`[floor] root=${root.rpid} 触及 --max-floor-pages=${ctx.opts.maxFloorPages} 上限 → partial`);
      }
      return;
    }
    pn++;
    await pageInterval(deps, ctx.opts);
  }
}

/** 楼中楼总调度（§4.3 步 6）：增量轮 rcount<=已采 跳过（无增长）、--refresh-roots top-N 强制重翻。 */
async function runFloors(deps: CollectDeps, st: RoundState, ctx: Parameters<typeof flushBuffer>[2]): Promise<void> {
  const log = logOf(deps);
  const all = [...st.rootInfo.values()];
  const forcedSet = ctx.mode === 'incremental' && ctx.opts.refreshRoots > 0
    ? new Set(selectRefreshRoots(all, ctx.opts.refreshRoots).map((r) => r.rpid))
    : new Set<string>();
  for (const root of all) {
    if (st.stopped?.partial) return; // 仅硬停拦正常翻楼;is_end/watermark 等正常终态照走（2026-10-04 修正）
    const forced = forcedSet.has(root.rpid);
    const seen = st.floorSeen.get(root.rpid)?.size ?? 0;
    if (!forced) {
      // 非 forced 才走两类 skip；refresh-roots 强制重翻必须穿透（rcount=0/无增长都拦不住它）
      if (root.rcount <= 0 && seen === 0) {
        log(`[floor] skip root=${root.rpid} rcount=0(无楼)`);
        continue;
      }
      if (ctx.mode === 'incremental' && root.rcount <= seen) {
        log(`[floor] skip root=${root.rpid} rcount=${root.rcount} 已采=${seen}(无增长)`);
        continue;
      }
    }
    log(`[floor] root=${root.rpid} rcount=${root.rcount} → 翻页中${forced ? '(refresh-roots 强制重翻)' : ''}`);
    await crawlFloors(deps, st, ctx, root);
  }
}

// ── 内嵌 verify（§4.8）已并入 comments-flow.ts finishRound（2026-10-04 拆分）──

/** 单视频采集全流程（§4.3）。partial 轮不触发 full_scan 标记批/missing 对账（§3.3 守卫）。 */
export async function collectOne(deps: CollectDeps, opts: CollectOpts, bvid: string): Promise<CollectVideoReceipt> {
  const st = newRoundState();
  st.dryRun = opts.dryRun;
  const box: { keys: WbiKeys } = { keys: null };
  const { ctx, t0 } = await prepareRound(deps, st, opts, bvid);
  const wbi = await loadWbi(deps, st, box, false);
  if (!wbi.ok) {
    throw Object.assign(new Error(wbi.message), { code: wbi.code === 'need_login' ? 'need_login' : 'run_error' });
  }
  await runMain(deps, st, ctx, box);
  // 楼中楼/冲尾闸门=「硬停(partial)」而非「有任何 stop」：is_end/watermark 是正常终态
  //（stopped 非空但 partial:false），楼中楼翻全与尾批冲刷必须照走；partial 轮只冲手头不翻页（§3.3）。
  if (!st.stopped?.partial) await runFloors(deps, st, ctx);
  if (!st.stopped?.partial) await flushRemainder(deps, st, ctx, { page: st.lastMainPage || null, sort: ctx.sort });
  const missing = await completeRoundStep(deps, st, ctx);
  return finishRound(deps, st, ctx, t0, missing);
}

/** collect 入口：单视频直通；--bvid-file 批量（§4.2 串行+5s 间隔、失败不阻断、-101 中止批量）。 */
export async function runCollect(deps: CollectDeps, opts: CollectOpts): Promise<CollectVideoReceipt | CollectBatchReceipt> {
  const log = logOf(deps);
  if (!opts.bvidFile) return collectOne(deps, opts, opts.bvid as string);
  const bvids = readBvidFile(opts.bvidFile);
  log(`[comments] --bvid-file 批量:${bvids.length} 视频,串行+间隔 5s,失败不阻断`);
  const results: CollectBatchReceipt['results'] = [];
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < bvids.length; i++) {
    const bvid = bvids[i];
    if (i > 0) await sleepMs(deps, 5000);
    try {
      const r = await collectOne(deps, opts, bvid);
      results.push(r);
      succeeded++;
      if (r.partial && r.partial_reason === 'need_login') {
        log('[comments] cookie 失效(-101) → 批量中止(§4.2)');
        break;
      }
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'run_error';
      const message = (e as Error).message;
      results.push({ bvid, ok: false, error: message, code });
      failed++;
      log(`[comments] ${bvid} 失败(${code}): ${message} —— 批量继续下一个`);
      if (code === 'need_login') {
        log('[comments] cookie 失效(-101) → 批量中止(§4.2)');
        break;
      }
    }
  }
  return { ok: failed === 0, batch: true, dry_run: opts.dryRun, total: bvids.length, succeeded, failed, results };
}
