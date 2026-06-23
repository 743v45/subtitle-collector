#!/usr/bin/env node
/**
 * 端到端：打开视频 → 等播放器就绪 → 点击字幕 → 监控完整上报链路 → 查入库。
 * 一个脚本跑完，不依赖中间 tab 状态。
 * 前置：9223 Chrome 已登录 B 站 + collector-server 在 21527。
 */
import WebSocket from "ws";

const CDP_HTTP = "http://127.0.0.1:9223";
const SERVER_API = "http://127.0.0.1:21527/api/videos";
const SERVER_PING = "http://127.0.0.1:21527/ping";
const BV = process.argv[2] || "BV1mhjg6SEJy";
const VIDEO_URL = `https://www.bilibili.com/video/${BV}`;
const log = (...a) => console.log(`[e2e]`, ...a);
const warn = (...a) => console.warn(`[e2e]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 0. 前置
  if (!(await fetch(SERVER_PING).then((r) => r.ok).catch(() => false))) { warn("✗ server 没跑"); process.exit(1); }
  const before = await (await fetch(SERVER_API)).json();
  log(`服务端基线 total=${before.total ?? before.items?.length ?? 0}`);

  // 1. 关掉可能存在的同视频旧 tab，开新的
  let targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  for (const t of targets.filter((t) => t.type === "page" && t.url?.includes(`/video/${BV}`))) {
    try { await fetch(`${CDP_HTTP}/json/close/${t.id}`); } catch {}
  }
  const tab = await (await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(VIDEO_URL)}`, { method: "PUT" })).json();
  log(`新 tab 已开: ${VIDEO_URL}`);

  // 2. 挂 CDP
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, c) => { ws.on("open", r); ws.on("error", c); });
  let id = 0; const pending = new Map();
  const pageLogs = [];
  const subReqs = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Log.entryAdded") {
      const t = m.params.entry.text || "";
      pageLogs.push(t);
      if (/\[inject\]|\[content\]|\[collector\]|\[background\]|ingest|subtitles?|PLAYER_META|SUBTITLE_BODY/i.test(t)) log(`  [page] ${t.slice(0, 220)}`);
    }
    if (m.method === "Network.responseReceived") {
      const u = m.params.response?.url || "";
      if (u.includes("aisubtitle") || u.includes("bfs/subtitle")) { subReqs.push(u); log(`  [net] 字幕请求: ${u.slice(0, 90)}`); }
    }
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");

  // 3. 等播放器就绪（inject 已 hook、player API 已返回）
  log("等 8s 让播放器加载 + inject 拦 player API...");
  await sleep(8000);

  // 确认登录态 + inject hook 生效
  const probe = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      logged: document.cookie.includes("SESSDATA"),
      fetch_hooked: window.fetch.toString().includes("ORIGINAL_FETCH"),
      has_subt_btn: !!document.querySelector("[aria-label*='字幕'], .bpx-player-ctrl-subt"),
    })`,
    returnByValue: true,
  });
  log(`环境检查: ${probe.result?.result?.value}`);
  const env = JSON.parse(probe.result?.result?.value || "{}");
  if (!env.logged) warn("  ⚠ 未检测到登录态！可能登录失效");
  if (!env.fetch_hooked) warn("  ⚠ inject 的 fetch hook 未生效（扩展 content/inject 可能没注入）");

  // 4. 点击字幕按钮
  log("点击字幕按钮...");
  const click = await send("Runtime.evaluate", {
    expression: `(() => {
      const btn = document.querySelector("[aria-label*='字幕']") || document.querySelector(".bpx-player-ctrl-subt");
      if (!btn) return "no btn";
      btn.click();
      btn.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));
      btn.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));
      btn.dispatchEvent(new MouseEvent("click",{bubbles:true}));
      return "clicked";
    })()`,
    returnByValue: true,
  });
  log(`  ${click.result?.result?.value}`);
  await sleep(3000);

  // 5. 如果弹了字幕菜单，选中文轨
  log("选字幕轨（若有菜单）...");
  const pick = await send("Runtime.evaluate", {
    expression: `(() => {
      const items = [...document.querySelectorAll("[class*=subtitle-item], .bpx-player-ctrl-subtitle-resul, .bpx-player-subtitle-panel-item")];
      let picked = null;
      for (const it of items) { if (/中文|ai-zh/i.test(it.textContent||"")) { it.click(); picked=(it.textContent||"").trim().slice(0,20); break; } }
      return JSON.stringify({ count: items.length, texts: items.map(i=>(i.textContent||"").trim().slice(0,15)), picked });
    })()`,
    returnByValue: true,
  });
  log(`  ${pick.result?.result?.value}`);

  // 6. 等字幕请求被拦 + 扩展上报
  log("等 15s 让字幕请求触发 + 扩展上报...");
  await sleep(15000);

  // 7. 若还没字幕请求，再点一次并等待
  if (subReqs.length === 0) {
    log("未观察到字幕请求，再点一次字幕按钮...");
    await send("Runtime.evaluate", {
      expression: `(()=>{const b=document.querySelector("[aria-label*='字幕'], .bpx-player-ctrl-subt"); if(b){b.click();b.dispatchEvent(new MouseEvent("click",{bubbles:true}));} return b?"reclicked":"no btn";})()`,
      returnByValue: true,
    });
    await sleep(10000);
  }

  // 8. 查入库
  log("\n=== 结果 ===");
  log(`字幕请求观察: ${subReqs.length} 次`);
  const after = await (await fetch(SERVER_API)).json();
  const items = after.items || [];
  const total = after.total ?? items.length;
  const beforeTotal = before.total ?? before.items?.length ?? 0;
  const hit = items.find((v) => v.source_vid === BV || v.video?.source_vid === BV || v.sourceVid === BV);
  if (total > beforeTotal || hit) {
    log(`✓✓✓ 入库成功！total: ${beforeTotal} → ${total}`);
    if (hit) log(`记录: ${JSON.stringify(hit).slice(0, 700)}`);
    log("\n完整详情:");
    const full = await (await fetch(SERVER_API)).json();
    for (const it of full.items || []) console.log("  " + JSON.stringify(it).slice(0, 500));
  } else {
    warn(`✗ 未入库 (total=${total})。字幕请求 ${subReqs.length} 次`);
    if (subReqs.length === 0) warn("  → 字幕请求没触发，可能需要播放视频或字幕按钮交互更复杂");
    else warn("  → 字幕请求有但没入库，检查扩展 background WS 连接");
    warn("  页面日志最后 8 条:");
    pageLogs.slice(-8).forEach((t) => warn(`    - ${t.slice(0, 160)}`));
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error("fatal:", e); process.exit(1); });
