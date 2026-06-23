#!/usr/bin/env node
/**
 * 端到端验证（跑通入库）：
 *   1. CDP 注入登录 cookie 到 9224 Chrome
 *   2. 页面内 fetch player/wbi/v2（同源，拿 subtitle_url + 视频元数据）
 *   3. Node 侧 fetch 字幕体（带 Referer，绕 CORS）—— 字幕 URL 带 auth_key，不依赖 cookie
 *   4. 组装 ingest payload（格式与扩展 content.js 产出一致）
 *   5. WS 模拟扩展握手（hello+token），上报 collector-server
 *   6. 验证 /api/videos 真入库
 *
 * 前置：9224 Chrome（已登录）+ collector-server 在 21527 + /tmp/bili-cookies.json。
 *
 * 注：扩展 content/SW 在 --load-extension 实例下注入不稳（MV3 上游问题），本脚本
 *    用 CDP+Node 复现扩展的数据采集逻辑，验证「字幕→入库」整条链路与 payload 格式正确。
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";

const CDP_HTTP = "http://127.0.0.1:9224";
const COOKIE_FILE = "/tmp/bili-cookies.json";
const SERVER_WS = "ws://127.0.0.1:21527/ext";
const SERVER_PING = "http://127.0.0.1:21527/ping";
const SERVER_API = "http://127.0.0.1:21527/api/videos";
const TOKEN = "change-me-collector-token";
const BV = process.argv[2] || "BV1mhjg6SEJy";
const VIDEO_URL = `https://www.bilibili.com/video/${BV}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const log = (...a) => console.log(`[e2e]`, ...a);
const warn = (...a) => console.warn(`[e2e]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkWs = (url) => new Promise((res, rej) => { const ws = new WebSocket(url); ws.on("open", () => res(ws)); ws.on("error", rej); });

async function main() {
  if (!(await fetch(SERVER_PING).then((r) => r.ok).catch(() => false))) { console.error("✗ server 没跑"); process.exit(1); }
  const cookies = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
  const before = await (await fetch(SERVER_API)).json();
  const beforeTotal = before.total ?? before.items?.length ?? 0;
  log(`服务端基线 total=${beforeTotal}`);

  // 1. 注入 cookie（browser-level CDP）
  log("1. 注入 cookie...");
  const ver = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  const bws = await mkWs(ver.webSocketDebuggerUrl);
  let bid = 0; const bpend = new Map();
  bws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id && bpend.has(m.id)) { bpend.get(m.id)(m); bpend.delete(m.id); } });
  const bsend = (method, params = {}) => new Promise((r) => { const i = ++bid; bpend.set(i, r); bws.send(JSON.stringify({ id: i, method, params })); });
  for (const c of cookies) {
    await bsend("Storage.setCookies", { cookies: [{ name: c.name, value: c.value, domain: c.domain, path: c.path || "/", expires: c.expires, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || "Lax" }] });
  }
  log(`  ✓ ${cookies.length} 条`);

  // 2. 开视频 tab
  log(`2. 开视频 ${BV}...`);
  let targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  for (const t of targets.filter((t) => t.type === "page" && t.url?.includes(`/video/`))) { try { await fetch(`${CDP_HTTP}/json/close/${t.id}`); } catch {} }
  const tab = await (await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(VIDEO_URL)}`, { method: "PUT" })).json();
  await sleep(7000);

  // 3. 页面内 fetch player API（同源，带 cookie，拿到字幕 URL + 元数据）
  log("3. 页面内取 player API...");
  const ws = await mkWs(tab.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  const probe = await send("Runtime.evaluate", {
    expression: `(async () => {
      const r = await fetch("https://api.bilibili.com/x/player/wbi/v2?aid=116757830374602&cid=39153305068", { credentials: "include" });
      const j = await r.json(); const d = j.data || {};
      return JSON.stringify({
        code: j.code, bvid: d.bvid, title: d.title,
        up_mid: d.up_info?.mid, up_name: d.up_info?.name,
        aid: d.aid, cid: d.cid, duration: d.video_info?.duration, pubdate: d.pubdate,
        need_login: d.need_login_subtitle,
        subs: (d.subtitle?.subtitles || []).map(s => ({ lan: s.lan, lan_doc: s.lan_doc, type: s.type, subtitle_url: s.subtitle_url })),
      });
    })()`,
    awaitPromise: true, returnByValue: true,
  });
  bws.close(); ws.close();
  const meta = JSON.parse(probe.result?.result?.value || "{}");
  log(`  code=${meta.code} bvid=${meta.bvid} need_login=${meta.need_login} subs=${meta.subs?.length}`);
  if (meta.need_login) { warn("  ✗ 仍需登录，cookie 失效？"); process.exit(1); }
  if (!meta.subs?.length) { warn("  ✗ 无字幕轨"); process.exit(1); }

  // 4. Node 侧 fetch 每个字幕体（带 Referer 绕 CORS；auth_key 自带签名）
  log("4. Node 取字幕体...");
  const tracks = [];
  for (const s of meta.subs) {
    const raw = s.subtitle_url || "";
    const full = raw.startsWith("//") ? "https:" + raw : raw;
    try {
      const r = await fetch(full, { headers: { "Referer": "https://www.bilibili.com/", "User-Agent": UA } });
      if (!r.ok) { warn(`  轨 ${s.lan}: HTTP ${r.status}，跳过`); continue; }
      const text = await r.text();
      let payload; try { payload = JSON.parse(text); } catch { payload = text; }
      tracks.push({ lan: s.lan, lan_doc: s.lan_doc, track_type: s.type ?? null, versions: [{ origin: "external", payload, source_url: full }] });
      log(`  轨 ${s.lan} (${s.lan_doc}): ✓ size=${text.length}`);
    } catch (e) { warn(`  轨 ${s.lan}: ${e.message}`); }
  }
  if (!tracks.length) { warn("✗ 无可用轨"); process.exit(1); }

  // 5. 组装 payload（与 content.js 产出格式一致）
  const payload = {
    source: "bilibili",
    video: {
      source_vid: meta.bvid, title: meta.title || BV,
      creator: { source_uid: String(meta.up_mid ?? "unknown"), name: meta.up_name },
      extra: { aid: meta.aid, cid: meta.cid },
      duration: meta.duration ?? null, published_at: meta.pubdate ? meta.pubdate * 1000 : null,
    },
    tracks,
  };
  log(`\n5. payload 就绪: ${tracks.length} 轨`);

  // 6. WS 模拟扩展握手 + 上报
  log("6. WS 上报...");
  const swws = await mkWs(SERVER_WS);
  const ackP = new Promise((res) => swws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "ingest-ack") res(m); }));
  swws.send(JSON.stringify({ type: "hello", ext_version: "0.1.0-cdp-probe", token: TOKEN }));
  await sleep(800);
  swws.send(JSON.stringify({ type: "ingest", payload }));
  const ack = await Promise.race([ackP, sleep(5000).then(() => null)]);
  log(`  ingest-ack: ${JSON.stringify(ack)}`);
  swws.close();
  if (!ack?.ok) { warn("✗ ingest-ack 失败"); process.exit(1); }
  log(`  inserted_tracks=${ack.inserted_tracks} skipped=${ack.skipped_tracks}`);

  // 7. 验证入库
  log("\n7. 验证入库...");
  await sleep(1000);
  const after = await (await fetch(SERVER_API)).json();
  const items = after.items || [];
  const total = after.total ?? items.length;
  log(`  total: ${beforeTotal} → ${total}`);
  if (total > beforeTotal) {
    log("\n🎉🎉🎉 入库成功！整条流程跑通！");
    const full = await (await fetch(SERVER_API)).json();
    for (const it of full.items || []) console.log("  " + JSON.stringify(it).slice(0, 700));
    process.exit(0);
  }
  warn("✗ 未入库（total 未增）");
  process.exit(1);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
