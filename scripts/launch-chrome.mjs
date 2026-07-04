#!/usr/bin/env node
/**
 * 拉起一个可控的 Chrome 实例（9224），确保 subtitle-collector 扩展加载。
 * 复用 chrome-devtools-mcp 已登录 B 站的 profile（复制，不抢占原实例）。
 *
 * 用法：node scripts/launch-chrome.mjs
 * 前置：已在 9223 Chrome 登录过 B 站（cookie 在 ~/.cache/chrome-devtools-mcp/chrome-profile）。
 */
import puppeteer from "puppeteer";
import { existsSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EXT_DIR = new URL("../apps/subtitle-collector/dist", import.meta.url).pathname;
const SRC_PROFILE = "/Users/taevas/.cache/chrome-devtools-mcp/chrome-profile";
const DST_PROFILE = "/Users/taevas/.cache/bilibili-ext-test-profile";
const PORT = 9224;

// 动态解析 Chrome 二进制：puppeteer 默认按版本号找自带 chrome-for-testing，
// 缓存版本对不上（如自带要 131、本机只有 149）会抛 "Could not find Chrome"。
// 优先用最新的 chrome-for-testing，回退系统 Chrome，再回退 puppeteer 默认。
function resolveChrome() {
  try {
    const base = join(homedir(), ".cache/puppeteer/chrome");
    if (existsSync(base)) {
      const ver = readdirSync(base).sort().pop();
      const cand = join(base, ver, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (existsSync(cand)) return cand;
    }
  } catch {}
  const sys = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(sys)) return sys;
  return undefined;
}
const CHROME_BIN = resolveChrome();

// 复制已登录 profile（避免抢占 9223 实例；cookie 带 B 站登录态）
if (!existsSync(DST_PROFILE)) {
  console.log("[launch] 复制已登录 profile →", DST_PROFILE);
  cpSync(SRC_PROFILE, DST_PROFILE, { recursive: true });
} else {
  console.log("[launch] 复用已有 profile:", DST_PROFILE);
}

console.log("[launch] 启动 Chrome @9224，加载扩展:", EXT_DIR);
if (CHROME_BIN) console.log("[launch] Chrome 二进制:", CHROME_BIN);
const browser = await puppeteer.launch({
  headless: false,
  executablePath: CHROME_BIN, // 动态解析（chrome-for-testing → 系统 Chrome → 默认）
  userDataDir: DST_PROFILE,
  // 关键：去掉会破坏扩展加载的默认参数
  ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
  args: [
    `--remote-debugging-port=${PORT}`,
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    "--no-first-run",
    "--disable-default-apps",
  ],
});

console.log(`[launch] ✓ Chrome 已起，CDP: http://127.0.0.1:${PORT}`);
console.log("[launch] wsEndpoint:", browser.wsEndpoint());
console.log("");
console.log(">>> Chrome 窗口已打开。保持运行，另开终端跑验证脚本。");
console.log(">>> 退出：Ctrl+C 此进程，或 browser.close()");

// 保持进程不退出
import { setInterval as keepAlive } from "node:timers";
keepAlive(() => {}, 1 << 30);
