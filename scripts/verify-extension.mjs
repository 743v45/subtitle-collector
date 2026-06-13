#!/usr/bin/env node
/**
 * 字幕提取扩展 — 端到端验证脚本
 *
 * 用 Chrome for Testing + puppeteer `--load-extension` 加载扩展，
 * 配合 setRequestInterception mock 字幕响应，验证 inject.js 的完整拦截链路：
 *   player API → BILIBILI_SUBTITLE_META
 *   字幕内容 URL → BILIBILI_SUBTITLE_CONTENT
 *   字幕类型分析（AI 自动生成 / UP 主上传 CC / 多语言）
 *
 * 为什么 mock：未登录下 B 站 player API 的 subtitles 普遍为空（需登录态），
 * mock 可隔离验证扩展本身，不依赖真实字幕/登录。详见 MANUAL.md「决定性突破」。
 *
 * 运行前置：安装 puppeteer（自带 Chrome for Testing 下载）
 *   pnpm add -D puppeteer     # 或 npm i puppeteer
 *
 * 运行：
 *   node scripts/verify-extension.mjs [视频URL]
 */

import puppeteer from 'puppeteer';
import { readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..', 'apps', 'subtitle-extractor');
const VIDEO = process.argv[2] || 'https://www.bilibili.com/video/BV1qcEE6FEhn/';

// 定位 Chrome for Testing（puppeteer 安装时下载到 ~/.cache/puppeteer/chrome）
let exec = '';
try {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(cand)) exec = cand;
} catch { /* 找不到则让 puppeteer 用默认 */ }

const browser = await puppeteer.launch({
  ...(exec ? { executablePath: exec } : {}),
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
  ],
});
await sleep(3000);

const page = await browser.newPage();

// MAIN world 注入 message listener，捕获扩展广播的 BILIBILI_* postMessage
await page.evaluateOnNewDocument(() => {
  window.__bili_captured = [];
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && typeof e.data.type === 'string' && e.data.type.indexOf('BILIBILI_') === 0)
      window.__bili_captured.push(e.data);
  });
});

// mock 带 ID 标记的 player API 与字幕内容请求
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  const mockHeaders = { 'access-control-allow-origin': '*' };
  if (u.includes('MOCKPLAYER')) {
    req.respond({ status: 200, contentType: 'application/json; charset=utf-8', headers: mockHeaders, body: JSON.stringify({
      code: 0, data: { subtitle: { subtitles: [
        { lan: 'ai-zh', lan_doc: 'AI（简体中文）', type: 1, subtitle_url: '//aisubtitle.hdslb.com/MOCKSUB1.json' },
        { lan: 'en', lan_doc: '英语（机器翻译）', type: 1, subtitle_url: '//aisubtitle.hdslb.com/MOCKSUB2.json' },
        { lan: 'zh-Hans', lan_doc: '简体中文（UP上传）', type: 2, subtitle_url: '//i0.hdslb.com/bfs/subtitle/MOCKSUB3.json' },
      ] } } }) });
  } else if ((u.includes('aisubtitle') || u.includes('bfs/subtitle')) && u.includes('MOCKSUB')) {
    req.respond({ status: 200, contentType: 'application/json; charset=utf-8', headers: mockHeaders, body: JSON.stringify({
      body: [
        { from: 0.5, to: 2.0, content: '这是第一条模拟字幕', sid: 1 },
        { from: 2.0, to: 4.5, content: '证明 inject.js 拦截链路完整工作', sid: 2 },
        { from: 4.5, to: 7.0, content: '字幕已被扩展捕获并通过 postMessage 传出', sid: 3 },
      ] }) });
  } else {
    req.continue();
  }
});

await page.goto(VIDEO, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(10000);

// 1. inject.js 注入验证
const probe = await page.evaluate(() => ({
  fetchHook: String(window.fetch).includes('ORIGINAL_FETCH'),
  native: window.fetch.toString().includes('[native code]'),
  title: document.title.slice(0, 40),
}));
console.log('[1] inject.js 注入:', probe.fetchHook ? '✅ fetch 已 hook' : '❌ 未注入', `(${probe.title})`);
if (!probe.fetchHook) { console.error('   扩展未注入，终止'); await browser.close(); process.exit(1); }

// 2. mock player API → inject 拦截 → META
await page.evaluate(async () => { await fetch('https://api.bilibili.com/x/player/wbi/v2?aid=1&cid=1&z=MOCKPLAYER'); });
await sleep(800);
const hasMeta = await page.evaluate(() => window.__bili_captured.some(m => m.type === 'BILIBILI_SUBTITLE_META'));
console.log('[2] player API 拦截 + META:', hasMeta ? '✅' : '❌');

// 3. 从 META 取 subtitle_url，mock 字幕内容 → inject 拦截 → CONTENT
const fetched = await page.evaluate(async () => {
  const meta = window.__bili_captured.find(m => m.type === 'BILIBILI_SUBTITLE_META');
  if (!meta) return 0;
  for (const s of meta.data) {
    const u = s.subtitle_url.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url;
    await fetch(u);
  }
  return meta.data.length;
});
await sleep(1000);

// 4. 字幕类型分析报告
const report = await page.evaluate(() => {
  const cap = window.__bili_captured;
  const meta = cap.find(m => m.type === 'BILIBILI_SUBTITLE_META');
  const contents = cap.filter(m => m.type === 'BILIBILI_SUBTITLE_CONTENT');
  const analysis = (meta?.data || []).map(s => ({
    语言: s.lan_doc,
    类型: s.type === 1 ? 'AI自动生成' : s.type === 2 ? 'UP主上传(CC)' : '未知',
    代码: s.lan,
    内容已捕获: contents.some(c => c.data.url.includes(s.subtitle_url.split('/').pop().split('.')[0])),
  }));
  return { metaCount: meta?.data?.length || 0, contentCount: contents.length, analysis,
    样例: contents[0]?.data?.data?.body?.map(l => l.content) };
});
console.log('[3] 字幕内容拦截:', fetched ? '✅' : '❌', `(请求 ${fetched} 条，捕获 ${report.contentCount} 条内容)`);
console.log('\n=== 字幕类型分析 ===');
for (const a of report.analysis) console.log(`  - ${a.语言} | ${a.类型} | lan=${a.代码} | 内容=${a.内容已捕获 ? '✅' : '❌'}`);
console.log('内容样例:', JSON.stringify(report.样例));

await browser.close();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
