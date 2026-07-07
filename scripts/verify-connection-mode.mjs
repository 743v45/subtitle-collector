#!/usr/bin/env node
/**
 * 连接模式（server / 纯扩展）端到端（puppeteer mock）：
 *   1. 起 mock server（HTTP /ping + WS /ext，收 hello/ingest）
 *   2. 加载扩展，取 service worker target 的 extension id，打开 popup 页面
 *   3. 默认 server 模式：hello 到达；触发 mock player + 字幕体 → 收到 ingest
 *   4. 经 popup 发 SET_CONNECTION_MODE{mode:'standalone'} → 再触发同样 mock → 不应收到 ingest
 *   5. 经 popup 发 SET_CONNECTION_MODE{mode:'server'} → 触发 → 又收到 ingest（恢复）
 * 退出码 0=通过。需本机有 Chrome（headless:false 加载 MV3 扩展）。
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
  console.error(`[fatal] ${EXT}/manifest.json 不存在。请先在 apps/subtitle-collector 跑 pnpm build。`);
  process.exit(1);
}

const received = { ingests: [], hellos: [], openCount: 0, closeCount: 0 };
const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer, path: '/ext' });
wss.on('connection', (ws) => {
  received.openCount++;
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.type === 'hello') { received.hellos.push(m); ws.send(JSON.stringify({ type: 'hello-ack', ok: true })); }
    else if (m.type === 'ingest') { received.ingests.push(m.payload); ws.send(JSON.stringify({ type: 'ingest-ack', ok: true })); }
  });
  ws.on('close', () => { received.closeCount++; });
});
await new Promise((r) => httpServer.listen(21527, '127.0.0.1', r));

// Chrome 定位：优先 Chrome for Testing，回退系统 Chrome
let exec = '';
try {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(cand)) exec = cand;
} catch {}
if (!exec) { const c = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; if (existsSync(c)) exec = c; }

const browser = await puppeteer.launch({
  ...(exec ? { executablePath: exec } : {}),
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
});
await new Promise(r => setTimeout(r, 3000));

// 取 service worker target 的 extension id
const swTarget = browser.targets().find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
if (!swTarget) {
  console.error('[fatal] 未找到扩展 service worker target（扩展未加载或 SW 未启动）');
  await browser.close(); httpServer.close(); process.exit(1);
}
const extId = new URL(swTarget.url()).host;
console.log('[setup] extension id:', extId);

// popup 页面：用于 evaluate chrome.runtime.sendMessage（popup context 有 chrome.runtime）
const popupPage = await browser.newPage();
await popupPage.goto(`chrome-extension://${extId}/popup.html`);

const setMode = async (mode) => {
  await popupPage.evaluate((m) => new Promise((res) => {
    chrome.runtime.sendMessage({ type: 'SET_CONNECTION_MODE', mode: m }, () => res());
  }), mode);
  await new Promise(r => setTimeout(r, 1200)); // 等 WS close / connect 完成
};

// B 站视频页：mock player API + 字幕体，触发被动 INGEST
const biliPage = await browser.newPage();
await biliPage.setRequestInterception(true);
const mockPlayer = (vid) => JSON.stringify({ code: 0, data: { bvid: vid, aid: 1, cid: 2, title: vid, up_info: { mid: 11, name: 'up' }, subtitle: { subtitles: [{ lan: 'zh-Hans', lan_doc: '简', type: 2, subtitle_url: '//aisubtitle.hdslb.com/SUB.json' }] } } });
biliPage.on('request', (req) => {
  const u = req.url(); const h = { 'access-control-allow-origin': '*' };
  if (u.includes('/x/player/')) req.respond({ status: 200, contentType: 'application/json', headers: h, body: mockPlayer('BV' + Math.floor(Math.random() * 1e9)) });
  else if (u.includes('aisubtitle.hdslb.com/SUB')) req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ body: [{ from: 0, to: 1, content: '字幕' }] }) });
  else req.continue();
});
const triggerIngest = async () => {
  received.ingests.length = 0;
  await biliPage.goto('https://www.bilibili.com/video/CMTEST', { waitUntil: 'domcontentloaded' });
  await biliPage.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=CM'));
  await biliPage.evaluate(() => fetch('https://aisubtitle.hdslb.com/SUB.json'));
  await new Promise(r => setTimeout(r, 1500));
  return received.ingests.length;
};

// 1) 默认 server 模式：hello 到达 + ingest 正常
await new Promise(r => setTimeout(r, 500));
const helloBefore = received.hellos.length;
console.log('[1] server 模式 hello 到达:', helloBefore > 0, `(${helloBefore})`);
const n1 = await triggerIngest();
console.log('[2] server 模式 → ingest 数:', n1, n1 === 1 ? '✅' : '❌');

// 2) 切 standalone：丢弃上报
await setMode('standalone');
const n2 = await triggerIngest();
console.log('[3] standalone 模式 → ingest 数:', n2, n2 === 0 ? '✅' : '❌');

// 3) 切回 server：恢复上报
await setMode('server');
const helloAfter = received.hellos.length;
const n3 = await triggerIngest();
console.log('[4] server 恢复 → ingest 数:', n3, n3 === 1 ? '✅' : '❌');
console.log('    重连 hello 数:', helloAfter, helloAfter > helloBefore ? '✅ 重新握手' : '⚠ 未观察到新 hello');

const ok = helloBefore > 0 && n1 === 1 && n2 === 0 && n3 === 1;
console.log('\n结果:', ok ? '✅ 连接模式切换端到端通过' : '❌ 失败');
await browser.close(); httpServer.close();
process.exit(ok ? 0 : 1);
