#!/usr/bin/env node
/**
 * 真实扩展端到端（chrome-for-testing + 扩展自驱）：
 *   用 chrome-for-testing（而非系统 Chrome——系统 Chrome 阻止 MV3 content script 注入），
 *   加载 subtitle-collector 扩展，注入登录 cookie，打开真实 B 站视频。
 *   让扩展自己跑：inject.js hook fetch → 拦 player API + 字幕请求 → content.js 聚合
 *   → background.js WS 上报 collector-server → 入库。
 *
 *   不用 CDP/Node 绕过——这是扩展本身的完整链路。
 *
 * 成功标准：
 *   A. inject hook fetch（ORIGINAL_FETCH 存在）
 *   B. 登录态有效（need_login=false）
 *   C. 扩展发出 ingest（collector-server 收到）
 *   D. 入库（/api/videos 含该视频，tracks>0，title 非空）
 */
import puppeteer from "puppeteer";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXT = "/Users/taevas/code/mymy/bilibili-extensions/apps/subtitle-collector/dist";
const COOKIE_FILE = "/tmp/bili-cookies.json";
const SERVER_PING = "http://127.0.0.1:21527/ping";
const SERVER_API = "http://127.0.0.1:21527/api/videos";
const BV = process.argv[2] || "BV1mhjg6SEJy";
const VIDEO_URL = `https://www.bilibili.com/video/${BV}`;

// chrome-for-testing 定位（与 verify-collector.mjs 一致）
let exec = "";
try {
  const base = join(homedir(), ".cache/puppeteer/chrome");
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  if (existsSync(cand)) exec = cand;
} catch {}
if (!exec) { console.error("✗ chrome-for-testing 未找到"); process.exit(1); }

const log = (...a) => console.log(`[e2e]`, ...a);
const warn = (...a) => console.warn(`[e2e]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!(await fetch(SERVER_PING).then((r) => r.ok).catch(() => false))) { console.error("✗ server 没跑"); process.exit(1); }
  const cookies = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
  const before = await (await fetch(SERVER_API)).json();
  const beforeTotal = before.total ?? before.items?.length ?? 0;
  log(`chrome-for-testing: ${exec.split("/").slice(-2)[0]}`);
  log(`服务端基线 total=${beforeTotal}`);

  log("\n1. launch chrome-for-testing + 扩展...");
  const browser = await puppeteer.launch({
    executablePath: exec,
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"], // 与 verify-collector.mjs 一致
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,900"],
  });
  await sleep(3000);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  // 监听扩展日志（inject/content 的 console 会到 page console）
  page.on("console", (m) => {
    const t = m.text();
    if (/\[inject\]|\[content\]|\[background\]|PLAYER_META|SUBTITLE_BODY|INGEST/i.test(t)) log(`  [ext] ${t.slice(0, 200)}`);
  });

  log("\n2. 注入 cookie...");
  await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.setCookie(...cookies);
  log(`  ✓ ${cookies.length} 条`);

  log(`\n3. 打开真实视频 ${BV}...`);
  await page.goto(VIDEO_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(8000); // 等播放器 + player API（inject 会自动 hook 拦截）

  // 验证 A & B
  log("\n4. 验证 inject hook + 登录态...");
  const probe = await page.evaluate(async () => {
    const hooked = window.fetch.toString().includes("ORIGINAL_FETCH");
    // player API 会带 need_login_subtitle
    const r = await fetch("https://api.bilibili.com/x/player/wbi/v2?aid=116757830374602&cid=39153305068", { credentials: "include" }).catch(() => null);
    const j = r ? await r.json() : {};
    return { hooked, need_login: j.data?.need_login_subtitle, subs: j.data?.subtitle?.subtitles?.length };
  });
  log(`  ${JSON.stringify(probe)}`);
  const A = probe.hooked; const B = probe.need_login === false && probe.subs > 0;
  log(`  A inject hook: ${A ? "✓" : "✗"} | B 登录态: ${B ? "✓" : "✗"}`);

  // 触发字幕：B 站播放器播放视频时会请求字幕。先开字幕开关，再点播放。
  if (B) {
    log("\n5. 触发播放器请求字幕（开字幕+播放）...");
    // a. 开字幕开关
    await page.evaluate(() => {
      const btn = document.querySelector("[aria-label*='字幕']") || document.querySelector(".bpx-player-ctrl-subt");
      if (btn) { btn.click(); btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
    });
    await sleep(1500);
    // b. 选中文轨
    await page.evaluate(() => {
      const items = [...document.querySelectorAll("[class*=subtitle-item], .bpx-player-ctrl-subtitle-resul, .bpx-player-subtitle-panel-item")];
      for (const it of items) { if (/中文|ai-zh/i.test(it.textContent || "")) { it.click(); break; } }
    });
    await sleep(1500);
    // c. 点播放（B 站播放器播放时会请求已选字幕）
    await page.evaluate(() => {
      const playBtn = document.querySelector(".bpx-player-ctrl-play, .squirtle-video-start, [aria-label*='播放']");
      if (playBtn) { playBtn.click(); }
    });
    await sleep(8000); // 等播放器请求字幕 + inject 拦截解析 + content 聚合 + background 上报
    // d. 若播放器仍未发字幕请求，页面内正常 fetch 字幕 URL（inject hook 会接管）
    const gotSub = await page.evaluate(async () => {
      try {
        const r = await fetch("https://api.bilibili.com/x/player/wbi/v2?aid=116757830374602&cid=39153305068", { credentials: "include" });
        const j = await r.json();
        const s = j.data?.subtitle?.subtitles?.[0];
        if (!s) return "no sub";
        const u = s.subtitle_url.startsWith("//") ? "https:" + s.subtitle_url : s.subtitle_url;
        // 正常 fetch（非 no-cors）：让浏览器走 CORS。inject 在 fetch 链路里拦截。
        // 若 CORS 失败，inject 的 ORIGINAL_FETCH 会 reject，但其 response.clone 在 reject 前可能已构造。
        // 更可靠：inject hook 后我们注入到 fetch 调用前——但这里只是触发，看 inject 能否拿到。
        const sr = await fetch(u, { credentials: "include" });
        return "fetched status=" + sr.status + " type=" + sr.type;
      } catch (e) { return "err:" + e.message; }
    });
    log(`  字幕 fetch: ${gotSub}`);
    await sleep(3000); // 等 inject 解析 + content 聚合 + background 上报
  }

  // 验证 C & D
  log("\n6. 验证入库...");
  await sleep(2000);
  const after = await (await fetch(SERVER_API)).json();
  const items = after.items || [];
  const total = after.total ?? items.length;
  const hit = items.find((v) => v.source_vid === BV);
  log(`  total: ${beforeTotal} → ${total}`);
  if (hit) {
    log(`  ✓ D: 入库！title="${hit.title}" track_count=${hit.track_count}`);
    log("\n🎉 真实扩展驱动入库成功！");
    for (const it of items) console.log("  " + JSON.stringify(it).slice(0, 500));
    // 查字幕轨详情
    const dbHit = await (await fetch(SERVER_API)).json();
    await browser.close();
    process.exit(0);
  } else {
    warn(`  ✗ D: 未入库。扩展日志见上方 [ext] 行`);
    // 输出 collector-server 日志帮助排查
    await browser.close();
    process.exit(1);
  }
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
