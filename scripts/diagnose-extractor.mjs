#!/usr/bin/env node
/**
 * subtitle-extractor 诊断脚本:CDP 抓 SW + offscreen 的 exception,直接发 TRANSCRIBE_FILE 看 resp。
 * 定位 Phase 1 回归(链路在 bg↔offscreen 间断)。
 */
import puppeteer from 'puppeteer';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..', 'apps', 'subtitle-extractor', 'dist');
const BEER = join(homedir(), 'Desktop', '我要一瓶beer.mp3');

let exec = '';
try {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(cand)) exec = cand;
} catch {}
if (!exec) exec = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: exec,
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
});
await new Promise((r) => setTimeout(r, 3000));

// CDP attach 任意 target,抓 console + exception
async function hook(target, tag) {
  try {
    const cdp = await target.createCDPSession();
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.exceptionThrown', (e) => {
      const ex = e.exceptionDetails;
      console.log(`[${tag} exception]`, ex?.text || ex?.exception?.description?.slice(0, 300) || JSON.stringify(ex).slice(0, 300));
    });
    cdp.on('Runtime.consoleAPICalled', (e) => {
      if (e.type === 'error') console.log(`[${tag} console.error]`, e.args?.map((a) => a.value || a.description?.slice(0, 200)).join(' '));
    });
    console.log(`[hook] ${tag} attached: ${target.url().slice(-50)}`);
  } catch (err) {
    console.log(`[hook] ${tag} 失败:`, err.message);
  }
}

const tagFor = (t) =>
  t.url().includes('offscreen') ? 'OFFSCREEN' : t.type() === 'service_worker' ? 'SW' : t.type();
const isExt = (t) => t.url().startsWith('chrome-extension://');
for (const t of browser.targets()) if (isExt(t)) await hook(t, tagFor(t));
browser.on('targetcreated', async (t) => {
  console.log('[+target]', t.type(), t.url().slice(-45));
  if (isExt(t)) await hook(t, tagFor(t));
});

const swTarget = browser.targets().find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
const extId = new URL(swTarget.url()).host;
console.log('[extId]', extId);

const popupPage = await browser.newPage();
await popupPage.goto(`chrome-extension://${extId}/popup.html`);
await new Promise((r) => setTimeout(r, 1000));

// 直接发 TRANSCRIBE_FILE(绕过 click),用 base64 beer dataUrl
const beer = readFileSync(BEER);
const dataUrl = 'data:audio/mpeg;base64,' + beer.toString('base64');
console.log('[step] 发 TRANSCRIBE_FILE…');
const resp = await popupPage.evaluate((d) => new Promise((res) => {
  chrome.runtime.sendMessage({ type: 'TRANSCRIBE_FILE', id: 1, filename: 'beer.mp3', mime: 'audio/mpeg', dataUrl: d }, (r) => res({ r, lastError: chrome.runtime.lastError }));
}), dataUrl);
console.log('[TRANSCRIBE_FILE resp]', JSON.stringify(resp));

// 等 3s 让 offscreen 创建,主动 hook 它 + 二次触发看 offscreen 是否处理消息
await new Promise((r) => setTimeout(r, 3000));
const offscreen = browser.targets().find((t) => t.url().includes('offscreen'));
if (offscreen) {
  console.log('[step] 找到 offscreen,hook + 二次 TRANSCRIBE_FILE...');
  await hook(offscreen, 'OFFSCREEN');
  // popup 监听收到的所有消息类型
  await popupPage.evaluate(() => {
    window.__seen = [];
    chrome.runtime.onMessage.addListener((m) => window.__seen.push(m?.type));
  });
  await popupPage.evaluate((d) => new Promise((res) => {
    chrome.runtime.sendMessage({ type: 'TRANSCRIBE_FILE', id: 2, filename: 'beer.mp3', mime: 'audio/mpeg', dataUrl: d }, () => res());
  }), dataUrl);
  await new Promise((r) => setTimeout(r, 9000));
  const seen = await popupPage.evaluate(() => window.__seen);
  console.log('[popup 二次触发后收到的消息类型]', seen);
} else {
  console.log('[!] offscreen 未创建');
}
await new Promise((r) => setTimeout(r, 1000));
console.log('\n[targets]', browser.targets().map((t) => `${t.type()}@${t.url().slice(-30)}`).join('\n  '));
await browser.close();
process.exit(0);
