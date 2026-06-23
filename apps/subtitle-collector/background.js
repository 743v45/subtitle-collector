import { SERVER_URL, PING_URL, TOKEN } from "./config.js";
const EXT_VERSION = chrome.runtime.getManifest().version;

let ws = null;
let reconnectAttempts = 0;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 10000;

// MV3 SW 保活兜底：周期 alarm 唤醒 SW，若 ws 未 OPEN 则触发重连（C1）
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive" && ws?.readyState !== WebSocket.OPEN) connect();
});

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
    ws.send(JSON.stringify({ type: "hello", ext_version: EXT_VERSION, token: TOKEN }));
    flushPendingIngests();
  };
  ws.onmessage = async (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "INGEST" && msg.payload) {
    const bvid = msg.payload.video?.source_vid ?? '?';
    console.log(`[background] ingest 转发 bvid=${bvid} ws_open=${ws?.readyState === WebSocket.OPEN}`);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ingest", payload: msg.payload }));
    } else {
      chrome.storage.local.get(["pendingIngests"], ({ pendingIngests = [] }) => {
        chrome.storage.local.set({ pendingIngests: [...pendingIngests, msg.payload] });
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

connect();
