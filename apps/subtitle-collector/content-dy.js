// ISOLATED world（document_start）：抖音详情聚合 + 博主列表聚合 + GET_DETAIL/GET_LOCAL_STATE。
// 与 content-yt.js 同构定位（聚合 inject 消息、响应 popup/background 查询），但职责更薄：
// 抖音详情一次到位（无轨定居等待），payload 组装/上报由 background 在 fetch-douyin-subtitle
// action 里统一做（sendIngest 直发，绕过上报开关——主动采集语义）；本文件不发 INGEST。
// crxjs 把本文件作 Rollup 入口打包（vite.config.ts），故可直接 import douyin-format.mjs / douyin-payload.js。
//
// inject-dy（MAIN world）消息（信封 {source:'dy-sub-ext', type, data}）：
//   AWEME_DETAIL      detail XHR 响应（snake_case 原样）——按 aweme_id 幂等覆盖（页面会发多次）
//   SSR_VIDEO_DETAIL  SSR videoDetail（camelCase）——归一后仅作兜底（XHR 形态更全更稳）
//   POST_LIST/POST_LIST_EMPTY/PROFILE_OTHER  博主批量 expand 聚合用（见 upper 状态机）

import { ssrVideoDetailToAwemeDetail, extractDouyinCaptionTracks } from "./douyin-format.mjs";
import { buildDouyinPayload } from "./douyin-payload.js";

// awemeId -> {detail: object(snake_case), origin: 'xhr' | 'ssr'}
const details = new Map();

function storeDetail(id, detail, origin) {
  if (!id || !detail) return;
  const key = String(id);
  const cur = details.get(key);
  // XHR 形态 148 键（更全）且是抖音 SPA 自家依赖（更稳）：SSR 值不覆盖 XHR 值；XHR 恒覆盖
  if (origin === 'ssr' && cur?.origin === 'xhr') return;
  details.set(key, { detail, origin });
}

// ── 博主批量（expand-douyin-upper）聚合状态机 ──
// background 开博主页 tab → DY_UPPER_START → 本文件聚合 inject-dy 拦到的 post 游标页
//（页面加载自动发第 1 页 max_cursor=0；后续页靠滚到页面底部触发 SPA 懒加载）+ profile 资料，
// 直至 has_more=false；匿名态 post 200 空体 → error「需登录」（S1 实测 gating 形态）。
// background 以 GET_UPPER_STATE 轮询消费 + 无进展窗口兜底（滚动失灵时保部分结果终止）。
let upper = null; // {secUid, profile, items:[], seen:Set, hasMore, done, error}
let upperScrollTimer = null;
const UPPER_SCROLL_GAP_MS = 1200; // 滚动间隔：给 SPA 留出发请求+渲染时间
const UPPER_MAX_ITEMS = 2000;     // 防失控上限（万级作品博主不存在，超限保部分结果终止）

// DY_UPPER_START 到达前页面可能已发过 post/profile XHR（content script 就绪竞态）：
// 环形缓冲近期消息，start 时按 secUid 重放，不丢第 1 页。
const upperBuffer = []; // {type, data}
const UPPER_BUFFER_MAX = 16;
function bufferUpperMsg(type, data) {
  upperBuffer.push({ type, data });
  if (upperBuffer.length > UPPER_BUFFER_MAX) upperBuffer.shift();
}

// 单条 post → 精简 item（背景组装最终回执；此处只留背景映射所需字段）
function upperItemOf(a) {
  return {
    aweme_id: String(a.aweme_id),
    desc: a.desc ?? null,
    aweme_type: a.aweme_type ?? null,
    create_time: a.create_time ?? null,
    duration_ms: a.duration ?? null, // 顶层 duration 毫秒（与 detail 同口径）
    play_count: a.statistics?.play_count ?? null,
    cover_url: Array.isArray(a.video?.cover?.url_list) && typeof a.video.cover.url_list[0] === 'string'
      ? a.video.cover.url_list[0]
      : null,
  };
}

// 单条 post 页 → 精简 item 并入（背景组装最终回执）；2026-08-29 S8 台账性重构：
// 条目映射拆 upperItemOf（复杂度台账达标），逻辑逐字原样搬移。
function pushUpperPage(page) {
  if (!upper || page.secUid !== upper.secUid) return;
  for (const a of page.awemeList ?? []) {
    if (!a || typeof a !== 'object' || a.aweme_id == null) continue;
    const id = String(a.aweme_id);
    if (upper.seen.has(id)) continue;
    upper.seen.add(id);
    upper.items.push(upperItemOf(a));
  }
  upper.hasMore = page.hasMore === true;
  if (!upper.hasMore || upper.items.length >= UPPER_MAX_ITEMS) upper.done = true;
  console.log(`[content-dy] POST_LIST 聚合 secUid=${upper.secUid.slice(-8)} 累计=${upper.items.length} has_more=${upper.hasMore}`);
}

// 滚动驱动翻页：hasMore 未尽时持续滚到页底触发 SPA 请求下一页（后台 tab 定时器被节流到 ~1s，
// 间隔 1200ms 兼容；滚动失灵由 background 无进展窗口兜底，不在此处判死）
function scheduleUpperScroll() {
  if (upperScrollTimer) clearTimeout(upperScrollTimer);
  upperScrollTimer = setTimeout(() => {
    upperScrollTimer = null;
    if (!upper || upper.done || upper.error) return;
    try {
      window.scrollTo(0, document.documentElement.scrollHeight);
    } catch {}
    scheduleUpperScroll();
  }, UPPER_SCROLL_GAP_MS);
}

function startUpper(secUid) {
  if (upperScrollTimer) { clearTimeout(upperScrollTimer); upperScrollTimer = null; }
  upper = { secUid, profile: null, items: [], seen: new Set(), hasMore: true, done: false, error: null };
  // 重放缓冲里同 secUid 的消息（首页/profile 可能先于 START 到达）
  for (const { type, data } of upperBuffer) {
    if (data?.secUid !== secUid) continue;
    if (type === 'POST_LIST') pushUpperPage(data);
    else if (type === 'POST_LIST_EMPTY') {
      upper.error = 'post 列表 200 空体：该浏览器未登录抖音（或被风控 gating），需在登录态执行博主批量';
    } else if (type === 'PROFILE_OTHER') upper.profile = data.user ?? null;
  }
  scheduleUpperScroll();
  console.log(`[content-dy] DY_UPPER_START secUid=${secUid.slice(-8)} buffer重放=${upperBuffer.length}条`);
}

function upperStateOf() {
  if (!upper) return 'idle';
  if (upper.error) return 'error';
  return upper.done ? 'done' : 'running';
}

// 博主批量三类消息（POST_LIST / POST_LIST_EMPTY / PROFILE_OTHER）共用归属过滤：
// 聚合中且 secUid 匹配 → 投状态机；否则入环形缓冲（DY_UPPER_START 前先到的首页不丢）。
function onUpperMsg(type, data) {
  if (!(upper && data?.secUid === upper.secUid)) { bufferUpperMsg(type, data); return; }
  if (type === "POST_LIST") { pushUpperPage(data); return; }
  if (type === "POST_LIST_EMPTY") {
    upper.error = 'post 列表 200 空体：该浏览器未登录抖音（或被风控 gating），需在登录态执行博主批量';
    console.warn(`[content-dy] POST_LIST_EMPTY secUid=${data?.secUid.slice(-8)}（未登录 gating）`);
    return;
  }
  upper.profile = data.user ?? null; // PROFILE_OTHER
}

// inject-dy 消息分发；2026-08-29 S8 台账性重构：从 message 监听器拆出（复杂度台账达标），
// 逻辑逐字原样搬移。
function onInjectMessage(type, data) {
  if (type === "AWEME_DETAIL") {
    storeDetail(data?.awemeId, data?.detail, 'xhr');
    console.log(`[content-dy] AWEME_DETAIL aweme=${data?.awemeId}（累计 ${details.size} 个）`);
  } else if (type === "SSR_VIDEO_DETAIL") {
    // camelCase → snake_case 归一后按兜底规则入库（键见 douyin-format.mjs 对照表）
    const converted = ssrVideoDetailToAwemeDetail(data?.videoDetail);
    storeDetail(converted.aweme_id, converted, 'ssr');
    console.log(`[content-dy] SSR_VIDEO_DETAIL aweme=${converted.aweme_id}（SSR 兜底路）`);
  } else if (type === "POST_LIST" || type === "POST_LIST_EMPTY" || type === "PROFILE_OTHER") {
    onUpperMsg(type, data);
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "dy-sub-ext") return; // 仅处理本扩展 MAIN world inject 发的消息
  onInjectMessage(msg.type, msg.data);
});

// 详情查询：优先精确命中请求 id；单条且 id 不符时也返回（旧 ID 302 迁移到新 ID 的场景，
// S1 实测 /video/<旧ID> 会落到 /jingxuan?modal_id=<新ID>——页面 detail 即该链接的正主）。
function findDetail(awemeId) {
  const key = awemeId != null ? String(awemeId) : '';
  const exact = details.get(key);
  if (exact) return exact;
  if (details.size === 1) return [...details.values()][0];
  return null;
}

// GET_DETAIL：background fetch-douyin-subtitle 轮询用（对齐 content-yt GET_LOCAL_STATE 的查询模式）
function onGetDetail(msg, sendResponse) {
  const hit = findDetail(msg.awemeId);
  if (!hit) {
    sendResponse({ ok: true, state: "not-loaded" });
    return;
  }
  sendResponse({
    ok: true,
    state: "has-detail",
    awemeId: msg.awemeId,
    origin: hit.origin, // 'xhr' | 'ssr'（日志诊断：SSR 版本漂移时能看到走了哪路）
    detail: hit.detail,
  });
}

// GET_LOCAL_STATE：popup「视频信息」直取（hooks.ts useLocalCollected，vid 通用键）。回执对齐
// content-yt 形态：no-subtitle（匿名态主路径）/ has-subtitle（cla_info 有轨）；extra 复用
// buildDouyinPayload 的组装保证入库与展示同构。
function onGetLocalState(msg, sendResponse) {
  const vid = msg.vid ?? msg.bvid ?? msg.awemeId;
  const hit = findDetail(vid);
  if (!hit) {
    sendResponse({ ok: true, state: "not-loaded" });
    return;
  }
  const tracks = extractDouyinCaptionTracks(hit.detail);
  const payload = buildDouyinPayload(hit.detail, [], {});
  const subs = tracks.map((t) => ({
    lan: t.lan,
    lan_doc: t.lan_doc,
    track_type: t.is_auto === false ? 2 : 1,
    subtitle_url: t.url,
    url_missing: false,
    has_body: false, // 正文由 background 主动采集时抓取，content-dy 不缓存正文
  }));
  sendResponse({
    ok: true,
    state: tracks.length === 0 ? "no-subtitle" : "has-subtitle",
    bvid: vid,
    extra: payload.video.extra,
    subs,
    bodies: {},
  });
}

// DY_UPPER_START：background expand-douyin-upper 启动博主页聚合（返回 ok 立即，数据经
// GET_UPPER_STATE 流出）
function onUpperStart(msg, sendResponse) {
  if (typeof msg.secUid === "string" && msg.secUid) {
    startUpper(msg.secUid);
    sendResponse({ ok: true });
  } else {
    sendResponse({ ok: false, error: "secUid required" });
  }
}

// GET_UPPER_STATE：background 轮询聚合进度
function onUpperState(sendResponse) {
  sendResponse({
    ok: true,
    state: upperStateOf(),
    secUid: upper?.secUid ?? null,
    profile: upper?.profile ?? null,
    items: upper?.items ?? [],
    error: upper?.error ?? null,
  });
}

// chrome.runtime 消息分发；2026-08-29 S8 台账性重构：四类查询各自拆处理函数
//（复杂度台账达标），逻辑逐字原样搬移。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_DETAIL") { onGetDetail(msg, sendResponse); return false; }
  if (msg?.type === "GET_LOCAL_STATE") { onGetLocalState(msg, sendResponse); return false; }
  if (msg?.type === "DY_UPPER_START") { onUpperStart(msg, sendResponse); return false; }
  if (msg?.type === "GET_UPPER_STATE") { onUpperState(sendResponse); return false; }
  return false;
});
