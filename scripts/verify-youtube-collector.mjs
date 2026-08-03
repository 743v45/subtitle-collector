#!/usr/bin/env node
/**
 * subtitle-collector 扩展 — YouTube 字幕采集 puppeteer mock 回归（spec §9 Y8-Y10 端到端）。
 * 覆盖：
 *   1. inject-yt 注入：MAIN world document_start 轮询读 window.ytInitialPlayerResponse.captions.captionTracks
 *   2. inject-yt hook fetch/XHR 拦 /api/timedtext（被动路径，复用播放器签名 URL）
 *   3. content-yt 聚合 + 归一化（youtube-format.mjs JSON3 → cue）+ INGEST
 *   4. background FETCH_SUBTITLE 兜底（按 youtube 域名免 Referer）
 *   5. mock collector-server WS /ext 收 source='youtube' ingest，断言 tracks 非空 + cue 内容正确
 *
 * 抄 scripts/verify-collector.mjs 结构（headed puppeteer + --load-extension + mock WS server +
 * page.setRequestInterception），mock 内容换成 YouTube 场景。
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

// ---- YouTube mock 场景常量（spec §9 Y9）----
const VIDEO_ID = 'TESTVID0001'; // 11 位视频 ID（T-E-S-T-V-I-D-0-0-0-1 = 正好 11 字符，满足 [A-Za-z0-9_-]{11}；不合规会被 inject-yt 正则截断致 SPA 守卫误判）
const TIMEDTEXT_URL = `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&signature=SIG&key=yt8&c=WEB&fmt=json3`;
const TIMEDTEXT_ASR_URL = `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&kind=asr&signature=SIG2&key=yt8&c=WEB&fmt=json3`;
// json3 响应体（spec §5.3 cue 换算：from=tStartMs/1000, content=segs.utf8 join）
const JSON3_BODY = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello world' }] },
    { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: '字幕测试' }] },
  ],
});

// ---- mock collector-server（HTTP /ping + WS /ext，收扩展 ingest）----
const received = { ingests: [], results: [] };
const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer, path: '/ext' });
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; } // 扩展发非 JSON 不崩
    if (m.type === 'hello') ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
    else if (m.type === 'ingest') { received.ingests.push(m.payload); ws.send(JSON.stringify({ type: 'ingest-ack', ok: true, inserted_tracks: (m.payload?.tracks?.length ?? 0) })); }
    else if (m.type === 'result') received.results.push(m);
  });
});
wss.on('connection', () => { console.log('[mock-server] 扩展连接'); });
await new Promise((r) => httpServer.listen(21527, '127.0.0.1', r));

// ---- Chrome 定位：优先 Chrome for Testing，回退系统 Chrome（MV3 需 headed）----
let exec = '';
try {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(cand)) exec = cand;
} catch {}
if (!exec) {
  const sysChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(sysChrome)) exec = sysChrome;
}
const browser = await puppeteer.launch({
  ...(exec ? { executablePath: exec } : {}),
  headless: false, // headless 模式下 Chrome 不加载 MV3 扩展
  // 不能带 --enable-automation（puppeteer 默认会加），否则 --load-extension 失效。
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
});
await new Promise(r => setTimeout(r, 3000));
const page = await browser.newPage();
page.on('console', (msg) => { const t = msg.text(); if (/\[(content|inject|background|collector)/.test(t)) console.log('[ext-log]', t); });

// ---- 注入 window.ytInitialPlayerResponse（document_start 前，inject-yt 轮询即可读到）----
await page.evaluateOnNewDocument((vid, ttUrl, ttAsrUrl) => {
  window.ytInitialPlayerResponse = {
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: ttUrl, languageCode: 'en', kind: null, name: { simpleText: 'English' }, vssId: '.en', isTranslatable: true },
      { baseUrl: ttAsrUrl, languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto-generated)' }, vssId: 'a.en', isTranslatable: false },
    ] } },
    videoDetails: { videoId: vid, title: '测试视频', channelId: 'UC_TEST', author: '测试频道', lengthSeconds: '120' },
  };
}, VIDEO_ID, TIMEDTEXT_URL, TIMEDTEXT_ASR_URL);

// ---- mock：youtube.com/watch 主文档返回含 ytInitialPlayerResponse 的 mock HTML
//      （不访问真实 YouTube，避免其页面脚本覆盖 mock 全局变量致 captions 丢失）；
//      /api/timedtext 返回 json3；其余请求 continue ----
const YT_WATCH_HTML = `<!DOCTYPE html><html><head><script>window.ytInitialPlayerResponse = ${JSON.stringify({
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { baseUrl: TIMEDTEXT_URL, languageCode: 'en', kind: null, name: { simpleText: 'English' }, vssId: '.en', isTranslatable: true },
    { baseUrl: TIMEDTEXT_ASR_URL, languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto-generated)' }, vssId: 'a.en', isTranslatable: false },
  ] } },
  videoDetails: { videoId: VIDEO_ID, title: '测试视频', channelId: 'UC_TEST', author: '测试频道', lengthSeconds: '120' },
})};</script></head><body>mock youtube watch page</body></html>`;
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('/api/timedtext')) {
    req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON3_BODY });
  } else if (req.isNavigationRequest() && u.includes('youtube.com/watch')) {
    req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: YT_WATCH_HTML });
  } else {
    req.continue();
  }
});

// 打开 YouTube 视频页 → inject-yt 轮询读到 captionTracks → content-yt 发 FETCH_SUBTITLE 兜底
await page.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`, { waitUntil: 'domcontentloaded' });

// 等 inject-yt 轮询发完 CAPTION_TRACKS（document_start 后 ~500ms 读到 captions），
// 否则被动 TIMEDTEXT_BODY 早于 CAPTION_TRACKS 到达会被 content-yt 丢弃（content-yt.js:38 守卫）。
await new Promise(r => setTimeout(r, 2500));
// 被动路径：手动触发 timedtext fetch，让 inject-yt 的 fetch hook 拦到（setRequestInterception 喂 json3）。
// FETCH_SUBTITLE 走 background SW fetch 不被 page 拦截，故主动触发页内 fetch 覆盖被动路径。
await page.evaluate(async (urls) => {
  for (const u of urls) {
    try { await fetch(u); } catch {} // 拦截器已 respond，不抛；容错防御
  }
}, [TIMEDTEXT_URL, TIMEDTEXT_ASR_URL]);

// 给扩展时间：聚合 + 归一化 + INGEST + WS 上报（被动路径触发后留足时间）
await new Promise(r => setTimeout(r, 8000));

// ---- 断言（spec §9 Y9：source=youtube / source_vid / tracks / cue）----
const yt = received.ingests.filter(p => p?.source === 'youtube' && p?.video?.source_vid === VIDEO_ID);
const hasTrack = yt.some(p => Array.isArray(p?.tracks) && p.tracks.length >= 1);
const hasCue = yt.some(p => (p?.tracks ?? []).some(t => {
  const cues = t?.versions?.[0]?.payload?.body; // payload 保留 {body:[...]} 外层（与 B 站一致）
  return Array.isArray(cues) && cues.some(c => typeof c?.content === 'string' && (c.content.includes('Hello world') || c.content.includes('字幕测试')));
}));

// 诊断：inject-yt fetch hook 是否生效 + 首个 youtube ingest 内容
const diag = await page.evaluate(() => ({
  fetch_native: window.fetch.toString().includes('[native code]'),
  fetch_src: window.fetch.toString().slice(0, 80),
  ytpr_present: !!window.ytInitialPlayerResponse,
  has_captions: !!(window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length),
  video_id: window.ytInitialPlayerResponse?.videoDetails?.videoId,
  href: location.href,
})).catch((e) => ({ err: e.message }));
console.log('[diag] fetch hook 状态:', JSON.stringify(diag));
console.log('[diag] 收到 ingest 总数:', received.ingests.length, '| youtube ingest 数:', yt.length);
console.log('[diag] 首个 youtube ingest:', JSON.stringify(yt[0])?.slice(0, 600));

const ok = yt.length >= 1 && hasTrack && hasCue;
console.log('\n[端到端]', ok ? '✅ source=youtube / source_vid / tracks / cue 全通过' : '❌ YouTube 采集链路异常');
console.log('  hasTrack:', hasTrack, '| hasCue:', hasCue);

await browser.close();
httpServer.close();
process.exit(ok ? 0 : 1);
