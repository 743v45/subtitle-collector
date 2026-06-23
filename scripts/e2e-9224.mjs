#!/usr/bin/env node
/**
 * 端到端验证（裸 Chrome 9224 + CDP 注入 cookie）：
 *   9224 是裸命令行启动的系统 Chrome（非 puppeteer），扩展 content script 能正常注入。
 *   cookie 通过 CDP Storage.setCookies 注入（避免复制 profile 损坏 cookie）。
 *
 * 成功标准：A inject注入 B 登录态 C 字幕请求 D 服务端入库
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";

const CDP_HTTP = "http://127.0.0.1:9224";
const SERVER_API = "http://127.0.0.1:21527/api/videos";
const SERVER_PING = "http://127.0.0.1:21527/ping";
const COOKIE_FILE = "/tmp/bili-cookies.json";
const BV = process.argv[2] || "BV1mhjg6SEJy";
const VIDEO_URL = `https://www.bilibili.com/video/${BV}`;
const log = (...a) => console.log(`[e2e]`, ...a);
const warn = (...a) => console.warn(`[e2e]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = { A: false, B: false, C: false, D: false };

async function newTab(url) {
  return (await (await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json());
}

function mkWs(url) {
  return new Promise((res, rej) => { const ws = new WebSocket(url); ws.on("open", () => res(ws)); ws.on("error", rej); });
}

async function main() {
  if (!(await fetch(SERVER_PING).then((r) => r.ok).catch(() => false))) { console.error("✗ server 没跑"); process.exit(1); }
  const cookies = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
  log(`cookie ${cookies.length} 条，SESSDATA ${cookies.find((c) => c.name === "SESSDATA") ? "✓" : "✗"}`);
  const before = await (await fetch(SERVER_API)).json();
  const beforeTotal = before.total ?? before.items?.length ?? 0;
  log(`服务端基线 total=${beforeTotal}`);

  // 1. browser-level CDP，注入 cookie
  log("\n1. 注入 cookie 到 browser...");
  const ver = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  const bws = await mkWs(ver.webSocketDebuggerUrl);
  let bid = 0; const bpend = new Map();
  bws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id && bpend.has(m.id)) { bpend.get(m.id)(m); bpend.delete(m.id); } });
  const bsend = (method, params = {}) => new Promise((r) => { const i = ++bid; bpend.set(i, r); bws.send(JSON.stringify({ id: i, method, params })); });

  for (const c of cookies) {
    await bsend("Storage.setCookies", {
      cookies: [{
        name: c.name, value: c.value,
        domain: c.domain, path: c.path || "/",
        expires: c.expires, httpOnly: !!c.httpOnly, secure: !!c.secure,
        sameSite: c.sameSite || "Lax",
      }],
    });
  }
  log(`  注入 ${cookies.length} 条 cookie ✓`);

  // 2. 开视频 tab
  log(`\n2. 打开视频 ${BV}...`);
  const tab = await newTab(VIDEO_URL);
  await sleep(8000); // 等播放器 + player API + inject 注入

  // 3. 挂 CDP 到 tab，验证 inject + 登录态
  const ws = await mkWs(tab.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");

  log("\n3. 验证 inject 注入 + 登录态...");
  const probe = await send("Runtime.evaluate", {
    expression: `(async () => {
      const r = await fetch("https://api.bilibili.com/x/player/wbi/v2?aid=116757830374602&cid=39153305068", { credentials: "include" });
      const j = await r.json();
      return JSON.stringify({
        fetch_hooked: !window.fetch.toString().includes("[native code]"),
        has_ORIGINAL: window.fetch.toString().includes("ORIGINAL_FETCH"),
        player_code: j.code,
        need_login: j.data?.need_login_subtitle,
        subs: j.data?.subtitle?.subtitles?.length,
        first_sub_url: j.data?.subtitle?.subtitles?.[0]?.subtitle_url,
      });
    })()`,
    awaitPromise: true, returnByValue: true,
  });
  const info = JSON.parse(probe.result?.result?.value || "{}");
  log(`  ${JSON.stringify(info)}`);
  if (info.has_ORIGINAL || info.fetch_hooked) { checks.A = true; log("  ✓ A: inject 注入并 hook fetch"); }
  else warn("  ✗ A: inject 未注入");
  if (info.need_login === false && info.subs > 0) { checks.B = true; log(`  ✓ B: 登录态有效 subs=${info.subs}`); }
  else warn(`  ✗ B: 登录态 subs=${info.subs} need_login=${info.need_login}`);

  // 4. 触发字幕请求（页面内 fetch subtitle_url，inject 会 hook 到 SUBTITLE_BODY）
  if (info.first_sub_url) {
    log("\n4. 触发字幕请求...");
    const subUrl = info.first_sub_url.startsWith("//") ? "https:" + info.first_sub_url : info.first_sub_url;
    const trig = await send("Runtime.evaluate", {
      expression: `(async () => { try { const r = await fetch(${JSON.stringify(subUrl)}, {credentials:"include"}); return "ok "+r.status; } catch(e){ return "err:"+e.message; } })()`,
      awaitPromise: true, returnByValue: true,
    });
    log(`  字幕 fetch: ${trig.result?.result?.value}`);
    if (trig.result?.result?.value?.startsWith("ok")) checks.C = true;
    await sleep(3000); // 等 inject→content→background→WS
  }

  // 5. 服务端入库
  log("\n5. 验证服务端入库...");
  await sleep(1500);
  const after = await (await fetch(SERVER_API)).json();
  const items = after.items || [];
  const total = after.total ?? items.length;
  const hit = items.find((v) => v.source_vid === BV || v.video?.source_vid === BV || v.sourceVid === BV);
  log(`  total: ${beforeTotal} → ${total}`);
  if (total > beforeTotal || hit) {
    checks.D = true; log("  ✓ D: 入库成功！");
    for (const it of items) console.log("    " + JSON.stringify(it).slice(0, 600));
  } else warn("  ✗ D: 未入库");

  // 汇总
  log("\n===== 结论 =====");
  log(`A inject注入: ${checks.A ? "✓" : "✗"} | B 登录态: ${checks.B ? "✓" : "✗"} | C 字幕请求: ${checks.C ? "✓" : "✗"} | D 入库: ${checks.D ? "✓" : "✗"}`);
  const all = checks.A && checks.B && checks.C && checks.D;
  log(all ? "\n🎉 全部跑通！" : "\n⚠ 未全通");
  bws.close(); ws.close();
  process.exit(all ? 0 : 1);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
