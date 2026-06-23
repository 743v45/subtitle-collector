#!/usr/bin/env node
/**
 * 最小链路验证：通过 CDP 驱动 9223 的 Chrome（已加载 subtitle-collector 扩展），
 * 打开 B 站样本视频，观察扩展 inject/content 是否拦到字幕并上报服务端。
 *
 * 用法：node scripts/verify-min-via-cdp.mjs [BV_ID]
 * 前置：9223 的 Chrome 在跑 + 已 --load-extension=apps/subtitle-collector + collector-server 在 21527。
 *
 * 这是 MANUAL-collector.md 验收项 1-3 的自动化探针（不含 popup UI 点击，popup 需人工或 CDP 单独处理）。
 */
import WebSocket from "ws";

const CDP_HTTP = "http://127.0.0.1:9223";
const SERVER_API = "http://127.0.0.1:21527/api/videos";
const SERVER_PING = "http://127.0.0.1:21527/ping";
const BV = process.argv[2] || "BV1mhjg6SEJy";
const VIDEO_URL = `https://www.bilibili.com/video/${BV}`;
const WAIT_MS = 25000; // 等 player API + 字幕请求 + 上报

const log = (...a) => console.log(`[verify]`, ...a);
const warn = (...a) => console.warn(`[verify]`, ...a);

async function httpJson(url) {
  const r = await fetch(url);
  return r.json();
}

async function newTab() {
  // PUT 一个新 page target
  const r = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(VIDEO_URL)}`, { method: "PUT" });
  if (!r.ok) throw new Error(`new tab failed: ${r.status}`);
  return r.json();
}

async function listTargets() {
  return httpJson(`${CDP_HTTP}/json/list`);
}

function cdpSend(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function main() {
  // 0. 前置检查
  log("0. 前置检查...");
  const ping = await fetch(SERVER_PING).then((r) => r.ok).catch(() => false);
  if (!ping) { warn("  ✗ collector-server (21527) 没响应！先 cd apps/collector-server && pnpm dev"); }
  else log("  ✓ collector-server 在跑");

  const before = await httpJson(SERVER_API).catch(() => ({ items: [] }));
  log(`  ✓ 服务端当前入库: total=${before.total ?? before.items?.length ?? "?"}`);

  const ver = await httpJson(`${CDP_HTTP}/json/version`).catch(() => null);
  if (!ver) { warn("  ✗ 9223 Chrome 没响应！"); process.exit(1); }
  log(`  ✓ 9223 Chrome: ${ver.Browser}`);

  // 1. 看扩展 service worker 是否在 targets 里（确认扩展加载）
  log("\n1. 检查扩展是否加载...");
  let targets = await listTargets();
  const sw = targets.find((t) => t.type === "service_worker" && t.url?.includes("subtitle-collector"));
  if (sw) log(`  ✓ 找到扩展 service_worker: ${sw.url}`);
  else warn("  ✗ 没看到 subtitle-collector 的 service_worker —— 扩展可能没加载或被休眠");

  // 2. 打开样本视频
  log(`\n2. 打开样本视频 ${BV} ...`);
  let tab;
  try {
    tab = await newTab();
    log(`  ✓ 新建 tab: id=${tab.id}`);
  } catch (e) {
    warn(`  new tab 失败 (${e.message})，尝试用现有 tab`);
    targets = await listTargets();
    tab = targets.find((t) => t.type === "page");
    if (!tab) { warn("  ✗ 没有可用 page target"); process.exit(1); }
  }

  // 3. 挂 CDP，开 Console + Network 监听
  log(`\n3. 挂 CDP 到 tab，监听 console + network...`);
  const ws = await connectWs(tab.webSocketDebuggerUrl);
  let msgId = 0;
  const nextId = () => ++msgId;
  const playerApiSeen = [];
  const subtitleReqSeen = [];
  const riskControl = [];
  const needLogin = [];
  const consoleLogs = [];

  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.method === "Console.messageAdded") {
      const entry = m.params.message;
      consoleLogs.push(entry);
      const t = entry.text || "";
      if (t.includes("[inject]") || t.includes("[content]") || t.includes("[collector]") || t.includes("[background]")) {
        log(`  [console] ${t.slice(0, 300)}`);
      }
    } else if (m.method === "Log.entryAdded") {
      const e = m.params.entry;
      consoleLogs.push({ text: e.text, level: e.level });
      log(`  [log:${e.level}] ${e.text.slice(0, 300)}`);
    } else if (m.method === "Network.responseReceived") {
      const url = m.params.response?.url || "";
      if (url.includes("api.bilibili.com/x/player")) playerApiSeen.push(url);
      if (url.includes("aisubtitle") || url.includes("bfs/subtitle")) subtitleReqSeen.push(url);
    }
  });

  cdpSend(ws, nextId(), "Runtime.enable");
  cdpSend(ws, nextId(), "Console.enable");
  cdpSend(ws, nextId(), "Log.enable");
  cdpSend(ws, nextId(), "Network.enable");

  // 4. 等待扩展工作
  log(`\n4. 等待 ${WAIT_MS / 1000}s 让扩展拦字幕并上报...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // 5. 汇总观察
  log("\n5. === 观察汇总 ===");
  log(`  player API 响应: ${playerApiSeen.length} 次`);
  playerApiSeen.forEach((u) => log(`    - ${u.slice(0, 120)}`));
  log(`  字幕请求: ${subtitleReqSeen.length} 次`);
  subtitleReqSeen.forEach((u) => log(`    - ${u.slice(0, 120)}`));

  const rcLogs = consoleLogs.filter((l) => /风控|need_login|RISK/i.test(l.text || ""));
  rcLogs.forEach((l) => warn(`    ⚠ ${l.text.slice(0, 200)}`));
  if (rcLogs.length === 0 && subtitleReqSeen.length === 0 && playerApiSeen.length === 0) {
    warn("  ⚠ 没观察到任何 player API / 字幕请求 —— 视频可能需要登录，或页面没自动加载字幕");
  }

  // 6. 查服务端是否入库
  log("\n6. === 服务端入库检查 ===");
  const after = await httpJson(SERVER_API).catch(() => ({ items: [] }));
  const afterItems = after.items || [];
  const hit = afterItems.find((v) => v.source_vid === BV || v.video?.source_vid === BV);
  if (hit || (after.total ?? 0) > (before.total ?? 0)) {
    log(`  ✓ 服务端有新增！total: ${before.total ?? 0} → ${after.total ?? afterItems.length}`);
    if (hit) log(`    命中: ${JSON.stringify(hit).slice(0, 400)}`);
  } else {
    warn(`  ✗ 服务端无新增（total 仍为 ${after.total ?? afterItems.length}）`);
    warn("    可能原因: (a) 视频需登录才能拿字幕 (b) 字幕请求未触发 (c) WS 未连");
  }

  try { ws.close(); } catch {}
  log("\n完成。若未入库，请确认 9223 Chrome 已登录 B 站，再重跑。");
  process.exit(0);
}

main().catch((e) => { console.error("[verify] fatal:", e); process.exit(1); });
