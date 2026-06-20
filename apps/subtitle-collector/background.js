import { SERVER_URL, PING_URL, TOKEN } from "./config.js";
// config.js 内容（见 Step 5b）：
//   export const SERVER_URL = "ws://127.0.0.1:21527/ext";
//   export const PING_URL   = "http://127.0.0.1:21527/ping";
//   export const TOKEN      = "change-me-collector-token";  // 与服务端 config.js 预置 token 一致
const EXT_VERSION = chrome.runtime.getManifest().version;

let ws = null;
let reconnectAttempts = 0;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 10000;

// MV3 SW 保活兜底：周期 alarm 唤醒 SW，若 ws 未 OPEN 则触发重连（学 opencli keepalive）
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
    // 重连后补发：把 SW 被杀期间 content 暂存到 storage.local 的待上报记录一次性 flush
    flushPendingIngests();
  };
  ws.onmessage = async (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (!msg.id) return;
    // 收到 Command，分发
    try {
      if (msg.action === "navigate") {
        await chrome.tabs.create({ url: msg.url });
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { opened: true } }));
      } else if (msg.action === "operate") {
        // 找当前页 content script 执行
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const resp = await chrome.tabs.sendMessage(tab.id, { type: "OPERATE", op: msg.op });
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: resp?.ok !== false, data: resp }));
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
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ingest", payload: msg.payload }));
    } else {
      // WS 未连（SW 被杀/服务端重启）：暂存 storage.local，onopen 时 flushPendingIngests 补发
      chrome.storage.local.get(["pendingIngests"], ({ pendingIngests = [] }) => {
        chrome.storage.local.set({ pendingIngests: [...pendingIngests, msg.payload] });
      });
    }
    sendResponse({ ok: true });
  } else if (msg?.type === "WS_STATUS") {
    sendResponse({ ok: true, connected: ws?.readyState === WebSocket.OPEN });
  } else if (msg?.type === "MANUAL_CAPTURE") {
    // 触发当前页 content.js 重新聚合并上报
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "RE_AGG" });
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
