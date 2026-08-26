#!/usr/bin/env node
/**
 * 从本机日常 Chrome（已登录 B 站）提取 cookie，供 asr backfill 的 --cookie-file 用。
 *
 * 机制：最小快照 profile（Local State + sqlite3 backup API 一致性拷贝 Default/Cookies——日常
 * Chrome 正在运行也可安全拷）→ spawn 系统 Chrome（--remote-debugging-port）→ CDP
 * Network.getCookies 取 .bilibili.com 域（含 HttpOnly 的 SESSDATA——document.cookie 拿不到，
 * CDP 可以；解密用同 app 的 Keychain 条目，免弹窗）→ 写文件（600）→ 关闭。
 * 不碰 Keychain 之外的东西、不动日常 Chrome。
 *
 * 历史：曾照 launch-chrome.mjs 复制 chrome-devtools-mcp profile，实测该 Chrome 未登录 B 站
 * （2026-08-26 核对：无 SESSDATA），登录态在日常 Chrome —— 改为日常 Chrome 最小快照。
 *
 * 用法：node scripts/bili-cookie-from-chrome.mjs [输出路径]
 *       node scripts/bili-cookie-from-chrome.mjs --refresh   # 重拷 Cookies（日常 Chrome 重新登录过时）
 * 默认输出：~/Local/collector-secrets/bili-cookie.txt
 * 时效：SESSDATA 有效期约 1 个月；nav 返回 -101 时重跑本脚本（--refresh）即可。
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const DAILY = join(homedir(), "Library/Application Support/Google/Chrome");
const SRC_COOKIES = join(DAILY, "Default", "Cookies");
const SRC_LOCAL_STATE = join(DAILY, "Local State");
const SRC_PREFS = join(DAILY, "Default", "Preferences");
const DST_PROFILE = "/Users/taevas/.cache/bilibili-cookie-snapshot-profile";
const SYS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9237;
const DEFAULT_OUT = join(homedir(), "Local/collector-secrets/bili-cookie.txt");

const refresh = process.argv.includes("--refresh");
// 位置参数从 argv.slice(2) 取（曾误用 argv.find 命中 argv[0] 的 node 路径，把输出写上了 node 二进制）
const outPath = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? DEFAULT_OUT;

const log = (msg) => process.stderr.write(`[bili-cookie] ${msg}\n`);

if (!existsSync(SYS_CHROME)) { log(`✗ 系统 Chrome 不存在：${SYS_CHROME}`); process.exit(1); }
if (!existsSync(SRC_COOKIES)) { log(`✗ 日常 Chrome Cookies 不存在：${SRC_COOKIES}`); process.exit(1); }

// 最小快照 profile：日常 Chrome 运行中 → Cookies 用 sqlite3 backup API（一致性活拷），
// Local State 带 os_crypt 加密 key（同 app 的 Keychain 条目，复制后新实例可解密）
if (refresh && existsSync(DST_PROFILE)) rmSync(DST_PROFILE, { recursive: true, force: true });
mkdirSync(join(DST_PROFILE, "Default"), { recursive: true });
cpSync(SRC_LOCAL_STATE, join(DST_PROFILE, "Local State"));
if (existsSync(SRC_PREFS)) cpSync(SRC_PREFS, join(DST_PROFILE, "Default", "Preferences"));
log(`backup API 拷 Cookies（日常 Chrome 运行中安全）→ ${DST_PROFILE}`);
execFileSync("sqlite3", [
  "-readonly", `file://${SRC_COOKIES}?mode=ro`,
  `.backup '${join(DST_PROFILE, "Default", "Cookies")}'`,
]);
for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
  rmSync(join(DST_PROFILE, lock), { force: true });
}

// spawn Chrome 直起（带调试口），轮询 /json/version 就绪
log(`spawn Chrome @${DEBUG_PORT}（最小快照 profile，窗口数秒自动关）…`);
const chrome = spawn(SYS_CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${DST_PROFILE}`,
  "--no-first-run", "--disable-default-apps", "--no-default-browser-check",
], { stdio: ["ignore", "ignore", "ignore"] });

async function waitReady(deadlineMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return await r.json();
    } catch { /* 未就绪，继续轮询 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome ${DEBUG_PORT} 未就绪（15s）`);
}

try {
  const ver = await waitReady();
  log(`Chrome 就绪：${ver.Browser}`);

  // puppeteer 仅用 connect（launch 的 attach 流程实测崩 Target closed，绕开）
  const puppeteer = (await import("puppeteer")).default;
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` });
  try {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    const { cookies } = await cdp.send("Network.getCookies", {
      urls: ["https://www.bilibili.com/", "https://api.bilibili.com/"],
    });
    const bili = cookies.filter((c) => c.domain.endsWith("bilibili.com"));
    const names = bili.map((c) => c.name);
    const essentials = ["SESSDATA", "buvid3", "bili_jct"].filter((k) => names.includes(k));
    log(`取到 ${bili.length} 条 .bilibili.com cookie；关键项命中：${essentials.join(", ") || "（无——登录态缺失？）"}`);
    if (!names.includes("SESSDATA")) {
      log("✗ 无 SESSDATA：日常 Chrome 未登录 B 站？登录后 --refresh 重跑");
      process.exitCode = 1;
    } else {
      const cookieStr = bili.map((c) => `${c.name}=${c.value}`).join("; ");
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, cookieStr + "\n");
      chmodSync(outPath, 0o600);
      log(`✓ 已写 ${outPath}（${cookieStr.length} 字节，600）`);
      log(`  用法：COLLECTOR_BILI_COOKIE_FILE=${outPath} pnpm cli asr backfill --size 5`);
    }
    await page.close();
  } finally {
    browser.disconnect();
  }
} finally {
  chrome.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  chrome.kill("SIGKILL"); // 确保清场（残留进程会占住快照 profile）
}
