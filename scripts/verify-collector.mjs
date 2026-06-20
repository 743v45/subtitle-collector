#!/usr/bin/env node
/**
 * subtitle-collector 扩展 — puppeteer mock 回归（不依赖真实登录态）。
 * 覆盖：
 *   1. inject.js 注入（fetch/XHR hook）
 *   2. PLAYER_META 抽取（bvid/aid/cid/title/up/subs[]）
 *   3. subtitle_url 四情况：正常 / 空数组(无字幕) / need_login_subtitle=true / code≠0 风控
 *   4. content.js 组装 → background WS ingest（mock WS server 收到上报）
 *   5. navigate 命令：broadcastCommand → 扩展 chrome.tabs.create
 *   6. operate 命令：mock 字幕按钮 DOM，验证点击后 content.js 回传 subtitleObserved 真实结果
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..', 'apps', 'subtitle-collector');

// ---- mock collector-server（HTTP /ping + WS /ext，收扩展 ingest / 发 navigate+operate） ----
const received = { ingests: [], results: [] };
const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer, path: '/ext' });
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; } // M1: 扩展发非 JSON 不崩
    if (m.type === 'hello') ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
    else if (m.type === 'ingest') { received.ingests.push(m.payload); ws.send(JSON.stringify({ type: 'ingest-ack', ok: true, inserted_tracks: (m.payload?.tracks?.length ?? 0) })); }
    else if (m.type === 'result') received.results.push(m);
  });
});
wss.on('connection', (ws) => { console.log('[mock-server] 扩展连接'); });
await new Promise((r) => httpServer.listen(21527, '127.0.0.1', r));

// ---- Chrome for Testing ----
let exec = '';
try {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(cand)) exec = cand;
} catch {}
const browser = await puppeteer.launch({
  ...(exec ? { executablePath: exec } : {}),
  headless: false, // plan 要求 false：headless 模式下 Chrome 不加载 MV3 扩展
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
});
await new Promise(r => setTimeout(r, 3000));
const page = await browser.newPage();

// ---- mock player API：四情况 ----
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  const h = { 'access-control-allow-origin': '*' };
  if (u.includes('CASE_NORMAL')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { bvid: 'BVnormal', aid: 1, cid: 2, title: '正常', up_info: { mid: 11, name: 'up1' }, subtitle: { subtitles: [{ lan: 'zh-Hans', lan_doc: '简体中文', type: 2, subtitle_url: '//aisubtitle.hdslb.com/SUB_NORMAL.json' }] } } }) });
  } else if (u.includes('CASE_EMPTY')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { bvid: 'BVempty', aid: 3, cid: 4, title: '无字幕', up_info: { mid: 12 }, subtitle: { subtitles: [] } } }) });
  } else if (u.includes('CASE_LOGIN')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { bvid: 'BVlogin', aid: 5, cid: 6, title: '需登录', need_login_subtitle: true, subtitle: { subtitles: [] } } }) });
  } else if (u.includes('CASE_RISK')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: -509, data: {} }) });
  } else if (u.includes('SUB_NORMAL')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ body: [{ from: 0, to: 1, content: '正常字幕样例' }] }) });
  } else { req.continue(); }
});

// 情况1：正常 → 应收到 ingest（含轨 + body）
await page.goto('https://www.bilibili.com/video/CASE_NORMAL', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=CASE_NORMAL'));
await page.evaluate(() => fetch('https://aisubtitle.hdslb.com/SUB_NORMAL.json'));
await new Promise(r => setTimeout(r, 1500));

// 情况2/3/4：空 / 需登录 / 风控 → 都不应产生 ingest
await page.goto('https://www.bilibili.com/video/CASE_EMPTY', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=CASE_EMPTY'));
await page.goto('https://www.bilibili.com/video/CASE_LOGIN', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=CASE_LOGIN'));
await page.goto('https://www.bilibili.com/video/CASE_RISK', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=CASE_RISK'));
await new Promise(r => setTimeout(r, 1500));

// 5. navigate 命令：服务端主动下发，扩展应 chrome.tabs.create
for (const c of wss.clients) c.send(JSON.stringify({ id: 'cmd-nav', action: 'navigate', url: 'https://www.bilibili.com/video/CASE_NORMAL' }));
await new Promise(r => setTimeout(r, 1500));
const navResult = received.results.find(r => r.id === 'cmd-nav');
console.log('[navigate]', navResult?.ok ? '✅ 扩展回 result ok' : '❌ 未收到 result');

// 6. operate 命令：注入 mock 字幕按钮到当前页，验证 content.js 回传 subtitleObserved 真实结果
await page.evaluate(() => {
  const btn = document.createElement('div');
  btn.className = 'bpx-player-ctrl-btn-icon';
  btn.id = 'mock-sub-toggle';
  btn.addEventListener('click', () => { /* 模拟点击后播放器会请求字幕 */ fetch('https://aisubtitle.hdslb.com/SUB_NORMAL.json'); });
  document.body.appendChild(btn);
});
for (const c of wss.clients) c.send(JSON.stringify({ id: 'cmd-op', action: 'operate', op: 'click-subtitle-toggle' }));
await new Promise(r => setTimeout(r, 12000)); // operate 最多等 5s+5s fallback
const opResult = received.results.find(r => r.id === 'cmd-op');
console.log('[operate]', opResult?.data?.subtitleObserved ? '✅ 点击触发了字幕请求' : '⚠️ 未观察到字幕请求（按 spike 结论决定是否 CDP 降级）');

// ---- 断言 ----
const ok = received.ingests.length === 1 && received.ingests[0]?.video?.source_vid === 'BVnormal';
console.log('\n[ingest 四情况]', ok ? '✅ 仅正常情况上报，其余三情况未上报' : '❌ subtitle_url 四情况处理异常');
console.log('  收到 ingest 数:', received.ingests.length, '| navigate:', !!navResult, '| operate:', !!opResult);

await browser.close();
httpServer.close();
process.exit(ok && navResult && opResult ? 0 : 1);
