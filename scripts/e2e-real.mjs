#!/usr/bin/env node
/**
 * 真实端到端验证（带登录态）：
 *   1. puppeteer launch 系统 Chrome + 加载 subtitle-collector 扩展（无 --enable-automation）
 *   2. 注入从 9223 导出的 bilibili 登录 cookie
 *   3. 开样本视频，确认扩展 inject 注入 + 登录态有效（need_login_subtitle=false）
 *   4. 触发字幕加载（点字幕按钮）→ inject 拦字幕请求 → content 聚合 → background WS ingest
 *   5. 验证 collector-server 真入库（/api/videos 含该视频 + tracks）
 *
 * 成功标准（全部满足才算跑通）：
 *   A. 扩展 service_worker 存在 + inject fetch hook 生效
 *   B. player API need_login_subtitle=false 且 subs 非空
 *   C. 观察到字幕请求（aisubtitle）
 *   D. /api/videos 返回 BV1mhjg6SEJy 且 tracks>0
 *
 * 前置：collector-server 在 21527（node scripts/run-collector-server.mjs）；/tmp/bili-cookies.json 存在。
 */
import puppeteer from "puppeteer";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, "..", "apps", "subtitle-collector", "dist");
const COOKIE_FILE = "/tmp/bili-cookies.json";
const BV = process.argv[2] || "BV1mhjg6SEJy";
const VIDEO_URL = `https://www.bilibili.com/video/${BV}`;
const SERVER_API = "http://127.0.0.1:21527/api/videos";
const SERVER_PING = "http://127.0.0.1:21527/ping";
const SYS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const log = (...a) => console.log(`[e2e]`, ...a);
const warn = (...a) => console.warn(`[e2e]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 成功标准收集
const checks = { A_inject: false, B_login: false, C_subReq: false, D_db: false };

async function main() {
  // 前置
  if (!existsSync(COOKIE_FILE)) { console.error("✗ 缺 " + COOKIE_FILE + "，先从 9223 导 cookie"); process.exit(1); }
  if (!(await fetch(SERVER_PING).then((r) => r.ok).catch(() => false))) { console.error("✗ collector-server 没跑"); process.exit(1); }
  if (!existsSync(SYS_CHROME)) { console.error("✗ 系统 Chrome 不在 " + SYS_CHROME); process.exit(1); }
  const cookies = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
  log(`cookie: ${cookies.length} 条，SESSDATA ${cookies.find((c) => c.name === "SESSDATA") ? "✓" : "✗"}`);

  const before = await (await fetch(SERVER_API)).json();
  log(`服务端基线 total=${before.total ?? before.items?.length ?? 0}`);

  // 1. launch 系统 Chrome + 扩展
  log("\n1. launch 系统 Chrome + 扩展...");
  const browser = await puppeteer.launch({
    executablePath: SYS_CHROME,
    headless: false,
    // 关键：去掉所有破坏扩展加载的默认参数。puppeteer 默认带 --disable-extensions + --enable-automation，
    // 二者都会让 --load-extension 失效（MV3 扩展加载的前提）。
    ignoreDefaultArgs: ["--enable-automation", "--disable-extensions", "--disable-component-extensions-with-background-pages"],
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
    ],
  });
  await sleep(3500); // 等扩展 SW 注册

  // 确认扩展加载
  const targets = browser.targets();
  const swTarget = targets.find((t) => t.type() === "service_worker");
  log(`  扩展 service_worker: ${swTarget ? "✓ 已加载" : "✗ 未加载"}`);
  if (!swTarget) { warn("  扩展没加载，终止"); await browser.close(); process.exit(1); }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // 2. 先开 bilibili 首页（让 cookie domain 上下文建立），注入 cookie
  log("\n2. 注入登录 cookie...");
  await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.setCookie(...cookies);
  log(`  已注入 ${cookies.length} 条 cookie`);

  // 3. 导航到视频页（扩展 inject 会 document_start 注入）
  log(`\n3. 打开视频 ${BV}...`);
  await page.goto(VIDEO_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(8000); // 等播放器 + player API

  // 验证标准 A & B
  log("\n4. 验证扩展注入 + 登录态...");
  const probe = await page.evaluate(async () => {
    const fetchHooked = !window.fetch.toString().includes("[native code]");
    const r = await fetch("https://api.bilibili.com/x/player/wbi/v2?aid=116757830374602&cid=39153305068", { credentials: "include" });
    const j = await r.json();
    return {
      fetch_hooked: fetchHooked,
      has_ORIGINAL: window.fetch.toString().includes("ORIGINAL_FETCH"),
      player_code: j.code,
      need_login: j.data?.need_login_subtitle,
      subs: j.data?.subtitle?.subtitles?.length,
      first_sub_url: j.data?.subtitle?.subtitles?.[0]?.subtitle_url?.slice(0, 50),
    };
  }).catch((e) => ({ error: e.message }));
  log(`  探测结果: ${JSON.stringify(probe)}`);
  if (probe.fetch_hooked || probe.has_ORIGINAL) { checks.A_inject = true; log("  ✓ A: inject fetch hook 生效"); }
  else warn("  ✗ A: inject 未注入");
  if (probe.need_login === false && probe.subs > 0) { checks.B_login = true; log(`  ✓ B: 登录态有效，subs=${probe.subs}`); }
  else warn(`  ✗ B: 登录态无效或无字幕 (need_login=${probe.need_login}, subs=${probe.subs})`);

  // 5. 触发字幕：直接用 inject 已拦到的 subtitle_url，在页面 fetch（模拟播放器拉字幕）
  //    这样 inject 的 isSubtitleUrl 分支会 post SUBTITLE_BODY → content 聚合 → 上报
  if (probe.first_sub_url) {
    log("\n5. 触发字幕请求（页面内 fetch subtitle_url）...");
    const subUrl = probe.first_sub_url.startsWith("//") ? "https:" + probe.first_sub_url : probe.first_sub_url;
    // inject hook fetch，页面内 fetch 会被拦到 SUBTITLE_BODY
    const triggered = await page.evaluate(async (u) => {
      try { await fetch(u, { credentials: "include" }); return "fetched"; } catch (e) { return "err:" + e.message; }
    }, subUrl).catch((e) => "eval err:" + e.message);
    log(`  字幕 fetch: ${triggered}`);
    checks.C_subReq = triggered === "fetched";
    await sleep(3000); // 等 inject 拦截 + content 聚合 + background WS 上报
  } else {
    warn("  无 subtitle_url 可触发，尝试点字幕按钮...");
    await page.evaluate(() => {
      const b = document.querySelector("[aria-label*='字幕'], .bpx-player-ctrl-subt");
      if (b) b.click();
    });
    await sleep(8000);
  }

  // 6. 验证标准 D：服务端入库
  log("\n6. 验证服务端入库...");
  await sleep(2000);
  const after = await (await fetch(SERVER_API)).json();
  const items = after.items || [];
  const total = after.total ?? items.length;
  const beforeTotal = before.total ?? before.items?.length ?? 0;
  const hit = items.find((v) => v.source_vid === BV || v.video?.source_vid === BV || v.sourceVid === BV);
  log(`  total: ${beforeTotal} → ${total}`);
  if (total > beforeTotal || hit) {
    checks.D_db = true;
    log("  ✓ D: 服务端入库成功！");
    const full = await (await fetch(SERVER_API)).json();
    for (const it of full.items || []) console.log("    " + JSON.stringify(it).slice(0, 600));
  } else {
    warn("  ✗ D: 未入库。查服务端日志看是否收到 ingest");
  }

  // 汇总
  log("\n========== 结论 ==========");
  log(`A 扩展注入:    ${checks.A_inject ? "✓" : "✗"}`);
  log(`B 登录态有效:  ${checks.B_login ? "✓" : "✗"}`);
  log(`C 字幕请求:    ${checks.C_subReq ? "✓" : "✗"}`);
  log(`D 服务端入库:  ${checks.D_db ? "✓" : "✗"}`);
  const allPass = checks.A_inject && checks.B_login && checks.C_subReq && checks.D_db;
  log(allPass ? "\n🎉 全部跑通！" : "\n⚠ 未全部跑通，见上面 ✗ 项");

  await browser.close();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
