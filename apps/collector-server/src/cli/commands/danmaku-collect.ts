// danmaku collect 编排层·采集循环（2026-10-07，规格唯一来源 docs/plans/danmaku/PLAN.md §4.3/§4.4/§4.5/§4.6/§4.7）。
// runCollect 是 collect 子命令入口：定位（库内 extra → view 回查）→ count 哨兵 → 多 P 串行段循环
// （fetchSeg → parseSeg → 攒批 ingest）→ 内嵌 verify → 回执。纯判定在 danmaku-run.ts，
// I/O 适配在 danmaku-net.ts，CLI 装配在 danmaku.ts。写库只走 server HTTP（D4）。
import { SEG_FAIL_LIMIT, buildReceipt, logOf, newState, nowOf, segCountOf, segFailStop,
  segGate, segInterval, segPatternChanged, selectPages, stopTag,
  type DanmakuDeps, type DanmakuOpts, type DanmakuReceipt, type DmCtx, type DmState, type PageMeta, type PageStat } from './danmaku-run.js';
import { parseSeg, segDiag, type DanmakuItem } from '../bili-danmaku.js';
import {
  countOrFail, fetchSeg, flushBuffer, flushRemainder, embeddedVerify, resolveVideo,
  type DmIngestTag, type ResolvedVideo,
} from './danmaku-net.js';

// ── 单段采集步（fetch → parse → 攒批冲刷；编排循环的最小单元）──

/** [parse] 命中计数行（§4.7 样式:命中分布 + 未识别字段分布 + 对账）。 */
function parseLogLine(r: ReturnType<typeof parseSeg>): string {
  const total = r.elems.length;
  const hitId = total - r.missingIdCount;
  const hitProgress = r.elems.filter((e) => e.progress_ms != null).length;
  const hitContent = r.elems.filter((e) => e.content != null).length;
  const unknown = Object.keys(r.unknownFieldCounts).length > 0
    ? ` | 未识别字段 {${Object.entries(r.unknownFieldCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}}`
    : '';
  return `elems=${total} 命中: id_str ${hitId}/${total} progress ${hitProgress}/${total} content ${hitContent}/${total}`
    + `${unknown} | missingId=${r.missingIdCount}`
    + ` | 顶层字段 {${Object.entries(r.topFieldCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}}`;
}

interface SegStepOut { ok: boolean; /** 304 越界 = 本 P 正常终态,调用方须立即断段循环(§4.3 break) */ pageDone?: boolean }

/**
 * 单段失败路径（§4.4/§4.5 纯编排,判定下沉 segFailStop）：连击先累计 → 归一判定 → 判停则写
 * stopped(partial) 并按原因落日志（文案与重构前逐字一致）;否则只落「失败(K/3)」继续采。
 */
function failSegStep(
  log: (msg: string) => void, st: DmState, p: PageMeta, seg: number,
  message: string, kind: string, biliCode: number | string | null,
): void {
  st.segFailStreak++;
  const stop = segFailStop(kind, biliCode, st.segFailStreak);
  const at = `[fetch] seg cid=${p.cid} index=${seg}`;
  if (stop == null) {
    log(`${at} 失败(${st.segFailStreak}/${SEG_FAIL_LIMIT}) ${message}`);
    return;
  }
  st.stopped = { reason: stop.reason, partial: true };
  if (stop.reason === 'risk_abort') {
    st.riskAbort = true;
    log(`${at} 三档退避后仍风控 → 终止本轮(partial risk_abort): ${message}`);
  } else if (stop.reason === 'protocol_403') {
    log(`${at} -403 不退避 → 终止本轮(partial protocol_403)`);
  } else if (stop.reason === 'need_login') {
    log(`${at} -101 需登录 → 终止本轮(partial need_login)`);
  } else {
    log(`${at} 连续 ${SEG_FAIL_LIMIT} 段失败 → 终止本轮(partial seg_fail): ${message}`);
  }
}

/** 单段解析失败（§4.5）：前 32 字节 hex 现场 + parse_fail partial 硬停（stopped.partial 语义收口）。 */
function failParseStep(
  log: (msg: string) => void, st: DmState, p: PageMeta, seg: number, bytes: Uint8Array, e: unknown,
): SegStepOut {
  const hex = Array.from(bytes.slice(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join('');
  log(`[parse] seg cid=${p.cid} index=${seg} 解析失败: ${(e as Error).message} | 前 32 字节: ${hex || '(空)'}`);
  st.stopped = { reason: 'parse_fail', partial: true };
  return { ok: false };
}

/** 解析成功后的落账步（§4.5）：命中计数日志 → 空→非空改版警示 → pageStats 单查找建档/累计 → 攒批冲刷。 */
async function ingestParsedSeg(
  deps: DanmakuDeps, st: DmState, ctx: DmCtx, p: PageMeta, seg: number,
  parsed: ReturnType<typeof parseSeg>, tag: DmIngestTag,
): Promise<void> {
  const log = logOf(deps);
  const elems: DanmakuItem[] = parsed.elems;
  log(`[parse] seg cid=${p.cid} index=${seg} ${parseLogLine(parsed)}`);
  // 空 seg 正常（该时段无弹幕）；但连续空段后突然非空段 → 分段规则改版警示（§4.5,判定下沉 segPatternChanged）
  const stat = st.pageStats.find((s) => s.cid === p.cid);
  if (segPatternChanged(elems.length, stat)) {
    log('[fetch] seg 变长分段疑似改版:前面段全空而本段非空,分段规则可能已调整(不中断,继续按 N 采集)');
  }
  if (stat == null) {
    st.pageStats.push({ cid: p.cid, page: p.page, duration_s: p.duration, segments_expected: segCountOf(p), segments_fetched: 0, fetched: 0 });
  }
  const cur = st.pageStats.find((s) => s.cid === p.cid) as PageStat;
  cur.segments_fetched++;
  cur.fetched += elems.length;
  st.buffer.push(...elems);
  await flushBuffer(deps, st, ctx, tag);
}

/**
 * 单段采集：fetchSeg(风控/304/失败归一) → 200 走 parseSeg + 攒批 → 失败路径按 §4.4/§4.5 归一。
 * 返回 ok=false 时已按 kind 处置：304/risk_abort/code/http/network 由调用方按 stopped/partial 语义收口。
 */
async function segStep(deps: DanmakuDeps, st: DmState, ctx: DmCtx, p: PageMeta, seg: number, tag: DmIngestTag): Promise<SegStepOut> {
  const log = logOf(deps);
  const r = await fetchSeg(deps, st, ctx.aid, p.cid, seg);
  if (!r.ok) {
    failSegStep(log, st, p, seg, r.message, r.kind, r.kind === 'code' ? r.biliCode : null);
    return { ok: false };
  }
  // 成功即清零连击
  st.segFailStreak = 0;
  if (r.status === 304) {
    // 越界哨兵 = 本 P 正常终态（§4.5;附录 A r2:HTTP 304 + bili-status-code: -304）
    log(`[fetch] seg cid=${p.cid} index=${seg} http=304 ${segDiag({ status: 304, bytes: r.bytes.length, biliStatusCode: r.biliStatusCode })} → 段越界,本 P 结束${stopTag(st)}`);
    return { ok: false, pageDone: true };
  }
  log(`[fetch] seg cid=${p.cid} index=${seg} http=200 bytes=${r.bytes.length}`);
  let parsed: ReturnType<typeof parseSeg>;
  try {
    parsed = parseSeg(r.bytes);
  } catch (e) {
    // §4.5:解析失败终止 partial + 前 32 字节 hex 现场日志
    return failParseStep(log, st, p, seg, r.bytes, e);
  }
  await ingestParsedSeg(deps, st, ctx, p, seg, parsed, tag);
  return { ok: true };
}

// ── 单 P 采集（段循环 + 判停 + 尾批冲刷）──

/**
 * 单 P 采集循环（§4.3 verifyP 伪码）：seg 1..N,每段开跑先过 segGate 归一前置门
 * （budget → 已硬停 → N/上限,判定次序与日志语义不变）;304 越界即断（segStep 内）;
 * 段间 --segment-interval-ms ±30% 抖动;--max-segments 触顶 partial segments_cap。
 */
async function collectPage(deps: DanmakuDeps, st: DmState, ctx: DmCtx, p: PageMeta, tag: DmIngestTag): Promise<void> {
  const log = logOf(deps);
  const expectedN = segCountOf(p);
  const segCap = ctx.opts.maxSegments;
  log(`[danmaku] P${p.page} cid=${p.cid} duration=${p.duration}s 预期段数=${expectedN}${segCap > 0 ? `(上限 ${segCap})` : ''}`);
  for (let seg = 1; ; seg++) {
    const gate = segGate(st.biliRequests, ctx.opts.maxRequests, st.stopped?.partial === true, seg, expectedN, segCap);
    if (gate.stop) {
      if (gate.reason === 'request_budget') {
        st.stopped = { reason: 'request_budget', partial: true };
        log(`[danmaku] P${p.page} seg=${seg} 请求预算用尽(${st.biliRequests}/${ctx.opts.maxRequests}) → partial request_budget`);
      } else if (gate.reason === 'segments_cap') {
        st.stopped = { reason: 'segments_cap', partial: true };
        log(`[danmaku] P${p.page} seg=${seg} --max-segments ${segCap} 触顶 → partial segments_cap`);
      }
      break;
    }
    const out = await segStep(deps, st, ctx, p, seg, tag);
    if (out.pageDone) break;
    if (seg < expectedN && !st.stopped?.partial) await segInterval(deps, ctx.opts);
  }
  await flushRemainder(deps, st, ctx, tag);
  const stat = st.pageStats.find((s) => s.cid === p.cid);
  log(`[danmaku] P${p.page} 完成 segments=${stat?.segments_fetched ?? 0}/${expectedN} 弹幕=${stat?.fetched ?? 0}${stopTag(st)}`);
}

// ── collect 入口 ──

/** collect 编排入口（§4.3 伪码直译）：返回 §4.6 回执（emitResult 由 CLI 装配层做）。 */
export async function runCollect(deps: DanmakuDeps, opts: DanmakuOpts): Promise<DanmakuReceipt> {
  const log = logOf(deps);
  const t0 = nowOf(deps)();
  const st = newState();
  st.dryRun = opts.dryRun;
  // 定位（§4.3 步 0）:--aid 单给走 view 回查;--bvid 走库内 extra（缺失字段回查）;同给交叉校验
  const video: ResolvedVideo = await resolveVideo(deps, st, opts);
  const selected: PageMeta[] = selectPages(video.pages, opts.page);
  const ctx: DmCtx = {
    bvid: video.bvid, aid: video.aid, title: video.title,
    batchId: crypto.randomUUID(), statDanmaku: video.statDanmaku, opts,
  };
  log(`[danmaku] 定位 ${video.bvid}(aid=${video.aid},来源 ${video.aidSource}) 分 P=${video.pages.length} 选中=${selected.length} 标题=${video.title ?? '-'}${opts.dryRun ? ' [dry-run]' : ''}`);

  const before = await countOrFail(deps, video.bvid);
  log(`[danmaku] ${video.bvid} 库内已有弹幕 ${before} 行`);
  for (const p of selected) {
    if (st.stopped?.partial) break;
    await collectPage(deps, st, ctx, p, { cid: p.cid, page: p.page });
  }
  const after = st.stopped?.reason === 'ingest_fail' ? before : await countOrFail(deps, video.bvid);
  const elapsedMs = nowOf(deps)() - t0;
  const verify = opts.dryRun ? null : await embeddedVerify(deps, video.bvid);
  const receipt = buildReceipt(st, ctx, elapsedMs, { before, after }, verify);
  log(`[danmaku] ${video.bvid} 结束${stopTag(st)} fetched=${receipt.fetched_total} store=${JSON.stringify(receipt.store)} rows ${before}→${after} bili_requests=${st.biliRequests}(view ${st.reqKinds.view}/seg ${st.reqKinds.seg}) elapsed=${elapsedMs}ms`);
  return receipt;
}
