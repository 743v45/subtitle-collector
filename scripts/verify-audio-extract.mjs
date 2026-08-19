#!/usr/bin/env node
// 验收方案A（网页内拿音频）：启动 Chrome + subtitle-extractor 扩展，
// 对各类视频导航，观察 inject 是否取到 __playinfo__ + background 是否抓到 m4s。
// 412 风控退避：30s 不行等 2min，最多 5min（B 站游客态连测易触发 412）。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..', 'apps', 'subtitle-extractor', 'dist');
const CDP = 9238;
const TMP = join(__dirname, '..', '.audio-verify-profile');
const t0 = Date.now();
const el = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  { type: '普通视频', url: 'https://www.bilibili.com/video/BV1fX4y1G7Ue' },
  { type: '充电视频', url: 'https://www.bilibili.com/video/BV1FyVv6TE5o' },
  { type: '番剧', url: 'https://www.bilibili.com/bangumi/play/ep820764' },
];

function findChrome() {
  const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(app)) return app;
  try { const b = join(homedir(), '.cache/puppeteer/chrome'); const v = readdirSync(b).sort().pop();
    const c = join(b, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(c)) return c; } catch {}
  return app;
}
const proc = spawn(findChrome(), [`--remote-debugging-port=${CDP}`, `--user-data-dir=${TMP}`,
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const httpJson = async (u) => (await fetch(u)).json();

// 退避档：30s → 2min → 5min（封顶）。返回是否拿到 playinfo。
const BACKOFFS = [30000, 120000, 300000];

async function probe(url, label) {
  const targets = await httpJson(`http://127.0.0.1:${CDP}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, rej) => { ws.on('open', r); ws.on('error', rej); });
  const reqs = []; let id = 0; const pend = new Map(); let saw412 = false;
  ws.on('message', (b) => { const m = JSON.parse(b.toString());
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') { const u = m.params.request.url;
      if (u.includes('bilivideo.com') || u.includes('upos-sz') || u.includes('playurl')) reqs.push({ u, t: Date.now() - t0 }); }
    if (m.method === 'Network.responseReceived') { const u = m.params.response?.url || ''; const st = m.params.response?.status;
      if (st === 412 && (u.includes('playurl') || u.includes('player'))) saw412 = true; }
  });
  const send = (mm, pp = {}) => new Promise((r) => { id++; pend.set(id, r); ws.send(JSON.stringify({ id, method: mm, params: pp })); });
  await send('Network.enable');
  el(`\n=== ${label}: ${url} ===`);
  await send('Page.navigate', { url });

  const readPlayinfo = async () => {
    const ev = await send('Runtime.evaluate', { expression: `(function(){
      try {
        var pi = window.__playinfo__; if(!pi) return 'NO_PLAYINFO';
        var d = pi.data && pi.data.dash; if(!d) return 'NO_DASH:'+(pi.data?Object.keys(pi.data).slice(0,8).join(','):'null');
        var a0 = (d.audio||[])[0]||{};
        return 'OK|audio='+(d.audio?d.audio.length:0)+'|video='+(d.video?d.video.length:0)+'|dur='+d.duration+'|codec='+(a0.codecs||'?')+'|bw='+(a0.bandwidth||'?')+'|url=...'+(a0.baseUrl||'').slice(-28);
      } catch(e){ return 'ERR:'+e.message; }
    })()`, returnByValue: true });
    // CDP evaluate 返回结构是 {result:{result:{value}}}（send resolve 整个 message）
    return ev?.result?.result?.value ?? '(无返回)';
  };

  // 先等 8s（正常就绪），不行则按退避档重试
  await sleep(8000);
  let res = await readPlayinfo();
  let boIdx = 0;
  while (!res.startsWith('OK') && saw412 && boIdx < BACKOFFS.length) {
    const wait = BACKOFFS[boIdx++];
    el(`  ⏳ 检测到 412，退避 ${wait / 1000}s 后重试（档 ${boIdx}/${BACKOFFS.length}）…`);
    await sleep(wait);
    res = await readPlayinfo();
  }
  el(`  __playinfo__: ${res}`);
  const cdn = reqs.filter((r) => /bilivideo|upos/.test(r.u));
  el(`  playurl/CDN 请求 ${reqs.length} 条，音频 CDN ${cdn.length} 条${cdn[0] ? '（首: ...' + cdn[0].u.slice(-30) + '）' : ''}`);
  ws.close();
  return res;
}

try {
  let ver; for (let i = 0; i < 40; i++) { ver = await httpJson(`http://127.0.0.1:${CDP}/json/version`).catch(() => null); if (ver) break; await sleep(250); }
  if (!ver) throw new Error('CDP 未就绪');
  el(`Chrome ${ver.Browser} + subtitle-extractor 加载`);
  for (const c of CASES) { try { await probe(c.url, c.type); } catch (e) { el(`  ⚠ ${c.type} 探测失败: ${e.message}`); } }
  el(`\n=== 验收完成，总耗时 ${Math.round((Date.now() - t0) / 1000)}s ===`);
} catch (e) { console.error('失败:', e.message); }
finally { try { proc.kill(); } catch {}; process.exit(0); }
