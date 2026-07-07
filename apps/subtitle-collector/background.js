import { SERVER_URL, PING_URL, TOKEN } from "./config.js";
import { shouldReport, genClientId, CLIENT_ID_KEY, REPORTING_KEY } from "./reporting.mjs";
import { resolveConnectionMode, isStandalone, CONNECTION_MODE_KEY, MODE_SERVER, MODE_STANDALONE } from "./connection-mode.mjs";
import { extractKeysFromNav } from "./wbi.js";
import { biliFetch, formatSearchResult, fetchSubtitleView } from "./bili-fetch.js";
import { buildIngestPayload, normalizeUrl, normalizeTags } from "./ingest-payload.js";
const EXT_VERSION = chrome.runtime.getManifest().version;

let ws = null;
let reconnectAttempts = 0;
let reportingEnabled = true; // 内存态；启动从 storage 载入，默认 true（fail-open）
let clientId = null;         // 内存态；启动载入或首次生成
let connectionMode = MODE_SERVER; // 内存态；启动载入，默认 server（向后兼容）。standalone=纯扩展：不连不上报
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 10000;

// Wbi img_key/sub_key 缓存（全站每日更替，进程内缓存，按需 refresh）
let wbiKeys = null;
let wbiKeysAt = 0;
const WBI_KEYS_TTL_MS = 60 * 60 * 1000; // 1 小时：B 站 wbi keys 每日更替，TTL 兜底防 stale
async function refreshWbiKeys() {
  const parsed = await biliFetch('/x/web-interface/nav');
  if (!parsed.ok) throw new Error('nav fetch failed: ' + (parsed.code ?? ''));
  wbiKeys = extractKeysFromNav(parsed);
  wbiKeysAt = Date.now();
  return wbiKeys;
}
async function ensureWbiKeys() {
  if (!wbiKeys || Date.now() - wbiKeysAt > WBI_KEYS_TTL_MS) await refreshWbiKeys();
}

// P4：被动采 UP 资料（7 天 TTL）。TTL 用 chrome.storage 持久（SW 重启不丢）。失败抛错由调用方 catch。
async function ensureUpperInfo(mid) {
  const key = `upperInfoAt:${mid}`;
  const { [key]: at = 0 } = await chrome.storage.local.get(key);
  if (Date.now() - at < 7 * 24 * 3600 * 1000) return; // 7 天内跳过
  await ensureWbiKeys();
  const infoRes = await biliFetch('/x/space/wbi/acc/info', { wbi: true, params: { mid }, wbiKeys });
  if (!infoRes.ok) throw new Error('acc/info ' + infoRes.code);
  const statRes = await biliFetch('/x/relation/stat', { params: { vmid: mid } });
  const stat = statRes.ok ? statRes.data : {};
  const info = infoRes.data;
  const creator = {
    source_uid: String(mid),
    name: info.name ?? null, avatar: info.face ?? null,
    sign: info.sign ?? null, level: info.level ?? null, sex: info.sex ?? null,
    official_type: info.official?.type ?? null, official_title: info.official?.title ?? null,
    fans: stat.follower ?? null, following: stat.following ?? null,
  };
  ws.send(JSON.stringify({ type: "ingest-upper", payload: { source: "bilibili", creator } }));
  await chrome.storage.local.set({ [key]: Date.now() });
}

// P4：被动采 UP 最新视频（1h TTL，chrome.storage 缓存，不入库）。失败抛错由调用方 catch。
async function ensureUpperVideos(mid) {
  const key = `upperVideosAt:${mid}`;
  const { [key]: at = 0 } = await chrome.storage.local.get(key);
  if (Date.now() - at < 3600 * 1000) return; // 1h 内跳过
  await ensureWbiKeys();
  const parsed = await biliFetch('/x/space/wbi/arc/search', { wbi: true, params: { mid, pn: 1, ps: 10, order: 'pubdate' }, wbiKeys });
  if (!parsed.ok) throw new Error('arc/search ' + parsed.code);
  const items = (parsed.data?.list?.vlist ?? []).map((v) => ({ bvid: v.bvid, title: v.title, created: v.created ?? null }));
  await chrome.storage.local.set({ [`upperVideos:${mid}`]: { items, fetchedAt: Date.now() }, [key]: Date.now() });
}

// MV3 SW 保活兜底：周期 alarm 唤醒 SW，若 ws 未 OPEN 则触发重连（C1）
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => {
  // 纯扩展模式：不自发重连（用户主动断开，alarm 唤醒也不连）
  if (a.name === "keepalive" && ws?.readyState !== WebSocket.OPEN && !isStandalone(connectionMode)) connect();
});

// 启动载入持久态：clientId（无则生成并回写）、reportingEnabled（默认 true）、connectionMode（默认 server）
async function loadPersistedState() {
  const items = await chrome.storage.local.get([CLIENT_ID_KEY, REPORTING_KEY, CONNECTION_MODE_KEY]);
  if (items[CLIENT_ID_KEY]) {
    clientId = items[CLIENT_ID_KEY];
  } else {
    clientId = genClientId();
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId });
  }
  reportingEnabled = shouldReport(items[REPORTING_KEY]); // undefined → true
  connectionMode = resolveConnectionMode(items[CONNECTION_MODE_KEY]); // undefined → server
}

// 统一更新开关：内存 + storage
async function applyReporting(enabled) {
  reportingEnabled = enabled === true;
  await chrome.storage.local.set({ [REPORTING_KEY]: reportingEnabled });
  return reportingEnabled;
}

// 统一更新连接模式：内存 + storage（归一后落盘，防脏值）。不在此处切连/断连——由 SET_CONNECTION_MODE 调用方按返回值决定。
async function applyConnectionMode(mode) {
  connectionMode = resolveConnectionMode(mode);
  await chrome.storage.local.set({ [CONNECTION_MODE_KEY]: connectionMode });
  return connectionMode;
}

async function probeServer() {
  try {
    const res = await fetch(PING_URL, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch { return false; }
}

function scheduleReconnect() {
  // 纯扩展模式：用户主动断开，不重连（覆盖 onclose→scheduleReconnect 路径）
  if (isStandalone(connectionMode)) return;
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_MS);
  setTimeout(connect, delay);
}

async function connect() {
  if (isStandalone(connectionMode)) return; // 纯扩展模式：不连 server
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (!(await probeServer())) { scheduleReconnect(); return; }
  try {
    ws = new WebSocket(SERVER_URL);
  } catch { scheduleReconnect(); return; }
  ws.onopen = () => {
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: "hello", ext_version: EXT_VERSION, token: TOKEN, client_id: clientId, reporting_enabled: reportingEnabled }));
    flushPendingIngests();
  };
  ws.onmessage = async (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    // 无 id 的服务端推送（ingest-ack / hello-ack / hello-nack）须在 id 守卫前消费
    if (msg.type === "ingest-ack") {
      if (msg.ok === false) {
        console.log(`[background] 上报失败 source_vid=${msg.source_vid}`);
      } else {
        console.log(`[background] 上报完成 source_vid=${msg.source_vid} 新增 ${msg.inserted_tracks} 条版本 / 跳过 ${msg.skipped_tracks} 条（已存在）`);
      }
      chrome.runtime.sendMessage({ type: "INGEST_RESULT", ok: msg.ok !== false, source_vid: msg.source_vid, inserted: msg.inserted_tracks, skipped: msg.skipped_tracks });
      return;
    }
    if (msg.type === "hello-ack" || msg.type === "hello-nack") {
      console.log(`[background] 握手结果 type=${msg.type}`);
      return;
    }
    if (!msg.id) return;
    try {
      if (msg.action === "navigate") {
        await chrome.tabs.create({ url: msg.url });
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { opened: true } }));
      } else if (msg.action === "operate") {
        // 只找 B 站视频页（manifest content_scripts matches 决定哪些 tab 注入了 content.js）
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: "*://www.bilibili.com/video/*" });
        if (!tab?.id) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "当前活跃 tab 非 B 站视频页，无法执行 operate" }));
          return;
        }
        try {
          const resp = await chrome.tabs.sendMessage(tab.id, { type: "OPERATE", op: msg.op });
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: resp?.ok !== false, data: resp }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "content script 通信失败: " + (err.message || err) }));
        }
      } else if (msg.action === "search") {
        try {
          await ensureWbiKeys();
          const parsed = await biliFetch('/x/web-interface/wbi/search/type', {
            wbi: true,
            params: {
              search_type: 'video',
              keyword: msg.keyword,
              page: msg.page ?? 1,
              order: msg.order ?? 'pubdate',
              ...(msg.tid ? { tid: msg.tid } : {}),
            },
            wbiKeys,
          });
          if (!parsed.ok) {
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: parsed.code }));
          } else {
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: formatSearchResult(parsed.data) }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "fetch-subtitle") {
        try {
          const bvid = msg.bvid;
          // 1. view：完整元信息（标题/UP owner/stat/tags/pages/desc，组装 extra）
          const viewRes = await biliFetch('/x/web-interface/view', { params: { bvid } });
          if (!viewRes.ok) { ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: viewRes.code })); return; }
          const view = viewRes.data;
          // 1.5. 标签：/x/tag/archive/tags（免 wbi 签名，GET ?aid=）。view 响应无 tags 数组，须单独抓。
          //       失败（404/风控/网络）绝不阻断主字幕采集——try/catch 吞掉，tags 保持 []。
          let tags = [];
          try {
            const tagRes = await biliFetch('/x/tag/archive/tags', { params: { aid: view.aid } });
            if (tagRes.ok) tags = normalizeTags(tagRes.data);
            else console.warn(`[background] fetch-subtitle 标签接口失败 aid=${view.aid} code=${tagRes.code}`);
          } catch (e) {
            console.warn(`[background] fetch-subtitle 标签接口异常 aid=${view.aid}`, String(e?.message ?? e));
          }
          // 2. player/wbi/v2：字幕轨
          await ensureWbiKeys();
          const playerRes = await biliFetch('/x/player/wbi/v2', { wbi: true, params: { bvid, aid: view.aid, cid: view.cid }, wbiKeys });
          if (!playerRes.ok) { ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: playerRes.code })); return; }
          const pData = playerRes.data ?? {};
          // 2.5 AI 字幕独立接口 /x/v2/subtitle/web/view：新版播放器把 AI 字幕移到这里（player/wbi/v2 只剩 CC 字幕）。
          //     充电专属等「只有 AI 字幕、无 CC」的视频，player/wbi/v2 的 subtitles 为空，必须补这个接口才采得到。
          const aiSubs = await fetchSubtitleView(view.cid, view.aid);
          // 合并 CC（player/wbi/v2）+ AI（subtitle/web/view），按 subtitle_url 去重
          const seenUrl = new Set();
          const subs = [...(pData.subtitle?.subtitles ?? []), ...aiSubs].filter((s) => {
            const u = normalizeUrl(s.subtitle_url);
            if (!u || seenUrl.has(u)) return false;
            seenUrl.add(u); return true;
          });
          // 付费/充电标志（写 extra.paid，供 server 落独立列 + CLI --paid 过滤）
          const elecType = pData.elec_high_level?.privilege_type ?? null;
          const isPaid = !!(pData.is_upower_exclusive || pData.is_ugc_pay_preview || elecType || view.rights?.pay || view.rights?.ugc_pay || view.rights?.arc_pay);
          const paidInfo = isPaid ? {
            is_upower_exclusive: pData.is_upower_exclusive ?? false,
            is_ugc_pay_preview: pData.is_ugc_pay_preview ?? false,
            elec_privilege_type: elecType,
          } : null;
          // 3. 字幕体：fetch 用 normalize 后的 url，bodies key 也用 normalize 后的 url（对齐 ingest-payload.js 的 normalizeUrl 查找）
          const bodies = {};
          for (const s of subs) {
            const url = normalizeUrl(s.subtitle_url);
            if (!url) continue;
            try {
              const r = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/' } });
              if (!r.ok) { console.warn(`[background] fetch-subtitle 字幕体 HTTP ${r.status} bvid=${msg.bvid} url=${url}`); continue; }
              const body = await r.json().catch(() => null);
              if (body) bodies[url] = body;
              else console.warn(`[background] fetch-subtitle 字幕体 JSON 解析失败 bvid=${msg.bvid} url=${url}`);
            } catch (e) {
              // 单轨字幕体抓取失败（如加密 URL Chrome 拒绝 fetch）不阻断其它轨 + 主流程
              console.warn(`[background] fetch-subtitle 字幕体抓取异常 bvid=${msg.bvid} url=${url} err=${String(e?.message ?? e)}`);
            }
          }
          // 4. 过滤字幕体抓取失败的轨，避免 payload:null 入库污染 external 去重
          const validSubs = subs.filter((s) => {
            const u = normalizeUrl(s.subtitle_url);
            return u && bodies[u] != null;
          });
          if (validSubs.length > 0) {
            // 有字幕（普通视频 CC / AI 明文）：直接入库
            sendIngest(buildIngestPayload(view, validSubs, bodies, tags, paidInfo));
            ws.send(JSON.stringify({
              type: "result", id: msg.id, ok: true,
              data: { bvid, tracks: validSubs.length, ai_tracks: aiSubs.length, ingested: true, ...(isPaid ? { paid: true } : {}) },
            }));
          } else if (isPaid) {
            // 充电视频字幕加密（%00，Chrome 拒 fetch），API 拿不到 → navigate 打开页面，
            // 复用被动采集链路（content 自动点 AI 字幕 → inject 拦明文 aisubtitle → INGEST）。频率可控（锁+间隔）。
            sendIngest(buildIngestPayload(view, [], {}, tags, paidInfo)); // video 行先入库（含 paid 标记）
            const ok = await collectViaNavigate(bvid, 20000);
            ws.send(JSON.stringify({
              type: "result", id: msg.id, ok: true,
              data: { bvid, tracks: ok ? 1 : 0, ai_tracks: aiSubs.length, ingested: true, paid: true, navigated: true, ...(ok ? {} : { reason: 'no_subtitle' }) },
            }));
          } else {
            // 真无字幕：video 入库（避免重采），无轨
            sendIngest(buildIngestPayload(view, [], {}, tags, paidInfo));
            ws.send(JSON.stringify({
              type: "result", id: msg.id, ok: true,
              data: { bvid, tracks: 0, ai_tracks: aiSubs.length, ingested: true, reason: 'no_subtitle' },
            }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "get-upper-info") {
        try {
          await ensureWbiKeys();
          const mid = msg.mid;
          // 1. acc/info（Wbi）：name/sign/level/sex/official/face
          const infoRes = await biliFetch('/x/space/wbi/acc/info', { wbi: true, params: { mid }, wbiKeys });
          if (!infoRes.ok) { ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: infoRes.code })); return; }
          const info = infoRes.data;
          // 2. relation/stat（cookie）：follower/following
          const statRes = await biliFetch('/x/relation/stat', { params: { vmid: mid } });
          const statFailed = !statRes.ok;
          const stat = statRes.ok ? statRes.data : {};
          // 3. 上报 ingest-upper（入库 creators）
          const creator = {
            source_uid: String(mid),
            name: info.name ?? null,
            avatar: info.face ?? null,
            sign: info.sign ?? null,
            level: info.level ?? null,
            sex: info.sex ?? null,
            official_type: info.official?.type ?? null,
            official_title: info.official?.title ?? null,
            fans: stat.follower ?? null,
            following: stat.following ?? null,
          };
          ws.send(JSON.stringify({ type: "ingest-upper", payload: { source: "bilibili", creator } }));
          // 4. 回执
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { mid, ...creator, stat_failed: statFailed } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "list-upper-videos") {
        try {
          await ensureWbiKeys();
          const parsed = await biliFetch('/x/space/wbi/arc/search', {
            wbi: true,
            params: { mid: msg.mid, pn: msg.page ?? 1, ps: msg.page_size ?? 30, order: 'pubdate' },
            wbiKeys,
          });
          if (!parsed.ok) {
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: parsed.code }));
          } else {
            const vlist = parsed.data?.list?.vlist ?? [];
            const items = vlist.map((v) => ({
              bvid: v.bvid, title: v.title, created: v.created ?? null,
              play: v.play ?? null, length: v.length ?? null,
            }));
            ws.send(JSON.stringify({
              type: "result", id: msg.id, ok: true,
              data: { total: parsed.data?.page?.count ?? items.length, items },
            }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "set-reporting") {
        const newEnabled = await applyReporting(msg.enabled === true);
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { reporting_enabled: newEnabled } }));
        // set-reporting 路径不发 reporting-state：server 作为发起方据 result 更新状态
      } else {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "unknown action: " + msg.action }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
    }
  };
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// 生成 ingest payload 摘要字符串，供各分支日志复用
function payloadSummary(payload) {
  const v = payload?.video || {};
  const tracks = payload?.tracks || [];
  const bodySizes = tracks.map((t) => t?.versions?.[0]?.payload?.length || 0).join(",");
  return `source_vid=${v.source_vid} title=${v.title} UP=${v.creator?.name} 轨数=${tracks.length} 各轨body_size=${bodySizes}`;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "INGEST" && msg.payload) {
    const payload = msg.payload;
    // 纯扩展模式：丢弃所有被动上报（含 force 手动上报——无 server 可收）；content.js 本地捕获不受影响
    if (isStandalone(connectionMode)) {
      console.log(`[background] ingest 丢弃（纯扩展模式）source_vid=${payload.video?.source_vid}`);
      sendResponse({ ok: true, dropped: true });
      return true;
    }
    // navigate 采集：被动 INGEST 到达，唤醒等待中的 collectViaNavigate
    const navBvid = payload?.video?.source_vid;
    const pending = pendingNavCollect.get(navBvid);
    const fromNavigate = !!pending; // navigate 采集的被动 INGEST，绕过上报开关（主动采集触发）
    if (pending) { pendingNavCollect.delete(navBvid); pending.resolve(true); }
    const summary = payloadSummary(payload);
    const force = msg.force === true || fromNavigate;
    if (force) {
      console.log(`[background] ingest 强制上报（手动上报，绕过开关）source_vid=${payload.video?.source_vid}`);
    } else if (!shouldReport(reportingEnabled)) {
      console.log(`[background] ingest 丢弃（开关关）${summary}`);
      sendResponse({ ok: true, dropped: true });
      return true;
    }
    sendIngest(payload);
    // P4：顺带被动采 UP 资料（7天）+ 最新视频（1h），异步、失败静默（不影响字幕主链路）
    const mid = payload.video?.creator?.source_uid;
    if (mid) {
      ensureUpperInfo(mid).catch((e) => console.warn('[background] passive upper-info failed', String(e?.message ?? e)));
      ensureUpperVideos(mid).catch((e) => console.warn('[background] passive upper-videos failed', String(e?.message ?? e)));
    }
    sendResponse({ ok: true });
  } else if (msg?.type === "WS_STATUS") {
    sendResponse({ ok: true, connected: ws?.readyState === WebSocket.OPEN, mode: connectionMode });
  } else if (msg?.type === "FETCH_SUBTITLE" && msg.url) {
    // content script 请求 background 抓字幕体（background 有 host_permissions，免 CORS）
    // B 站新版播放器改用同源 protobuf endpoint，inject 拦不到旧 aisubtitle 请求，故由 background 主动抓
    fetch(msg.url, { headers: { "Referer": "https://www.bilibili.com/" } })
      .then(async (r) => {
        if (!r.ok) { sendResponse({ ok: false, error: "HTTP " + r.status }); return; }
        const body = await r.json().catch(() => null);
        if (!body) { sendResponse({ ok: false, error: "json parse failed" }); return; }
        sendResponse({ ok: true, body });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
  } else if (msg?.type === "MANUAL_CAPTURE") {
    // 只找 B 站视频页（避免对 chrome:// 等无 content script 的 tab sendMessage 抛 "Receiving end does not exist"）
    chrome.tabs.query({ active: true, currentWindow: true, url: "*://www.bilibili.com/video/*" }, ([tab]) => {
      if (tab?.id) {
        // force:true 绕过上报开关：用户在「手动」模式下点「上报」就是明确要上报，不该被自动开关拦截
        chrome.tabs.sendMessage(tab.id, { type: "RE_AGG", force: true }, () => {
          if (chrome.runtime.lastError) console.warn('[collector] RE_AGG 失败:', chrome.runtime.lastError.message);
        });
      }
    });
    sendResponse({ ok: true });
  } else if (msg?.type === "SET_REPORTING") {
    applyReporting(msg.enabled === true).then((enabled) => {
      // popup 本地变化 → 发 reporting-state 同步 server
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "reporting-state", enabled }));
      }
      sendResponse({ ok: true, reporting_enabled: enabled });
    });
    return true;
  } else if (msg?.type === "SET_CONNECTION_MODE") {
    const newMode = resolveConnectionMode(msg.mode);
    applyConnectionMode(newMode).then(async (mode) => {
      if (mode === MODE_STANDALONE) {
        // 切纯扩展：断 WS + 清 pending（onclose→scheduleReconnect 已被 isStandalone 守卫拦，不会重连）
        try { ws?.close(); } catch {}
        ws = null;
        await chrome.storage.local.set({ pendingIngests: [] });
      } else {
        // 切回 server：重置退避计数并触发连接
        reconnectAttempts = 0;
        connect();
      }
      sendResponse({ ok: true, mode });
    });
    return true;
  }
  return true;
});

// navigate 采集：主动采集对充电视频（字幕加密拿不到）打开页面，复用被动采集链路入库。
// 频率控制：同时只 1 个 navigate（navCollectBusy 锁）；tab 关闭后间隔 = navGapBaseMs + 随机 navGapRandomMs（防风控）。
let navCollectBusy = false;
const pendingNavCollect = new Map(); // bvid -> { resolve }
// 间隔配置（chrome.storage.local 可覆盖：nav_gap_base_ms / nav_gap_random_ms，单位 ms）。默认 1s + 随机 0-2s。
let navGapBaseMs = 1000;
let navGapRandomMs = 2000;
async function loadNavGapConfig() {
  const cfg = await chrome.storage.local.get(['nav_gap_base_ms', 'nav_gap_random_ms']);
  if (typeof cfg.nav_gap_base_ms === 'number' && cfg.nav_gap_base_ms >= 0) navGapBaseMs = cfg.nav_gap_base_ms;
  if (typeof cfg.nav_gap_random_ms === 'number' && cfg.nav_gap_random_ms >= 0) navGapRandomMs = cfg.nav_gap_random_ms;
}
async function collectViaNavigate(bvid, timeoutMs = 20000) {
  while (navCollectBusy) await new Promise((r) => setTimeout(r, 500)); // 等锁（同时只 1 个 navigate）
  navCollectBusy = true;
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: `https://www.bilibili.com/video/${bvid}`, active: true }); // 前台：后台 tab 播放器不活跃，自动点触发不了 aisubtitle
    tabId = tab.id;
    // 通知 content 强制点 AI 字幕（navigate 主动采集，绕过上报开关）。content 注入后接收，未就绪则重试。
    const notify = (retries = 0) => {
      chrome.tabs.sendMessage(tab.id, { type: "NAV_TRIGGER_AI", bvid }, () => {
        if (chrome.runtime.lastError && retries < 30) setTimeout(() => notify(retries + 1), 500);
      });
    };
    notify();
    // 等被动采集 INGEST 该 bvid（content 自动点 AI 字幕 → inject 拦明文 aisubtitle → INGEST）
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => { pendingNavCollect.delete(bvid); resolve(false); }, timeoutMs);
      pendingNavCollect.set(bvid, { resolve: (v) => { clearTimeout(t); resolve(v); } });
    });
    return ok;
  } catch (e) {
    console.warn(`[background] navigate 采集失败 bvid=${bvid}`, String(e?.message ?? e));
    return false;
  } finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} }
    navCollectBusy = false;
    await new Promise((r) => setTimeout(r, navGapBaseMs + Math.random() * navGapRandomMs)); // 关闭间隔（base+随机，防风控）
  }
}

// 统一 ingest 上报：WS OPEN 直发；断线时落 pendingIngests storage，重连后 flushPendingIngests 补发。
// fetch-subtitle（主动）与 content→background INGEST（被动）共用，保证 WS 断时不丢。
// 纯扩展模式下短路（不连不存 pending）——由调用前的 INGEST 短路与本函数守卫双重覆盖。
function sendIngest(payload) {
  if (isStandalone(connectionMode)) return; // 纯扩展：不上报、不存 pending（永不补发）
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ingest", payload }));
  } else {
    chrome.storage.local.get(["pendingIngests"], ({ pendingIngests = [] }) => {
      chrome.storage.local.set({ pendingIngests: [...pendingIngests, payload] });
    });
  }
}

// 补发暂存记录（重连成功后调用）
async function flushPendingIngests() {
  const { pendingIngests = [] } = await chrome.storage.local.get(["pendingIngests"]);
  if (pendingIngests.length === 0) return;
  for (const payload of pendingIngests) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ingest", payload }));
  }
  await chrome.storage.local.set({ pendingIngests: [] });
}

loadPersistedState().then(() => loadNavGapConfig()).then(() => {
  // 纯扩展模式：启动不连 server（模式由 storage 持久，SW 回收重启后仍生效）
  if (!isStandalone(connectionMode)) connect();
});
