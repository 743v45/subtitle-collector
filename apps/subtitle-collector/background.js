import { SERVER_URL, PING_URL, TOKEN } from "./config.js";
import { shouldReport, genClientId, CLIENT_ID_KEY, REPORTING_KEY } from "./reporting.mjs";
const EXT_VERSION = chrome.runtime.getManifest().version;

let ws = null;
let reconnectAttempts = 0;
let reportingEnabled = true; // 内存态；启动从 storage 载入，默认 true（fail-open）
let clientId = null;         // 内存态；启动载入或首次生成
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 10000;

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
      } else if (msg.action === "fetch-subtitle") {
        // MVP 占位（spec §6.2/§7.3 明列，协议闭环不吞 id；后续可接真实逻辑）
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "not implemented" }));
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
