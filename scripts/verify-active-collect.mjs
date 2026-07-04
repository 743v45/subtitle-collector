#!/usr/bin/env node
/**
 * 主动采集 P1 端到端回归（puppeteer mock，不依赖真实登录态）。
 * 覆盖：
 *   1. search action：mock WS server 下发 search → 扩展 fetch 搜索接口（puppeteer 拦截）→ 回执 {total, items}
 *   2. fetch-subtitle action：下发 → 扩展 fetch view+player+字幕体（拦截）→ ingest 上报 → 回执 {tracks, ingested}
 *
 * ⚠️ 风险点：扩展 fetch 在 service worker 内发起，puppeteer page.setRequestInterception
 *    主要拦当前 page。若 SW fetch 拦不到，回退：用 CDP browser-level Fetch domain，
 *    或先 navigate 打开一个 bilibili 页（让 SW 活跃）再测。实现时先验证拦截是否生效；
 *    若实在拦不到，标 DONE_WITH_CONCERNS，脚本留作后续手动/真实环境验证。
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..', 'apps', 'subtitle-collector', 'dist');
if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error(`[fatal] ${EXT}/manifest.json 不存在。请先 pnpm --filter @bilibili-ext/subtitle-collector build。`);
  process.exit(1);
}

const received = { ingests: [], results: [] };
const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer, path: '/ext' });
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.type === 'hello') ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
    else if (m.type === 'ingest') { received.ingests.push(m.payload); ws.send(JSON.stringify({ type: 'ingest-ack', ok: true })); }
    else if (m.type === 'result') received.results.push(m);
  });
});
await new Promise((r) => httpServer.listen(21527, '127.0.0.1', r));

// Chrome 定位（同 verify-collector.mjs）
let exec = '';
try {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(cand)) exec = cand;
} catch {}
if (!exec && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
  exec = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const browser = await puppeteer.launch({
  ...(exec ? { executablePath: exec } : {}),
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--window-size=1280,900'],
});
await new Promise((r) => setTimeout(r, 3000));
const page = await browser.newPage();

// mock B 站接口（nav / search / view / player / 字幕体）
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  const h = { 'access-control-allow-origin': '*' };
  if (u.includes('/x/web-interface/nav')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } }) });
  } else if (u.includes('/x/web-interface/wbi/search/type')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { page: { count: 1 }, result: [{ bvid: 'BVsearch', title: '搜索结果', author: 'up1', mid: 11, play: 5, duration: 60, pubdate: 1700000000 }] } }) });
  } else if (u.includes('/x/web-interface/view')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { bvid: 'BVcap', aid: 1, cid: 2, title: '采集目标', duration: 60, pubdate: 1700000000, owner: { mid: 99, name: 'up主', face: 'f' }, stat: { view: 1 } } }) });
  } else if (u.includes('/x/player/wbi/v2')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-Hans', lan_doc: '简体中文', type: 2, subtitle_url: '//aisubtitle.hdslb.com/cap.json' }] } } }) });
  } else if (u.includes('aisubtitle.hdslb.com/cap.json')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ body: [{ from: 0, to: 1, content: '采集字幕样例' }] }) });
  } else { req.continue(); }
});

// 让扩展 SW 活跃：先开一个 bilibili 页
await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2000));

// 1. search
for (const c of wss.clients) c.send(JSON.stringify({ id: 't-search', action: 'search', keyword: '测试', page: 1, order: 'pubdate' }));
await new Promise((r) => setTimeout(r, 3000));
const searchRes = received.results.find((r) => r.id === 't-search');
console.log('[search]', searchRes?.ok && searchRes.data?.items?.length === 1 ? '✅ 返回候选' : '❌', searchRes);

// 2. fetch-subtitle（有字幕）
for (const c of wss.clients) c.send(JSON.stringify({ id: 't-cap', action: 'fetch-subtitle', bvid: 'BVcap' }));
await new Promise((r) => setTimeout(r, 4000));
const capRes = received.results.find((r) => r.id === 't-cap');
const capIngest = received.ingests.find((p) => p.video?.source_vid === 'BVcap');
console.log('[fetch-subtitle]', capRes?.ok && capRes.data?.tracks === 1 ? '✅ 采到 1 轨' : '❌', capRes);
console.log('[fetch-subtitle ingest]', capIngest ? '✅ 入库上报' : '❌ 未上报 ingest');

await browser.close();
httpServer.close();
const ok = searchRes?.ok && capRes?.ok && capIngest;
process.exit(ok ? 0 : 1);
