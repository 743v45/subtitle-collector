#!/usr/bin/env node
/**
 * 检查 puppeteer 加载的 unpacked 扩展到底有没有被 Chrome 接受。
 * 截图 chrome://extensions + dump targets（含 service worker），区分：
 *   - 扩展不在列表 → Chrome 拒绝加载（manifest 问题，影响用户浏览器）
 *   - 在列表但无 SW / 报错 → service worker 崩（background 问题）
 *   - 正常 → 仅真实 YouTube 页面行为问题
 */
import puppeteer from 'puppeteer';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const EXT = new URL('../apps/subtitle-collector/dist', import.meta.url).pathname;
function resolveChrome() {
  try {
    const base = join(homedir(), '.cache/puppeteer/chrome');
    if (existsSync(base)) {
      const ver = readdirSync(base).sort().pop();
      const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (existsSync(cand)) { console.log('chrome-for-testing 版本:', ver); return cand; }
    }
  } catch {}
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('EXT:', EXT);
const browser = await puppeteer.launch({
  headless: false,
  executablePath: resolveChrome(),
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
});
await sleep(3000);
console.log('targets:', browser.targets().map((t) => `${t.type()}=${t.url().slice(0, 60)}`));

const page = await browser.newPage();
await page.goto('chrome://extensions');
await sleep(1500);
// 开启开发者模式（右上角 toggle），否则 unpacked 扩展的"错误"按钮不显示
try {
  await page.evaluate(() => {
    const mgr = document.querySelector('extensions-manager');
    const toolbar = mgr?.shadowRoot?.querySelector('extensions-toolbar');
    const toggle = toolbar?.shadowRoot?.querySelector('#devMode');
    if (toggle && !toggle.checked) toggle.click();
  });
  await sleep(1500);
} catch (e) { console.log('toggle devmode err:', e.message); }

await page.screenshot({ path: '/tmp/chrome-extensions.png' });
console.log('screenshot → /tmp/chrome-extensions.png');

// 抓扩展卡片信息（穿透两层 shadow DOM）
const info = await page.evaluate(() => {
  const mgr = document.querySelector('extensions-manager');
  const list = mgr?.shadowRoot?.querySelector('extensions-item-list');
  const items = list?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
  const out = [];
  for (const it of items) {
    const sr = it.shadowRoot;
    out.push({
      name: sr?.querySelector('#name')?.textContent?.trim(),
      version: sr?.querySelector('#version')?.textContent?.trim(),
      id: it.id,
      enableToggle: sr?.querySelector('#enableToggle')?.checked,
      hasErrorsButton: !!sr?.querySelector('#errors-button'),
      errorText: sr?.querySelector('#errors-button')?.textContent?.trim(),
    });
  }
  return { count: items.length, items: out };
}).catch((e) => ({ err: e.message }));
console.log('扩展卡片:', JSON.stringify(info, null, 2));

await browser.close();
