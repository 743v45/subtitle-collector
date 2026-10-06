// comments collect 单视频阶段函数（C4；2026-10-04 质量门重构自 comments-collect.ts 拆出：
// 准备/守卫/收尾三段从 collectOne 抽为独立函数，压平圈复杂度 ≤15，行为与日志逐字不变）。
// 分工：纯判定在 comments-run.ts、I/O 适配在 comments-net.ts、遍历循环在 comments-collect.ts、
// CLI 装配在 commands/comments.ts。规格唯一来源 docs/plans/comments/PLAN.md §4.3/§4.7/§4.8。
import { randomUUID } from 'node:crypto';
import {
  buildReceipt, completeRoundGuard, logOf, nowOf, projectVerify,
  type CollectDeps, type CollectOpts, type CollectVideoReceipt, type RoundCtx, type RoundState,
} from './comments-run.js';
import { countOrFail, countSoft, ingestBatch, resolveVideo } from './comments-net.js';

/** 准备阶段（§4.3 步 1-3）：定位 → count 模式判定/水位 → auto 降级与增量 hot 降级 → ctx 构建 + 主日志。 */
export async function prepareRound(
  deps: CollectDeps, st: RoundState, opts: CollectOpts, bvid: string,
): Promise<{ ctx: RoundCtx; t0: number }> {
  const log = logOf(deps);
  const video = await resolveVideo(deps, st, { ...opts, bvid });
  const t0 = nowOf(deps)();
  const count0 = await countOrFail(deps, video.bvid);
  const autoMode = count0.rows > 0 ? 'incremental' : 'full';
  const mode = opts.mode === 'auto' ? autoMode : opts.mode;
  const watermark = count0.max_ctime_s ?? 0;
  let effectiveMode = mode;
  if (mode === 'incremental' && count0.rows === 0) {
    log('[comments] 库内 0 行但 incremental → 降级 full(无水位可依)');
    effectiveMode = 'full';
  }
  let sort = opts.sort;
  if (effectiveMode === 'incremental' && sort === 'hot') {
    log('[comments] 增量轮 hot 无意义(水位停) → 按 time 继续');
    sort = 'time';
  }
  const ctx: RoundCtx = {
    bvid: video.bvid, aid: video.aid, title: video.title, mode: effectiveMode, sort,
    watermark, scanStart: t0, batchId: randomUUID(), opts,
  };
  log(`[comments] ${video.bvid} aid=${video.aid}(来源=${video.aidSource}) mode=${effectiveMode} sort=${sort} cookie=${deps.cookieFrom ?? '(inline)'} 库内 rows=${count0.rows} 水位=${watermark || '-'} batch=${ctx.batchId}`);
  return { ctx, t0 };
}

/** 完整轮守卫（判定点=楼中楼翻全后）：count 复查 + 伪完整轮判定 + full_scan 标记批
 * （仅完整 full 轮,§3.3;partial/dry-run 轮不触发）。返回 missing 对账结果（未触发为 null）。 */
export async function completeRoundStep(
  deps: CollectDeps, st: RoundState, ctx: RoundCtx,
): Promise<{ candidates: number; confirmed: number } | null> {
  const log = logOf(deps);
  let missing: { candidates: number; confirmed: number } | null = null;
  if (!st.dryRun && !st.stopped?.partial && ctx.mode === 'full') {
    const c2 = await countSoft(deps, ctx.bvid);
    const guard = completeRoundGuard({
      isEndReached: st.isEndReached, riskAbort: st.riskAbort, emptySuspicious: st.emptySuspicious,
      activeRows: c2 && typeof c2.rows === 'number' ? c2.rows : null,
      allCount: st.allCount, statReply: st.statReply,
    });
    if (guard.suspicious) {
      log(`[comments] 伪完整轮:库内 ${c2?.rows ?? '-'} ×1.2 < max(all_count=${st.allCount}, stat.reply=${st.statReply}) → suspicious_truncation partial(不触发 missing 对账)`);
      st.stopped = { reason: 'suspicious_truncation', partial: true };
    } else if (guard.complete && st.lastEntry) {
      // full_scan 标记批（偏差①：ingest 端点 replies 非空约束 → 末条 raw 条目承载标记，幂等吸收）
      const okMark = await ingestBatch(deps, st, ctx, [st.lastEntry], {
        page: st.lastMainPage || null, sort: ctx.sort, fullScan: true, scanStart: ctx.scanStart, pins: st.pins,
      });
      if (okMark && st.lastMissing) {
        missing = st.lastMissing;
        log(`[store] missing 对账 candidates=${missing.candidates} confirmed=${missing.confirmed}(scan_start=${ctx.scanStart})`);
      }
    }
  }
  return missing;
}

// ── 内嵌 verify（§4.8 verify 段 + [verify] 日志；查询失败不拦回执，置 null 留日志）──

/** [verify] 单行日志（缺省字段 → '-' 占位，与原模板逐字等价）。 */
function verifyLogLine(v: Record<string, unknown>): string {
  const integ = (v.integrity ?? {}) as Record<string, unknown>;
  const cov = (v.coverage ?? {}) as Record<string, unknown>;
  const counts = (v.counts ?? {}) as Record<string, unknown>;
  const dash = (x: unknown): string => (x == null ? '-' : `${x}`);
  return `[verify] roots=${dash(counts.roots)} floors=${dash(counts.floors)} orphan_floor=${dash(integ.orphan_floor)} dangling_parent=${dash(integ.dangling_parent)} dangling_dialog=${dash(integ.dangling_dialog)} rcount_mismatch=${dash(integ.rcount_mismatch)} coverage=${dash(cov.ratio)}`;
}

async function embeddedVerify(deps: CollectDeps, st: RoundState, bvid: string): Promise<Record<string, unknown> | null> {
  const log = logOf(deps);
  if (st.dryRun) return null;
  try {
    const v = await deps.client.commentsVerify(bvid);
    if (v?.ok !== true) throw new Error(String((v as { error?: unknown }).error ?? '未知错误'));
    log(verifyLogLine(v));
    return projectVerify(v);
  } catch (e) {
    log(`[verify] 校验查询失败(不拦回执): ${(e as Error).message}`);
    return null;
  }
}

/** [comments] 完成/ dry-run 完成线尾注（partial/stop/complete 标注）。 */
function stopTag(st: RoundState): string {
  return st.stopped ? ` [${st.stopped.partial ? 'partial' : 'stop'}:${st.stopped.reason}]` : ' [complete]';
}

/** 收尾（§4.8 回执）：非 dry-run 内嵌 verify + 完成日志；dry-run 直接出 would 回执。 */
export async function finishRound(
  deps: CollectDeps, st: RoundState, ctx: RoundCtx, t0: number,
  missing: { candidates: number; confirmed: number } | null,
): Promise<CollectVideoReceipt> {
  const log = logOf(deps);
  const now = nowOf(deps);
  if (!st.dryRun) {
    const verify = await embeddedVerify(deps, st, ctx.bvid);
    const elapsed = Math.max(0, now() - t0);
    const receipt = buildReceipt(st, ctx, elapsed, missing, verify);
    log(`[comments] 完成:总 ${receipt.fetched.total}(根 ${st.fetched.roots} + 楼 ${st.fetched.floors}${st.fetched.pins ? `,置顶 ${st.fetched.pins} 计入根` : ''})B 站请求 ${st.biliRequests}(nav ${st.reqKinds.nav} + main ${st.reqKinds.main} + floor ${st.reqKinds.floor}${st.reqKinds.view ? ` + view ${st.reqKinds.view}` : ''})耗时 ${(elapsed / 1000).toFixed(0)}s${stopTag(st)}`);
    return receipt;
  }
  const elapsed = Math.max(0, now() - t0);
  const receipt = buildReceipt(st, ctx, elapsed, null, null);
  log(`[comments] dry-run 完成:总 ${receipt.fetched.total}(根 ${st.fetched.roots} + 楼 ${st.fetched.floors})B 站请求 ${st.biliRequests} 耗时 ${(elapsed / 1000).toFixed(0)}s${stopTag(st)}`);
  return receipt;
}
