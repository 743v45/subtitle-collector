#!/usr/bin/env node
/**
 * 触发字幕加载：点击 B 站播放器字幕按钮，让播放器去请求 subtitle_url，
 * 从而让 inject.js 拦到字幕请求、content.js 聚合、background 上报。
 *
 * 前置：9223 Chrome 已登录 B 站 + 视频页已打开。
 */
import WebSocket from "ws";

const CDP_HTTP = "http://127.0.0.1:9223";
const SERVER_API = "http://127.0.0.1:21527/api/videos";
const BV = "BV1mhjg6SEJy";
const log = (...a) => console.log(`[trigger]`, ...a);
const warn = (...a) => console.warn(`[trigger]`, ...a);

(async () => {
  // 服务端基线
  const before = await (await fetch(SERVER_API)).json();
  log(`服务端基线 total=${before.total ?? before.items?.length ?? 0}`);

  const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const tab = targets.find((t) => t.type === "page" && t.url?.includes(`bilibili.com/video/${BV}`));
  if (!tab) { warn("没找到视频页 tab，先打开视频"); process.exit(1); }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, c) => { ws.on("open", r); ws.on("error", c); });
  let id = 0; const pending = new Map();
  const consoleMsgs = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Log.entryAdded") {
      const t = m.params.entry.text || "";
      consoleMsgs.push(t);
      if (/\[inject\]|\[content\]|\[collector\]|\[background\]|ingest|subtitles?/i.test(t)) log(`  [page] ${t.slice(0, 250)}`);
    }
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");

  log("当前页:", tab.url.slice(0, 70));

  // 1. 点击字幕按钮（用扩展 content.js 同款选择器逻辑 + 兜底）
  log("\n1. 点击字幕按钮...");
  const clickRes = await send("Runtime.evaluate", {
    expression: `(() => {
      const sel = ".bpx-player-ctrl-btn-icon, [aria-label*='字幕'], .bpx-player-ctrl-subt";
      const els = document.querySelectorAll(sel);
      // 优先点字幕控制按钮本体
      let target = document.querySelector("[aria-label*='字幕']") || document.querySelector(".bpx-player-ctrl-subt") || document.querySelector(".bpx-player-ctrl-btn-icon");
      if (!target) return "no subtitle btn found";
      target.click();
      // 也派发指针/鼠标事件兜底（B 站用 React 合成事件）
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return "clicked: " + target.tagName + "." + (target.className||"").slice(0,40);
    })()`,
    returnByValue: true,
  });
  log(`  ${clickRes.result?.result?.value}`);

  // 2. 等 8s 看是否出现字幕菜单/触发请求，必要时点"中文(ai-zh)"
  await new Promise((r) => setTimeout(r, 8000));
  log("\n2. 查字幕菜单，选中文轨...");
  const pickRes = await send("Runtime.evaluate", {
    expression: `(() => {
      // 字幕菜单项通常带 lan 标识或"中文"文字
      const items = [...document.querySelectorAll(".bpx-player-ctrl-subtitle-panel-item, [class*=subtitle-item], .bpx-player-ctrl-subtitle-resul")];
      let picked = null;
      for (const it of items) {
        if (/中文|ai-zh|zh/i.test(it.textContent || "")) { it.click(); picked = it.textContent.trim().slice(0,20); break; }
      }
      return JSON.stringify({ items_count: items.length, texts: items.map(i=>(i.textContent||"").trim().slice(0,15)), picked });
    })()`,
    returnByValue: true,
  });
  log(`  ${pickRes.result?.result?.value}`);

  // 3. 等字幕请求被拦 + 上报
  log("\n3. 等 12s 让 inject 拦字幕 + 扩展上报...");
  await new Promise((r) => setTimeout(r, 12000));

  // 4. 服务端入库检查
  log("\n4. === 服务端入库检查 ===");
  const after = await (await fetch(SERVER_API)).json();
  const items = after.items || [];
  const hit = items.find((v) => v.source_vid === BV || v.video?.source_vid === BV || v.sourceVid === BV);
  if (hit || (after.total ?? items.length) > (before.total ?? 0)) {
    log(`✓✓✓ 成功入库！total: ${before.total ?? 0} → ${after.total ?? items.length}`);
    if (hit) log(`命中记录: ${JSON.stringify(hit).slice(0, 600)}`);
  } else {
    warn(`✗ 仍未入库 (total=${after.total ?? items.length})`);
    warn("  页面相关日志最后 10 条:");
    consoleMsgs.slice(-10).forEach((t) => warn(`    - ${t.slice(0, 180)}`));
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error("fatal:", e); process.exit(1); });
