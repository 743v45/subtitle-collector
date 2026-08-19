#!/usr/bin/env node
/**
 * YouTube 字幕采集诊断（回答"播放器有字幕、扩展拿不到" + "无法显示字幕是真没字幕吗"）。
 *
 * 每个视频抓四层证据：
 *   0. CC 按钮状态：点前 / 点后的 aria-label + pressed（判定"无法显示字幕"语义）
 *   1. captionTracks：inject 读到的轨数（真无字幕 vs 有轨不下发）
 *   2. Network timedtext 响应（CDP 全量，不依赖扩展 hook）：真实 body / pot
 *   3. page 内直接 fetch baseUrl + 模拟归一化：gemini json3 结构 vs 旧 segs/utf8
 *   4. 扩展 console 日志（[inject-yt]/[content-yt]）
 *
 * headed Chrome（非 HeadlessChrome）+ 复用已登录 profile，让 pot 指纹有效。
 *
 * 用法：node scripts/diagnose-yt-collect.mjs [videoId|url ...]   （默认跑两个已知视频）
 */
import puppeteer from 'puppeteer';
import { readdirSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const VIDEOS = args.length
  ? args.map((a) => (a.startsWith('http') ? a : `https://www.youtube.com/watch?v=${a}`))
  : ['https://www.youtube.com/watch?v=3MP8D-mdheA', 'https://www.youtube.com/watch?v=hDxst4Co2cE'];

const __dirname = new URL('.', import.meta.url).pathname;
const EXT = join(__dirname, '..', 'apps', 'subtitle-collector', 'dist');
if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error(`[fatal] ${EXT}/manifest.json 不存在。先 pnpm --filter subtitle-collector build`);
  process.exit(1);
}

const SRC_PROFILE = '/Users/taevas/.cache/chrome-devtools-mcp/chrome-profile';
const DST_PROFILE = '/Users/taevas/.cache/yt-diag-profile'; // 复制已初始化 profile：全新 profile 首启 first-run 会致扩展系统不激活 → --load-extension 失败
if (!existsSync(DST_PROFILE) && existsSync(SRC_PROFILE)) {
  console.log('[diag] 复制已初始化 profile →', DST_PROFILE);
  cpSync(SRC_PROFILE, DST_PROFILE, { recursive: true });
} else if (existsSync(DST_PROFILE)) {
  console.log('[diag] 复用 profile:', DST_PROFILE);
}

function resolveChrome() {
  // 优先 chrome-for-testing：系统 Chrome 若有 ExtensionLoadComponents / DeveloperToolsAvailability
  // 等企业策略会静默阻止 --load-extension（实测系统 Chrome 下 service_worker 不注册）。
  // pot 受限（timedtext 空 body）另行处理，不靠换 Chrome 二进制解决。
  try {
    const base = join(homedir(), '.cache/puppeteer/chrome');
    if (existsSync(base)) {
      const ver = readdirSync(base).sort().pop();
      const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (existsSync(cand)) return cand;
    }
  } catch {}
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(sys) ? sys : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const step = (n) => console.log(`[+${Date.now() - t0}ms] ${n}`);

step('启动 headed Chrome + 扩展（临时 profile，对齐 verify-youtube-collector.mjs；复制运行中 Chrome 的 profile 会带锁损坏→扩展不加载）');
const browser = await puppeteer.launch({
  headless: false,
  executablePath: resolveChrome(),
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
});

step('等 3s 让 MV3 扩展注册（content_scripts 才能赶上 document_start 注入）');
await sleep(3000);
const sw = browser.targets().filter((t) => t.type() === 'service_worker').map((t) => t.url());
console.log('[ext-load] service_worker targets:', sw.length ? sw : '(无 → 扩展未加载，--load-extension 失败)');

const page = await browser.newPage();
let extLogs = [];
page.on('console', (m) => { const t = m.text(); if (/inject-yt|content-yt|\[background|\[collector/.test(t)) extLogs.push(t); });
page.on('pageerror', (err) => console.log('[pageerror]', String(err?.message ?? err).slice(0, 300)));

const btnState = () => {
  const b = document.querySelector('.ytp-subtitles-button');
  if (!b) return { missing: true };
  return {
    label: b.getAttribute('aria-label'),
    pressed: b.getAttribute('aria-pressed'),
    disabled: b.disabled || b.hasAttribute('disabled'),
  };
};

for (let i = 0; i < VIDEOS.length; i++) {
  const video = VIDEOS[i];
  const vid = video.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] ?? video;
  console.log('\n' + '='.repeat(70));
  console.log(`▶ 视频${i + 1}: ${vid}`);
  console.log('='.repeat(70));

  extLogs = [];
  let ttResp = [];
  const onResponse = async (resp) => {
    const u = resp.url();
    if (!u.includes('/api/timedtext')) return;
    const rec = { status: resp.status(), len: -1, head: '' };
    try { const body = await resp.text(); rec.len = body.length; rec.head = body.slice(0, 300); } catch (e) { rec.err = e.message; }
    try { const x = new URL(u); rec.lang = x.searchParams.get('lang'); rec.kind = x.searchParams.get('kind'); rec.tlang = x.searchParams.get('tlang'); rec.variant = x.searchParams.get('variant'); } catch {}
    ttResp.push(rec);
  };
  page.on('response', onResponse);

  step('导航 ' + video);
  try { await page.goto(video, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { console.log('  [goto]', e.message); }

  // 点前按钮状态 + captionTracks
  const before = await page.evaluate(() => ({
    btn: (() => { const b = document.querySelector('.ytp-subtitles-button'); return b ? { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') } : { missing: true }; })(),
    tracks: (window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).map((t) => ({ lang: t.languageCode, kind: t.kind ?? null })),
    title: window.ytInitialPlayerResponse?.videoDetails?.title,
  })).catch((e) => ({ err: e.message }));
  console.log('[点前] 按钮:', JSON.stringify(before?.btn), '| captionTracks:', before?.tracks?.length ?? '?', JSON.stringify(before?.tracks?.slice(0, 2)));
  console.log('       标题:', before?.title);

  step('等 5s：扩展读 captionTracks + 自动点 CC');
  await sleep(5000);

  // 手动兜底点一次 CC，确保触发 timedtext（不依赖扩展）
  await page.evaluate(() => { const b = document.querySelector('.ytp-subtitles-button'); if (b) b.click(); }).catch(() => {});
  await sleep(2000);

  const after = await page.evaluate(() => ({
    btn: (() => { const b = document.querySelector('.ytp-subtitles-button'); return b ? { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') } : { missing: true }; })(),
  })).catch((e) => ({ err: e.message }));
  console.log('[点后] 按钮:', JSON.stringify(after?.btn));

  step('page 内直接 fetch + 模拟归一化');
  const probe = await page.evaluate(async () => {
    const tracks = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const out = { fetchHooked: !window.fetch.toString().includes('[native code]'), tracks: tracks.length, results: [] };
    for (const t of tracks.slice(0, 3)) {
      const url = t.baseUrl.replace(/&amp;/g, '&') + (t.baseUrl.includes('fmt=') ? '' : '&fmt=json3');
      try {
        const r = await fetch(url);
        const text = await r.text();
        const rec = { lang: t.languageCode, kind: t.kind ?? null, status: r.status, len: text.length };
        if (text) {
          let obj; try { obj = JSON.parse(text); } catch { rec.nonJson = text.slice(0, 150); out.results.push(rec); continue; }
          const evs = obj?.events ?? [];
          rec.events = evs.length;
          if (evs[0]) { rec.keys = Object.keys(evs[0]); rec.event0 = JSON.stringify(evs[0]).slice(0, 500); }
          let n = 0;
          for (const ev of evs) if (Array.isArray(ev?.segs) && ev.segs.some((s) => s?.utf8)) n++;
          rec.cuesByOldSegsLogic = n;
          if (n === 0 && evs.length > 0) rec.flag = '⚠️ segs/utf8 逻辑 0 cue';
        }
        out.results.push(rec);
      } catch (e) { out.results.push({ lang: t.languageCode, err: e.message }); }
    }
    return out;
  }).catch((e) => ({ err: e.message }));
  console.log('[probe] ' + JSON.stringify(probe));

  step('收 timedtext Network 响应');
  await sleep(3000);
  console.log('[Network timedtext] 共 ' + ttResp.length + ' 条');
  for (const r of ttResp) {
    console.log(`  status=${r.status} len=${r.len} lang=${r.lang} kind=${r.kind} tlang=${r.tlang} variant=${r.variant}`);
    if (r.len > 0) console.log('    head:', r.head.replace(/\s+/g, ' ').slice(0, 200));
  }

  step('扩展日志');
  console.log(extLogs.length ? extLogs.join('\n') : '  (无 [inject-yt]/[content-yt] 日志)');

  page.off('response', onResponse);
}

console.log(`\n[done] 总耗时 ${Date.now() - t0}ms`);
await browser.close();
process.exit(0);
