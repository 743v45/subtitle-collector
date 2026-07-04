import { SERVER_URL, PING_URL, TOKEN } from "./config.js";
import { shouldReport, genClientId, CLIENT_ID_KEY, REPORTING_KEY } from "./reporting.mjs";
import { extractKeysFromNav } from "./wbi.js";
import { biliFetch, formatSearchResult } from "./bili-fetch.js";
import { buildIngestPayload, normalizeUrl } from "./ingest-payload.js";
const EXT_VERSION = chrome.runtime.getManifest().version;

let ws = null;
let reconnectAttempts = 0;
let reportingEnabled = true; // 内存态；启动从 storage 载入，默认 true（fail-open）
let clientId = null;         // 内存态；启动载入或首次生成
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 10000;

// Wbi img_key/sub_key 缓存（全站每日更替，进程内缓存，按需 refresh）
let wbiKeys = null;
async function refreshWbiKeys() {
  const parsed = await biliFetch('/x/web-interface/nav');
  if (!parsed.ok) throw new Error('nav fetch failed: ' + (parsed.code ?? ''));
  wbiKeys = extractKeysFromNav(parsed);
  return wbiKeys;
}

// MV3 SW 保活兜底：周期 alarm 唤醒 SW，若 ws 未 OPEN 则触发重连（C1）
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive" && ws?.readyState !== WebSocket.OPEN) connect();
});

// 启动载入持久态：clientId（无则生成并回写）、reportingEnabled（默认 true）
async function loadPersistedState() {
  const items = await chrome.storage.local.get([CLIENT_ID_KEY, REPORTING_KEY]);
  if (items[CLIENT_ID_KEY]) {
    clientId = items[CLIENT_ID_KEY];
  } else {
    clientId = genClientId();
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId });
  }
  reportingEnabled = shouldReport(items[REPORTING_KEY]); // undefined → true
}

// 统一更新开关：内存 + storage
async function applyReporting(enabled) {
  reportingEnabled = enabled === true;
  await chrome.storage.local.set({ [REPORTING_KEY]: reportingEnabled });
  return reportingEnabled;
}

async function probeServer() {
  try {
    const res = await fetch(PING_URL, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch { return false; }
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_MS);
  setTimeout(connect, delay);
}

async function connect() {
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
      chrome.runtime.sendMessage({ type: "INGEST_RESULT", source_vid: msg.source_vid, inserted: msg.inserted_tracks, skipped: msg.skipped_tracks });
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
          if (!wbiKeys) await refreshWbiKeys();
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
          // 2. player/wbi/v2：字幕轨
          if (!wbiKeys) await refreshWbiKeys();
          const playerRes = await biliFetch('/x/player/wbi/v2', { wbi: true, params: { bvid, aid: view.aid, cid: view.cid }, wbiKeys });
          if (!playerRes.ok) { ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: playerRes.code })); return; }
          const subs = playerRes.data?.subtitle?.subtitles ?? [];
          // 3. 字幕体：fetch 用 normalize 后的 url，bodies key 也用 normalize 后的 url（对齐 ingest-payload.js 的 normalizeUrl 查找）
          const bodies = {};
          for (const s of subs) {
            const url = normalizeUrl(s.subtitle_url);
            if (!url) continue;
            const r = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/' } });
            if (!r.ok) { console.warn(`[background] fetch-subtitle 字幕体 HTTP ${r.status} bvid=${msg.bvid} url=${url}`); continue; }
            const body = await r.json().catch(() => null);
            if (body) bodies[url] = body;
            else console.warn(`[background] fetch-subtitle 字幕体 JSON 解析失败 bvid=${msg.bvid} url=${url}`);
          }
          // 4. ingest（无字幕也入库 video，避免下次重采）；过滤字幕体抓取失败的轨，避免 payload:null 入库污染 external 去重
          const validSubs = subs.filter((s) => {
            const u = normalizeUrl(s.subtitle_url);
            return u && bodies[u] != null;
          });
          const payload = buildIngestPayload(view, validSubs, bodies);
          ws.send(JSON.stringify({ type: "ingest", payload }));
          // 5. 回执（不阻塞等 ingest-ack；ingest 由 server 异步入库，result 只报实际入库轨数）
          ws.send(JSON.stringify({
            type: "result", id: msg.id, ok: true,
            data: { bvid, tracks: validSubs.length, ingested: true, ...(validSubs.length === 0 ? { reason: 'no_subtitle' } : {}) },
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "get-upper-info") {
        try {
          if (!wbiKeys) await refreshWbiKeys();
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
          if (!wbiKeys) await refreshWbiKeys();
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
      } else if (msg.action === "collect-now") {
        // 找当前激活的 B 站视频页 tab，下发 RE_AGG{force:true} 触发即时采集
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: "*://www.bilibili.com/video/*" });
        if (!tab?.id) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "no active bilibili video tab" }));
          return;
        }
        const m = tab.url?.match(/\/video\/(BV[\w]+)/);
        const bvid = m?.[1] ?? null;
        chrome.tabs.sendMessage(tab.id, { type: "RE_AGG", force: true }, () => {
          if (chrome.runtime.lastError) console.warn("[background] collect-now RE_AGG 失败:", chrome.runtime.lastError.message);
        });
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { dispatched: true, bvid } }));
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
    const summary = payloadSummary(payload);
    const force = msg.force === true;
    if (force) {
      console.log(`[background] ingest 强制上报（collect-now，绕过开关）source_vid=${payload.video?.source_vid}`);
    } else if (!shouldReport(reportingEnabled)) {
      console.log(`[background] ingest 丢弃（开关关）${summary}`);
      sendResponse({ ok: true, dropped: true });
      return true;
    }
    if (ws?.readyState === WebSocket.OPEN) {
      console.log(`[background] 上报中 ${summary}`);
      ws.send(JSON.stringify({ type: "ingest", payload }));
    } else {
      console.log(`[background] ingest 暂存（WS 未连接）${summary}`);
      chrome.storage.local.get(["pendingIngests"], ({ pendingIngests = [] }) => {
        chrome.storage.local.set({ pendingIngests: [...pendingIngests, payload] });
      });
    }
    sendResponse({ ok: true });
  } else if (msg?.type === "WS_STATUS") {
    sendResponse({ ok: true, connected: ws?.readyState === WebSocket.OPEN });
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
        chrome.tabs.sendMessage(tab.id, { type: "RE_AGG" }, () => {
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
  }
  return true;
});

// 补发暂存记录（重连成功后调用）
async function flushPendingIngests() {
  const { pendingIngests = [] } = await chrome.storage.local.get(["pendingIngests"]);
  if (pendingIngests.length === 0) return;
  for (const payload of pendingIngests) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ingest", payload }));
  }
  await chrome.storage.local.set({ pendingIngests: [] });
}

loadPersistedState().then(connect);
