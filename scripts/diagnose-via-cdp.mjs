#!/usr/bin/env node
/**
 * 深度诊断：抓 player/wbi/v2 的实际响应，看 subtitles 数组 / need_login_subtitle / 风控。
 * 同时检查扩展 background SW 的连接状态。
 */
import WebSocket from "ws";

const CDP_HTTP = "http://127.0.0.1:9223";
const SERVER_API = "http://127.0.0.1:21527/api/videos";
const SERVER_WS_INFO = "http://127.0.0.1:21527/api/debug/ws";

const log = (...a) => console.log(`[diag]`, ...a);
const warn = (...a) => console.warn(`[diag]`, ...a);

async function listTargets() { return (await fetch(`${CDP_HTTP}/json/list`)).json(); }

function findVideoTab(targets) {
  return targets.find((t) => t.type === "page" && t.url?.includes("bilibili.com/video"));
}

async function main() {
  const targets = await listTargets();
  log("所有 targets:");
  targets.forEach((t) => log(`  [${t.type}] ${t.url?.slice(0, 90)}`));

  // 1. 扩展 SW 状态
  const sw = targets.find((t) => t.type === "service_worker");
  log(`\n扩展 service_worker: ${sw ? sw.url?.slice(0, 80) : "未找到（可能休眠/未加载）"}`);

  // 2. 找视频页 tab
  const tab = findVideoTab(targets);
  if (!tab) { warn("没有 bilibili 视频 tab，先跑 verify-min 打开一个"); process.exit(1); }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, c) => { ws.on("open", r); ws.on("error", c); });
  let id = 0; const nid = () => ++id;
  const pending = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => { const i = nid(); pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send("Runtime.enable");
  await send("Network.enable");

  // 3. 直接在页面里重发 player/wbi/v2，拿真实响应（绕过 inject hook 的日志，直接看原始数据）
  log("\n=== 在页面上下文重发 player/wbi/v2 ===");
  const expr = `(async () => {
    try {
      // aid/cid 可能在 __INITIAL_STATE__ 或 window 上
      const st = window.__INITIAL_STATE__ || {};
      const aid = st.aid ?? window.aid ?? "";
      const cid = st.cid ?? window.cid ?? "";
      const r = await fetch("https://api.bilibili.com/x/player/wbi/v2?aid=" + aid + "&cid=" + cid, { credentials: "include" });
      const j = await r.json();
      return JSON.stringify({
        http_status: r.status,
        code: j.code,
        message: j.message,
        need_login_subtitle: j.data?.need_login_subtitle,
        bvid: j.data?.bvid,
        aid_sent: aid, cid_sent: cid,
        subtitles_count: j.data?.subtitle?.subtitles?.length,
        subtitles: j.data?.subtitle?.subtitles,
      });
    } catch (e) { return "ERR:" + e.message; }
  })()`;
  const evalRes = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  log("player/wbi/v2 响应摘要:");
  try {
    const parsed = JSON.parse(evalRes.result?.result?.value);
    for (const l of JSON.stringify(parsed, null, 2).split("\n")) console.log("  " + l);
    if (parsed.code !== 0) warn(`  ⚠ code=${parsed.code} message=${parsed.message} → 风控/登录问题`);
    if (parsed.need_login_subtitle === true) warn("  ⚠ need_login_subtitle=true → 需要登录");
    const subLen = parsed.subtitles?.length;
    if (!subLen) warn("  ⚠ subtitles 为空 → 拿不到字幕 url");
    else log(`  ✓ subtitles 有 ${subLen} 轨`);
  } catch {
    log("  原始:", evalRes.result?.result?.value || JSON.stringify(evalRes).slice(0, 500));
  }

  // 4. 检查 cookie 登录态
  log("\n=== 登录态 cookie 检查 ===");
  const ck = await send("Runtime.evaluate", {
    expression: `document.cookie.includes("SESSDATA") ? "HAS_SESSDATA (已登录)" : "NO_SESSDATA (未登录)"`,
    returnByValue: true,
  });
  log(`  ${ck.result?.result?.value}`);

  // 5. 扩展 WS 连接状态（通过 content script 反查 background）
  log("\n=== 扩展内部状态 ===");
  const st = await send("Runtime.evaluate", {
    expression: `(async () => {
      try {
        // 检查 inject hook 是否生效（fetch 是否被替换）
        const fetchHooked = window.fetch.toString().includes("ORIGINAL_FETCH") ? "已 hook" : "未 hook";
        return "fetch hook: " + fetchHooked;
      } catch (e) { return "ERR:" + e.message; }
    })()`,
    returnByValue: true,
  });
  log(`  ${st.result?.result?.value}`);

  // 6. 服务端视角：看 WS 连接
  log("\n=== 服务端 WS 连接 ===");
  const dbg = await fetch(SERVER_WS_INFO).then((r) => r.text()).catch((e) => "no debug endpoint: " + e.message);
  log(`  ${dbg.slice(0, 300)}`);

  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
