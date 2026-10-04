// comments collect 编排层·I/O 适配（C4）。职责：B 站侧（nav wbi keys / wbi main 游标页 /
// view 回查 / reply 楼中楼由编排层直拼）与 server 侧（count/ingest/verify 客户端调用）的取数与
// 失败归一；纯判定在 comments-run.ts，编排循环在 comments-collect.ts。规格 docs/plans/comments/PLAN.md §4.3/§4.6。
import {
  BILI_API_DEFAULT, WEB_LOCATION, biliCodeNum, isRiskCode, logOf, nowOf,
  type CollectDeps, type CollectError, type CollectOpts, type CommentsClient,
  type RawEntry, type RoundCtx, type RoundState, type WbiKeys,
} from './comments-run.js';
import { defaultSleep, fetchBiliJson } from '../asr-net.js';
import { wbiKeysFromNav } from '../asr-bili.js';
import { encWbi } from '../wbi.js';
import { isEmptyShell, isCommentsDisabled, replyDiag } from '../bili-comments.js';
import { ServerResponseError, ServerUnreachableError } from '../http.js';

type MainFetchOk = { ok: true; data: Record<string, unknown>; status?: number; bytes?: number };
type MainFetchFail = { ok: false; code: string; message: string; status?: number; bytes?: number };

/** wbi keys 进程内缓存加载（§4.3 步 2；box 由整轮共享）。force=true 用于 -403 强刷（§4.6，不退避）。 */
export async function loadWbi(
  deps: CollectDeps, st: RoundState, box: { keys: WbiKeys }, force: boolean,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const log = logOf(deps);
  if (!force && box.keys) return { ok: true };
  const biliApi = deps.biliApi ?? BILI_API_DEFAULT;
  st.biliRequests++;
  st.reqKinds.nav++;
  const r = await fetchBiliJson(deps, `${biliApi}/x/web-interface/nav`);
  if (!r.ok) {
    return navFailure(log, r);
  }
  const keys = wbiKeysFromNav(r.data);
  // extractKeysFromNav 对缺 wbi_img 的 nav 返回空串键而非 null（wbi.ts 先例），必须判空——
  // 匿名/风控页装空 keys 会让后续签名全错（2026-10-04 修正 bug⑤）
  if (!keys || !keys.img_key || !keys.sub_key) {
    log(`[fetch] nav 响应缺 wbi_img 键(登录态异常或形态变更) ${replyDiag(r.data)}`);
    return { ok: false, code: 'no_wbi_keys', message: 'nav 响应缺 wbi_img 键' };
  }
  box.keys = keys;
  log(`[fetch] nav http=${r.status ?? '-'} code=0 wbi keys 就绪(img=${keys.img_key.slice(0, 8)}…,累计 B 站请求 ${st.biliRequests})`);
  return { ok: true };
}

/** nav 失败归一（-101 cookie 缺失/失效带重取指引,其余如实上报）。 */
function navFailure(
  log: (m: string) => void, r: { ok: false; code: string; message: string },
): { ok: false; code: string; message: string } {
  if (r.code === 'need_login') {
    log('[fetch] nav code=-101 需登录 → cookie 缺失/失效(SESSDATA 约 1 个月有效期)。重取: node scripts/bili-cookie-from-chrome.mjs --refresh(§4.6)');
    return { ok: false, code: 'need_login', message: 'cookie 缺失/失效(nav -101)。重取: node scripts/bili-cookie-from-chrome.mjs --refresh' };
  }
  log(`[fetch] nav 失败 code=${r.code} message=${r.message}`);
  return { ok: false, code: r.code, message: `nav 失败(${r.code}): ${r.message}` };
}

/** wbi/main 单页（mode=2 时间序遍历 / mode=3 热评快照）。offset 为不透明原文，
 * 包 {"offset":原文} 作 pagination_str 透传（附录 A.3 裁定①，不解码不重组）。
 * -403 = wbi 签名失效 → 强刷 keys 后不退避重试一次（§4.6）。 */
export async function fetchMainPage(
  deps: CollectDeps, st: RoundState, box: { keys: WbiKeys }, aid: string, offset: string, modeNo: 2 | 3,
): Promise<MainFetchOk | MainFetchFail> {
  const biliApi = deps.biliApi ?? BILI_API_DEFAULT;
  const attempt = async (): Promise<MainFetchOk | MainFetchFail> => {
    if (!box.keys) return { ok: false, code: 'no_wbi_keys', message: 'wbi keys 未加载' };
    st.biliRequests++;
    st.reqKinds.main++;
    const pagination = offset === '' ? '' : JSON.stringify({ offset });
    const query = encWbi(
      { type: 1, oid: aid, mode: modeNo, plat: 1, web_location: WEB_LOCATION, pagination_str: pagination },
      box.keys.img_key, box.keys.sub_key,
    );
    return fetchBiliJson(deps, `${biliApi}/x/v2/reply/wbi/main?${query}`);
  };
  const first = await attempt();
  if (first.ok || biliCodeNum(first.code) !== -403) return first;
  logOf(deps)('[fetch] main code=-403 wbi 签名失效 → 强刷 wbi keys 重试一次(不退避,§4.6)');
  const re = await loadWbi(deps, st, box, true);
  if (!re.ok) return { ok: false, code: re.code, message: `-403 后强刷 wbi keys 失败: ${re.message}` };
  return attempt();
}

/** view 接口回查（aid↔bvid 互查 + stat.reply 外部哨兵）。 */
export async function viewLookup(
  deps: CollectDeps, st: RoundState, q: { bvid?: string; aid?: string },
): Promise<{ ok: true; bvid: string; aid: string; statReply: number | null } | { ok: false; code: string; message: string }> {
  const biliApi = deps.biliApi ?? BILI_API_DEFAULT;
  const qs = q.bvid ? `bvid=${encodeURIComponent(q.bvid)}` : `aid=${encodeURIComponent(q.aid ?? '')}`;
  st.biliRequests++;
  st.reqKinds.view++;
  const r = await fetchBiliJson(deps, `${biliApi}/x/web-interface/view?${qs}`);
  if (!r.ok) return { ok: false, code: r.code, message: r.message };
  const d = r.data as { aid?: unknown; bvid?: unknown; stat?: { reply?: unknown } };
  if (d.aid == null || d.bvid == null) {
    logOf(deps)(`[fetch] view ${qs} 形态异常(缺 aid/bvid) ${replyDiag(r.data)}`);
    return { ok: false, code: 'view_no_aid', message: 'view 响应缺 aid/bvid' };
  }
  const reply = d.stat && typeof d.stat.reply === 'number' ? d.stat.reply : null;
  if (reply != null) st.statReply = reply;
  return { ok: true, bvid: String(d.bvid), aid: String(d.aid), statReply: reply };
}

// ── 视频定位（§4.3 步 1：库内 extra.aid 优先，缺则 view 回查；--bvid+--aid 交叉校验）──

function extraAidOf(video: Record<string, unknown>): string | null {
  let extra: unknown = video.extra;
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch { return null; }
  }
  const aid = extra != null && typeof extra === 'object' ? (extra as Record<string, unknown>).aid : null;
  return aid != null ? String(aid) : null;
}

const titleOf = (video: Record<string, unknown>): string | null =>
  typeof video.title === 'string' ? video.title : null;

async function getVideoSafe(client: CommentsClient, bvid: string): Promise<Record<string, unknown> | null> {
  try {
    return await client.getVideo('bilibili', bvid);
  } catch (e) {
    // 通路层错误（不可达/HTTP 非 2xx）原样上抛 → CLI catch 按先例映射 SERVER_UNREACHABLE 等
    // 退出码；其余业务错误才包装 server_error（2026-10-04 修正,对齐 collect.ts handleHttpError 语义）
    if (e instanceof ServerUnreachableError || e instanceof ServerResponseError) throw e;
    const err = e as CollectError;
    throw Object.assign(new Error(`视频详情查询失败: ${err.message}`), { code: 'server_error' });
  }
}

export interface ResolvedVideo { bvid: string; aid: string; title: string | null; aidSource: string }

function videoNotFound(bvid: string): Error {
  return Object.assign(new Error(`video not found: bilibili/${bvid}(评论挂在 videos.id,先采视频再谈评论)`), { code: 'video_not_found' });
}

/** --aid 单给路径：view?aid= 回查 bvid → 库内取标题。 */
async function resolveByAid(deps: CollectDeps, st: RoundState, aid: string): Promise<ResolvedVideo> {
  const v = await viewLookup(deps, st, { aid });
  if (!v.ok) throw Object.assign(new Error(`view?aid=${aid} 回查失败(${v.code}): ${v.message}——av 号无效?`), { code: 'video_not_found' });
  const video = await getVideoSafe(deps.client, v.bvid);
  if (!video) throw videoNotFound(v.bvid);
  return { bvid: v.bvid, aid: v.aid, title: titleOf(video), aidSource: 'view 回查(--aid)' };
}

/** --bvid 单给路径：extra.aid 优先，缺则 view 回查（回查失败 → aid_unresolved）。 */
async function resolveByBvid(deps: CollectDeps, st: RoundState, bvid: string, video: Record<string, unknown>): Promise<ResolvedVideo> {
  const extraAid = extraAidOf(video);
  if (extraAid != null) return { bvid, aid: extraAid, title: titleOf(video), aidSource: 'extra.aid' };
  const v = await viewLookup(deps, st, { bvid });
  if (!v.ok) throw Object.assign(new Error(`extra.aid 缺失且 view 回查失败(${v.code}): ${v.message},无法确定 oid`), { code: 'aid_unresolved' });
  return { bvid, aid: v.aid, title: titleOf(video), aidSource: 'view 回查' };
}

/** --bvid+--aid 同给路径：extra.aid/view 交叉校验，不一致即 aid_mismatch（CLI 映射 ARGS 退 2）；
 * view 回查失败时跳过校验按给定值继续（2026-10-04 修正语义,保留）。 */
async function crossCheckAid(deps: CollectDeps, st: RoundState, bvid: string, aid: string, video: Record<string, unknown>): Promise<ResolvedVideo> {
  const log = logOf(deps);
  const extraAid = extraAidOf(video);
  if (extraAid != null) {
    if (extraAid !== aid) {
      throw Object.assign(new Error(`--aid ${aid} 与库内 extra.aid ${extraAid} 不一致(ARGS 退 2,§4.2)`), { code: 'aid_mismatch' });
    }
    return { bvid, aid: extraAid, title: titleOf(video), aidSource: 'extra.aid' };
  }
  const v = await viewLookup(deps, st, { bvid });
  if (v.ok) {
    if (v.aid !== aid) {
      throw Object.assign(new Error(`--aid ${aid} 与 view 回查 aid ${v.aid} 不一致(ARGS 退 2,§4.2)`), { code: 'aid_mismatch' });
    }
    return { bvid, aid: v.aid, title: titleOf(video), aidSource: 'view 回查' };
  }
  log(`[comments] view 回查失败(${v.code}),--aid 交叉校验跳过,按给定值继续`);
  return { bvid, aid, title: titleOf(video), aidSource: '--aid 直给' };
}

/** 视频定位 + oid(aid) 判定。--aid 单给 → view?aid= 回查；--bvid 单给 → extra.aid，缺则 view 回查；
 * 两者同给 → 与库内/view 结果不一致即 aid_mismatch（CLI 映射 ARGS 退 2，§4.2）。 */
export async function resolveVideo(deps: CollectDeps, st: RoundState, opts: CollectOpts): Promise<ResolvedVideo> {
  if (opts.aid && !opts.bvid) return resolveByAid(deps, st, opts.aid);
  const bvid = opts.bvid as string;
  const video = await getVideoSafe(deps.client, bvid);
  if (!video) throw videoNotFound(bvid);
  if (!opts.aid) return resolveByBvid(deps, st, bvid, video);
  return crossCheckAid(deps, st, bvid, String(opts.aid), video);
}

/** comments count 查询（模式判定/水位/完整轮复查共用）；失败归一 RUNTIME 错误。 */
export async function countOrFail(deps: CollectDeps, bvid: string): Promise<{ rows: number; max_ctime_s: number | null }> {
  try {
    const r = await deps.client.commentsCount(bvid);
    if (r?.ok !== true) throw new Error(String((r as { error?: unknown }).error ?? '未知错误'));
    return {
      rows: typeof r.rows === 'number' ? r.rows : 0,
      max_ctime_s: typeof r.max_ctime_s === 'number' ? r.max_ctime_s : null,
    };
  } catch (e) {
    throw Object.assign(new Error(`comments count 查询失败: ${(e as Error).message}`), { code: 'count_failed' });
  }
}

/** 完整轮复查用宽松版（失败返 null，不阻断守卫——查不到就跳过伪完整判定）。 */
export async function countSoft(deps: CollectDeps, bvid: string): Promise<{ rows?: number } | null> {
  try {
    const r = await deps.client.commentsCount(bvid);
    return r?.ok === true ? r : null;
  } catch { return null; }
}

// ── ingest（§4.1 契约；写库只经 server HTTP）──

export interface IngestTag { page: number | null; sort: string | null; fullScan?: boolean; scanStart?: number; pins?: Array<{ rpid_str: string; kind: string }> }

export function ingestBody(deps: CollectDeps, st: RoundState, ctx: RoundCtx, entries: RawEntry[], tag: IngestTag): Record<string, unknown> {
  const body: Record<string, unknown> = {
    bvid: ctx.bvid, oid: ctx.aid, upper_mid: st.upperMid, fetched_at: nowOf(deps)(),
    batch_id: ctx.batchId, sort: tag.sort, page: tag.page, full_scan: tag.fullScan === true,
    replies: entries,
  };
  if (tag.fullScan) { body.scan_start = tag.scanStart ?? null; body.pins = tag.pins ?? []; }
  return body;
}

/** ingest 成功侧消化：累计 inserted/updated、失败连击清零、missing 摘要捕获。 */
function ingestSuccess(st: RoundState, r: Record<string, unknown>, inserted: number, updated: number): void {
  st.store.inserted += inserted;
  st.store.updated += updated;
  st.ingestFailStreak = 0;
  const m = (r.missing ?? null) as { candidates?: unknown; confirmed?: unknown } | null;
  st.lastMissing = m && typeof m.candidates === 'number' && typeof m.confirmed === 'number'
    ? { candidates: m.candidates, confirmed: m.confirmed }
    : null;
}

export async function ingestBatch(
  deps: CollectDeps, st: RoundState, ctx: RoundCtx, entries: RawEntry[], tag: IngestTag,
): Promise<boolean> {
  if (entries.length === 0) return true;
  const log = logOf(deps);
  const body = ingestBody(deps, st, ctx, entries, tag);
  st.batchSeq++;
  st.store.requests++;
  if (st.dryRun) {
    st.dryRows += entries.length;
    log(`[store] batch#${st.batchSeq} → (dry-run)would ingest rows=${entries.length}(累计 would rows=${st.dryRows})`);
    return true;
  }
  try {
    const r = await deps.client.commentsIngest(body);
    if (r?.ok !== true) throw new Error(String((r as { error?: unknown }).error ?? '未知错误'));
    const inserted = typeof r.inserted === 'number' ? r.inserted : 0;
    const updated = typeof r.updated === 'number' ? r.updated : 0;
    ingestSuccess(st, r, inserted, updated);
    log(`[store] batch#${st.batchSeq} → POST /api/comments/ingest inserted=${inserted} updated=${updated}(累计 ${st.store.inserted}/${st.store.updated},请求数 ${st.store.requests})`);
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

/** 攒批冲刷（§4.2 --batch-size）；仅 ingest_fail 连续失败时保留现场不冲（其余 stop 冲完手头数据）。 */
export async function flushBuffer(deps: CollectDeps, st: RoundState, ctx: RoundCtx, tag: IngestTag): Promise<void> {
  while (st.buffer.length >= ctx.opts.batchSize && st.stopped?.reason !== 'ingest_fail') {
    const chunk = st.buffer.splice(0, ctx.opts.batchSize);
    await ingestBatch(deps, st, ctx, chunk, tag);
  }
}

export async function flushRemainder(deps: CollectDeps, st: RoundState, ctx: RoundCtx, tag: IngestTag): Promise<void> {
  if (st.buffer.length > 0 && st.stopped?.reason !== 'ingest_fail') {
    await ingestBatch(deps, st, ctx, st.buffer.splice(0), tag);
  }
}

/** 主列表取数失败归一（§4.6）：12002 正常终态 / -101 cookie 失效 / 风控系 riskAbort / 其余如实失败。 */
export function handleMainFailure(deps: CollectDeps, st: RoundState, r: MainFetchFail, page: number): void {
  const log = logOf(deps);
  if (isCommentsDisabled(biliCodeNum(r.code))) {
    st.commentsDisabled = true;
    log(`[fetch] main page=${page} code=12002 评论区已关闭 → comments_disabled 正常终态(不报错不重试,§2.4)`);
    return;
  }
  if (r.code === 'need_login') {
    log(`[fetch] main page=${page} code=-101 需登录 → cookie 失效。重取: node scripts/bili-cookie-from-chrome.mjs --refresh`);
    st.stopped = { reason: 'need_login', partial: true };
    return;
  }
  if (isRiskCode(r.code)) st.riskAbort = true;
  log(`[fetch] main page=${page} 失败 code=${r.code} message=${r.message}${r.status ? ` http=${r.status}` : ''}${r.code === 'risk_control' ? '(HTTP 412/风控三档退避后仍拦截——换网络环境/降频后再跑,§8.1)' : ''}`);
  st.stopped = { reason: r.code, partial: true };
}

/** 页间隔 sleep 导出别名（编排层统一经此注入抖动）。 */
export const sleepMs = (deps: CollectDeps, ms: number): Promise<void> => (deps.sleep ?? defaultSleep)(ms);
