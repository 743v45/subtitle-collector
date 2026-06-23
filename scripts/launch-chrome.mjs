#!/usr/bin/env node
/**
 * 拉起一个可控的 Chrome 实例（9224），确保 subtitle-collector 扩展加载。
 * 复用 chrome-devtools-mcp 已登录 B 站的 profile（复制，不抢占原实例）。
 *
 * 用法：node scripts/launch-chrome.mjs
 * 前置：已在 9223 Chrome 登录过 B 站（cookie 在 ~/.cache/chrome-devtools-mcp/chrome-profile）。
 */
import puppeteer from "puppeteer";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";

const EXT_DIR = new URL("../apps/subtitle-collector", import.meta.url).pathname;
const SRC_PROFILE = "/Users/taevas/.cache/chrome-devtools-mcp/chrome-profile";
const DST_PROFILE = "/Users/taevas/.cache/bilibili-ext-test-profile";
const PORT = 9224;

// 复制已登录 profile（避免抢占 9223 实例；cookie 带 B 站登录态）
if (!existsSync(DST_PROFILE)) {
  console.log("[launch] 复制已登录 profile →", DST_PROFILE);
  cpSync(SRC_PROFILE, DST_PROFILE, { recursive: true });
} else {
  console.log("[launch] 复用已有 profile:", DST_PROFILE);
}

console.log("[launch] 启动 Chrome @9224，加载扩展:", EXT_DIR);
const browser = await puppeteer.launch({
  headless: false,
  executablePath: undefined, // 用 puppeteer 自带 chrome-for-testing
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
