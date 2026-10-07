// danmaku collect 编排层·I/O 适配（2026-10-07，规格 docs/plans/danmaku/PLAN.md §4.1/§4.5/§4.7）。
// 职责：B 站侧（view 回查 / seg.so 二进制 protobuf 拉取——响应非 JSON，禁走 fetchBiliJson）
// 与 server 侧（count/ingest/verify 客户端调用）的取数与失败归一；纯判定在 danmaku-run.ts，
// 编排循环在 danmaku-collect.ts，CLI 装配在 danmaku.ts。写库只走 server HTTP（D4）。
// cookie 可选（D9 匿名可用）；弹幕接口无 wbi 签名（-403 出现即协议变化，不退避）。
import { readFileSync } from 'node:fs';
import {
  BILI_API_DEFAULT, isRiskNum, logOf, nowOf, rowsOf, titleOf, extraAidOf,
  viewMetaFromData, extraPagesOf,
  type DanmakuClient, type DanmakuDeps, type DanmakuOpts,
  type DmCtx, type DmState, type PageMeta,
} from './danmaku-run.js';
import { defaultSleep, biliHeaders, withRiskRetry, fetchBiliJson } from '../asr-net.js';
import { segDiag, type DanmakuItem } from '../bili-danmaku.js';
import { emitError } from '../output.js';
import { ServerResponseError, ServerUnreachableError } from '../http.js';

// ── cookie 装配（§4.2 可选语义，与 comments 必配不同：D9 匿名实测可用）──

/**
 * cookie 装配（可选取代 comments 必配款）：explicit / $COLLECTOR_BILI_COOKIE_FILE 均缺省 →
 * { cookie: null, from: 'anonymous' }；给了路径但不可读/空 → ARGS 退 2（给了就要能用，静默降级会掩盖错路径）。
 */
export function loadCookieFileOptional(explicit: string | undefined): { cookie: string | null; from: string } {
  const path = explicit ?? process.env.COLLECTOR_BILI_COOKIE_FILE;
  if (!path) return { cookie: null, from: 'anonymous' };
  // 读文件放 try 外口径对齐 comments.loadCookieFile（读失败与空内容是两条独立路径；
  // emitError 走 process.exit 哨兵，若在 catch 内调用会被自身 catch 吞掉）
  let cookie = '';
  try {
    cookie = readFileSync(path, 'utf-8').trim();
  } catch {
    emitError(`cookie 文件不可读: ${path}(弹幕采集 cookie 可选,给路径就要能读;不给则匿名跑)`, 'ARGS');
  }
  if (!cookie) emitError(`cookie 文件为空: ${path}(弹幕采集 cookie 可选,给路径就要能读;不给则匿名跑)`, 'ARGS');
  return { cookie, from: path };
}

// ── B 站 seg.so 拉取（§4.5：二进制 protobuf,304=越界正常终态,风控三档退避）──

export type SegFetch =
  | { ok: true; status: 200; bytes: Uint8Array; biliStatusCode: string | null }
  | { ok: true; status: 304; bytes: Uint8Array; biliStatusCode: string | null }
  | { ok: false; kind: 'risk_abort'; httpStatus: number | null; biliCode: number | null; message: string }
  | { ok: false; kind: 'code'; httpStatus: number | null; biliCode: number | null; message: string }
  | { ok: false; kind: 'http'; httpStatus: number; biliCode: string | null; message: string }
  | { ok: false; kind: 'network'; httpStatus: null; biliCode: null; message: string };

/** 响应头 bili-status-code 提取（B 站业务码在 header 的实测形态,附录 A r2:304+`bili-status-code: -304`）。 */
function biliStatusCodeHeader(res: Response): string | null {
  const v = res.headers.get('bili-status-code');
  return v != null && v !== '' ? v : null;
}

const bodyHeadHex = (bytes: Uint8Array): string =>
  Array.from(bytes.slice(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * 单段拉取（§2.2/§4.5）：GET /x/v2/dm/web/seg.so?type=1&oid={cid}&pid={aid}&segment_index={seg}。
 * 响应体是二进制 protobuf（parseSeg 吃 Uint8Array）——必须 arrayBuffer,禁 JSON.parse。
 * 归一：
 * - 200/304 → ok:true（304=越界正常终态,非错误）
 * - HTTP 412 或 bili-status-code ∈ 风控码 → kind:'risk_abort'（编排层计 riskAbort;三档退避已由本函数内 withRiskRetry 走完）
 * - bili-status-code -403 → kind:'code'（wbi 特有码,弹幕无 wbi,协议变化不退避）
 * - bili-status-code -101 → kind:'code'（需登录;cookie 可选语境下提示补 cookie）
 * - 其他非 200/304 → kind:'http'
 * - fetch 网络异常 → kind:'network'
 * 每条失败路径必带 segDiag 观察串（CLAUDE.md §9:失败必带响应特征）。
 */
export async function fetchSeg(
  deps: DanmakuDeps, st: DmState, aid: string, cid: number, seg: number,
): Promise<SegFetch> {
  const log = logOf(deps);
  const biliApi = deps.biliApi ?? BILI_API_DEFAULT;
  const url = `${biliApi}/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=${encodeURIComponent(aid)}&segment_index=${seg}`;
  // 预算计数按真实 HTTP 尝试（风控重试每次都打 B 站,§4.4 预算语义）
  const attempt = async (): Promise<SegFetch & { risk?: boolean }> => {
    st.biliRequests++;
    st.reqKinds.seg++;
    const fetchImpl = deps.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(url, { headers: biliHeaders(deps.cookie ?? undefined) });
      const status = res.status;
      const buf = new Uint8Array(await res.arrayBuffer());
      const biliStatusCode = biliStatusCodeHeader(res);
      if (status === 200 || status === 304) {
        return { ok: true, status: status as 200 | 304, bytes: buf, biliStatusCode };
      }
      const headNum = biliStatusCode != null && /^-?\d+$/.test(biliStatusCode) ? Number(biliStatusCode) : null;
      const diag = segDiag({ status, bytes: buf.length, biliStatusCode, bodyHeadHex: bodyHeadHex(buf) });
      if (status === 412 || isRiskNum(headNum)) {
        log(`[fetch] seg cid=${cid} index=${seg} 风控拦截(${status === 412 ? 'HTTP 412' : `bili_status=${biliStatusCode}`})${diag}`);
        return { ok: false, kind: 'risk_abort', httpStatus: status, biliCode: headNum, message: `seg 风控拦截: ${diag}`, risk: true };
      }
      if (headNum === -403) {
        log(`[fetch] seg cid=${cid} index=${seg} bili_status=-403:弹幕接口无 wbi 签名,出现即协议变化(不退避) ${diag}`);
        return { ok: false, kind: 'code', httpStatus: status, biliCode: headNum, message: `seg -403 协议变化: ${diag}` };
      }
      if (headNum === -101) {
        log(`[fetch] seg cid=${cid} index=${seg} bili_status=-101 需登录(匿名实测可用,出现即异常;${deps.cookie ? 'cookie 已带,疑似失效→重取' : '未带 cookie→补 cookie 重跑'}) ${diag}`);
        return { ok: false, kind: 'code', httpStatus: status, biliCode: headNum, message: `seg -101 需登录: ${diag}` };
      }
      log(`[fetch] seg cid=${cid} index=${seg} 失败 http=${status} bili_status=${biliStatusCode ?? '-'} ${diag}`);
      return { ok: false, kind: 'http', httpStatus: status, biliCode: biliStatusCode, message: `seg HTTP ${status}: ${diag}` };
    } catch (e) {
      const msg = (e as Error).message;
      log(`[fetch] seg cid=${cid} index=${seg} 网络异常: ${msg}(无响应特征可取)`);
      return { ok: false, kind: 'network', httpStatus: null, biliCode: null, message: `seg 网络异常: ${msg}`, risk: false };
    }
  };
  // 风控三档退避（§4.5 复用 asr-net RISK_BACKOFF_MS 30s/120s/300s;标签 [danmaku]）
  const r = await withRiskRetry(deps, attempt, '[danmaku]');
  return r;
}

// ── view 回查（§4.1 D5/D8:extra 缺失时只读回查 aid/cid/pages/duration + stat.danmaku 哨兵）──

export type ViewLookup =
  | { ok: true; aid: string; bvid: string; title: string | null; pages: PageMeta[]; statDanmaku: number | null }
  | { ok: false; code: string; message: string };

export async function fetchViewMeta(
  deps: DanmakuDeps, st: DmState, q: { bvid?: string; aid?: number },
): Promise<ViewLookup> {
  const log = logOf(deps);
  const biliApi = deps.biliApi ?? BILI_API_DEFAULT;
  const qs = q.bvid
    ? `bvid=${encodeURIComponent(q.bvid)}`
    : `aid=${encodeURIComponent(String(q.aid ?? ''))}`;
  st.biliRequests++;
  st.reqKinds.view++;
  const r = await fetchBiliJson(
    { cookie: deps.cookie ?? undefined, fetchImpl: deps.fetchImpl, sleep: deps.sleep, log: deps.log },
    `${biliApi}/x/web-interface/view?${qs}`,
  );
  if (!r.ok) {
    log(`[fetch] view ${qs} 失败 code=${r.code} message=${r.message} http=${r.status ?? '-'} bytes=${r.bytes ?? '-'}`);
    return { ok: false, code: r.code, message: r.message };
  }
  const meta = viewMetaFromData(r.data);
  if (!meta.ok) {
    log(`[fetch] view ${qs} 形态异常: ${meta.error}`);
    return { ok: false, code: 'view_malformed', message: meta.error };
  }
  return meta;
}

// ── 视频定位（§4.3 步 0:库内 video → extra.pages/extra.aid;缺失 → view 回查;全缺 → video_not_found）──

async function getVideoSafe(client: DanmakuClient, bvid: string): Promise<Record<string, unknown> | null> {
  try {
    return await client.getVideo('bilibili', bvid);
  } catch (e) {
    // 通路层错误原样上抛（CLI 按先例映射 SERVER_UNREACHABLE 等）;其余业务错误才包装 server_error
    if (e instanceof ServerUnreachableError || e instanceof ServerResponseError) throw e;
    throw Object.assign(new Error(`视频详情查询失败: ${(e as Error).message}`), { code: 'server_error' });
  }
}

export interface ResolvedVideo {
  bvid: string;
  aid: string;
  title: string | null;
  pages: PageMeta[];
  aidSource: string;
  pagesSource: string;
  statDanmaku: number | null;
}

/** --bvid 路径定位：库内 extra 优先（aid/pages），缺失字段走 view 回查（只读不回写）;视频不在库 → video_not_found。 */
export async function resolveByBvid(deps: DanmakuDeps, st: DmState, bvid: string): Promise<ResolvedVideo> {
  const log = logOf(deps);
  const video = await getVideoSafe(deps.client, bvid);
  if (!video) {
    throw Object.assign(
      new Error(`video not found: bilibili/${bvid}(弹幕挂在 videos.id,先采视频再谈弹幕)`),
      { code: 'video_not_found' },
    );
  }
  const extraAid = extraAidOf(video);
  const extraPages = extraPagesOf(video);
  let aid = extraAid;
  let aidSource = 'extra.aid';
  let pages = extraPages;
  let pagesSource = 'extra.pages';
  let statDanmaku: number | null = null;
  if (extraPages.length === 0) {
    log(`[danmaku] ${bvid} extra 无分 P 信息(cid/pages 缺失) → view 回查(只读,不回写库)`);
    const v = await fetchViewMeta(deps, st, { bvid });
    if (!v.ok) {
      throw Object.assign(new Error(`extra 分 P 缺失且 view 回查失败(${v.code}): ${v.message},无法确定 oid/段数`), { code: 'aid_unresolved' });
    }
    aid = v.aid;
    aidSource = 'view 回查';
    pages = v.pages;
    pagesSource = 'view.pages';
    statDanmaku = v.statDanmaku;
    if (extraAid != null && extraAid !== v.aid) {
      log(`[danmaku] 警告: extra.aid=${extraAid} 与 view.aid=${v.aid} 不一致,以 view 为准(重采视频修正 extra)`);
    }
  }
  if (aid == null) {
    throw Object.assign(new Error(`extra.aid 缺失且分 P 信息齐全度不足,无法确定 pid(${bvid})`), { code: 'aid_unresolved' });
  }
  return { bvid, aid, title: titleOf(video), pages, aidSource, pagesSource, statDanmaku };
}

/** --aid 单给路径：view?aid= 回查 bvid → 库内取标题（不在库不拦——弹幕只要求 pid/cid 可定位）。
 * 注意：写库 ingest 按 bvid 挂 videos.id,video 不在库时首个 ingest 批将 404 → 按 video_not_found 终止。 */
export async function resolveByAid(deps: DanmakuDeps, st: DmState, aid: number): Promise<ResolvedVideo> {
  const v = await fetchViewMeta(deps, st, { aid });
  if (!v.ok) {
    throw Object.assign(new Error(`view?aid=${aid} 回查失败(${v.code}): ${v.message}——av 号无效?`), { code: 'video_not_found' });
  }
  const log = logOf(deps);
  const video = await getVideoSafe(deps.client, v.bvid);
  if (!video) {
    log(`[danmaku] view 回查到 ${v.bvid} 但库内无此视频——ingest 将 404(弹幕挂在 videos.id,先采视频)`);
  }
  return {
    bvid: v.bvid,
    aid: v.aid,
    title: video ? titleOf(video) : v.title,
    pages: v.pages,
    aidSource: 'view 回查(--aid)',
    pagesSource: 'view.pages',
    statDanmaku: v.statDanmaku,
  };
}

/** --bvid+--aid 同给交叉校验（§4.2 comments 同款：不一致 → aid_mismatch,CLI 映射 ARGS 退 2）。 */
export async function resolveVideo(deps: DanmakuDeps, st: DmState, opts: DanmakuOpts): Promise<ResolvedVideo> {
  if (opts.aid != null && !opts.bvid) return resolveByAid(deps, st, opts.aid);
  const bvid = opts.bvid as string;
  const r = await resolveByBvid(deps, st, bvid);
  if (opts.aid != null && String(opts.aid) !== r.aid) {
    throw Object.assign(
      new Error(`--aid ${opts.aid} 与定位 aid ${r.aid} 不一致(ARGS 退 2,§4.2)`),
      { code: 'aid_mismatch' },
    );
  }
  return r;
}

// ── server 侧（count / ingest / verify;写库只走 server HTTP D4）──

/** danmaku count 哨兵查询（回执 before/after_rows;查询失败 → RUNTIME 类错误）。 */
export async function countOrFail(deps: DanmakuDeps, bvid: string): Promise<number> {
  try {
    const r = await deps.client.danmakuCount(bvid);
    if (r?.ok !== true) throw new Error(String((r as { error?: unknown }).error ?? '未知错误'));
    return rowsOf(r);
  } catch (e) {
    throw Object.assign(new Error(`danmaku count 查询失败: ${(e as Error).message}`), { code: 'count_failed' });
  }
}

export interface DmIngestTag { cid: number; page: number }

function ingestBody(deps: DanmakuDeps, ctx: DmCtx, items: DanmakuItem[], tag: DmIngestTag): Record<string, unknown> {
  return {
    bvid: ctx.bvid,
    cid: tag.cid,
    page: tag.page,
    fetched_at: nowOf(deps)(),
    batch_id: ctx.batchId,
    danmakus: items,
  };
}

/** 单批 ingest（§4.1 契约;失败连击计数,≥3 → 终止 partial ingest_fail;失败批未入库,重跑幂等补齐）。 */
export async function ingestBatch(
  deps: DanmakuDeps, st: DmState, ctx: DmCtx, items: DanmakuItem[], tag: DmIngestTag,
): Promise<boolean> {
  if (items.length === 0) return true;
  const log = logOf(deps);
  const body = ingestBody(deps, ctx, items, tag);
  st.batchSeq++;
  st.store.requests++;
  if (st.dryRun) {
    st.dryRows += items.length;
    log(`[store] batch#${st.batchSeq} → (dry-run)would ingest rows=${items.length}(累计 would rows=${st.dryRows})`);
    return true;
  }
  try {
    const r = await deps.client.danmakuIngest(body);
    if (r?.ok !== true) throw new Error(String((r as { error?: unknown }).error ?? '未知错误'));
    const inserted = typeof r.inserted === 'number' ? r.inserted : 0;
    const updated = typeof r.updated === 'number' ? r.updated : 0;
    st.store.inserted += inserted;
    st.store.updated += updated;
    st.ingestFailStreak = 0;
    log(`[store] batch#${st.batchSeq} → POST /api/danmaku/ingest inserted=${inserted} updated=${updated}(累计 ${st.store.inserted}/${st.store.updated},请求数 ${st.store.requests})`);
    return true;
  } catch (e) {
    st.ingestFailStreak++;
    log(`[store] batch#${st.batchSeq} ingest 失败(${st.ingestFailStreak}/3): ${(e as Error).message}`);
    if (st.ingestFailStreak >= 3) {
      st.stopped = { reason: 'ingest_fail', partial: true };
      log('[store] 连续 3 次 ingest 失败 → 终止本轮(partial;失败批未入库,重跑幂等补齐)');
    }
    return false;
  }
}

/** 攒批冲刷（§4.2 --batch-size;ingest_fail 硬停后保留现场不冲）。 */
export async function flushBuffer(deps: DanmakuDeps, st: DmState, ctx: DmCtx, tag: DmIngestTag): Promise<void> {
  while (st.buffer.length >= ctx.opts.batchSize && st.stopped?.reason !== 'ingest_fail') {
    const chunk = st.buffer.splice(0, ctx.opts.batchSize);
    await ingestBatch(deps, st, ctx, chunk, tag);
  }
}

export async function flushRemainder(deps: DanmakuDeps, st: DmState, ctx: DmCtx, tag: DmIngestTag): Promise<void> {
  if (st.buffer.length > 0 && st.stopped?.reason !== 'ingest_fail') {
    await ingestBatch(deps, st, ctx, st.buffer.splice(0), tag);
  }
}

/** 内嵌 verify（§4.6 verify 段;查询失败不拦回执,置 null 留日志——comments-flow 先例）。 */
export async function embeddedVerify(deps: DanmakuDeps, bvid: string): Promise<Record<string, unknown> | null> {
  const log = logOf(deps);
  if (deps.client == null) return null;
  try {
    const v = await deps.client.danmakuVerify(bvid);
    if (v?.ok !== true) throw new Error(String((v as { error?: unknown }).error ?? '未知错误'));
    const counts = (v.counts ?? {}) as Record<string, unknown>;
    const timeline = (v.timeline ?? {}) as Record<string, unknown>;
    const integ = (v.integrity ?? {}) as Record<string, unknown>;
    const dash = (x: unknown): string => (x == null ? '-' : `${x}`);
    log(`[verify] rows=${dash(counts.rows)} pages=${dash(counts.pages)} min_progress=${dash(timeline.min_progress_ms)} max_progress=${dash(timeline.max_progress_ms)} dup_id=${dash(integ.dup_id)} negative_progress=${dash(integ.negative_progress)}`);
    return v;
  } catch (e) {
    log(`[verify] 校验查询失败(不拦回执): ${(e as Error).message}`);
    return null;
  }
}

/** 段间隔 sleep 导出别名（编排层统一经此注入抖动;deps.sleep 可注入测试）。 */
export const sleepMs = (deps: DanmakuDeps, ms: number): Promise<void> => (deps.sleep ?? defaultSleep)(ms);
