#!/usr/bin/env node
/**
 * 上报开关端到端（puppeteer mock）：
 *   1. 起 mock server（HTTP /ping + WS /ext，收 hello/ingest/result / 发 set-reporting）
 *   2. 加载扩展，扩展 hello 带 client_id
 *   3. 触发一次 mock player API + 字幕体 → 应收到 ingest（开关默认开）
 *   4. 下发 set-reporting{enabled:false} → 再触发同样 mock → 不应收到 ingest
 *   5. 下发 set-reporting{enabled:true} → 再触发 → 又收到 ingest
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

const received = { ingests: [], hellos: [], results: [] };
const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer, path: '/ext' });
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.type === 'hello') { received.hellos.push(m); ws.send(JSON.stringify({ type: 'hello-ack', ok: true })); }
    else if (m.type === 'ingest') { received.ingests.push(m.payload); ws.send(JSON.stringify({ type: 'ingest-ack', ok: true })); }
    else if (m.type === 'result') { received.results.push(m); }
  });
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
const page = await browser.newPage();
await page.setRequestInterception(true);
const mockPlayer = (vid) => JSON.stringify({ code: 0, data: { bvid: vid, aid: 1, cid: 2, title: vid, up_info: { mid: 11, name: 'up' }, subtitle: { subtitles: [{ lan: 'zh-Hans', lan_doc: '简', type: 2, subtitle_url: '//aisubtitle.hdslb.com/SUB.json' }] } } });
page.on('request', (req) => {
  const u = req.url(); const h = { 'access-control-allow-origin': '*' };
  if (u.includes('/x/player/')) req.respond({ status: 200, contentType: 'application/json', headers: h, body: mockPlayer('BV' + Date.now()) });
  else if (u.includes('aisubtitle.hdslb.com/SUB')) req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ body: [{ from: 0, to: 1, content: '字幕' }] }) });
  else req.continue();
});

const sendCmd = (cmd) => { for (const c of wss.clients) c.send(JSON.stringify(cmd)); };
const triggerIngest = async () => {
  received.ingests.length = 0;
  await page.goto('https://www.bilibili.com/video/TOGGLE', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=TOGGLE'));
  await page.evaluate(() => fetch('https://aisubtitle.hdslb.com/SUB.json'));
  await new Promise(r => setTimeout(r, 1500));
  return received.ingests.length;
};

// 1) hello 带 client_id
await new Promise(r => setTimeout(r, 500));
console.log('[1] hello 含 client_id:', !!received.hellos[0]?.client_id, received.hellos[0]?.client_id);

// 2) 默认开 → 应收到 ingest
const n1 = await triggerIngest();
console.log('[2] 开关开 → ingest 数:', n1, n1 === 1 ? '✅' : '❌');

// 3) 下发关 → 不应收到 ingest
sendCmd({ id: 'cmd-off', action: 'set-reporting', enabled: false });
await new Promise(r => setTimeout(r, 500));
const n2 = await triggerIngest();
console.log('[3] 开关关 → ingest 数:', n2, n2 === 0 ? '✅' : '❌');
const offRes = received.results.find(r => r.id === 'cmd-off');
console.log('    set-reporting(off) 回执:', offRes?.ok, offRes?.data?.reporting_enabled);

// 4) 下发开 → 又收到 ingest
sendCmd({ id: 'cmd-on', action: 'set-reporting', enabled: true });
await new Promise(r => setTimeout(r, 500));
const n3 = await triggerIngest();
console.log('[4] 开关重开 → ingest 数:', n3, n3 === 1 ? '✅' : '❌');

const ok = received.hellos[0]?.client_id && n1 === 1 && n2 === 0 && n3 === 1;
console.log('\n结果:', ok ? '✅ 上报开关端到端通过' : '❌ 失败');
await browser.close(); httpServer.close();
process.exit(ok ? 0 : 1);
