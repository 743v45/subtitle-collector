#!/usr/bin/env node
// web-screenshots.mjs — collector-web 全功能截图（UI 走查 / grill 评审用）
// 用法：node scripts/web-screenshots.mjs [--base http://localhost:21527] [--out <dir>]
// 输出：shot-<view>.png 落 --out 目录（默认仓库根，根目录 /*.png 已 gitignore 不入库）。
// 依赖：workspace 根 puppeteer；浏览器用本机 Chrome + 独立临时 user-data-dir，不碰 MCP/日常 profile。
// 鉴权：浏览器同源导航（Sec-Fetch-Site: same-origin）过 server 免鉴权通道；详情 ID 走 API 探测
//       （curl 侧用 Sec-Fetch-Site: none 模拟地址栏直达，见 collector-server http-util.ts 放行规则）。
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
function argOf(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const BASE = argOf('--base', 'http://localhost:21527');
const OUT = argOf('--out', '.');

const log = (...m) => console.log('[shot]', ...m);
const t0 = Date.now();
const ms = () => `(${Date.now() - t0}ms)`;

// ── API 探测：拿详情视图的真实 ID ──
async function probeApi(path) {
  const t = Date.now();
  const r = await fetch(`${BASE}${path}`, { headers: { 'Sec-Fetch-Site': 'none' } });
  if (!r.ok) {
    console.error(`[shot] [probe] FAIL ${path} → HTTP ${r.status} ${r.statusText}`);
    return null;
  }
  const j = await r.json();
  log(`[probe] ${path} → ok=${j.ok} total=${j.total ?? '-'} (${Date.now() - t}ms)`);
  return j;
}

const { default: puppeteer } = await import('puppeteer');

async function main() {
  mkdirSync(OUT, { recursive: true }); // 输出目录不存在则自建（ENOENT 在截图阶段才炸排障成本高）
  // 探测详情 ID（失败不致命：只少截两张详情图）
  const [vidRes, crRes] = await Promise.all([
    probeApi('/api/videos?limit=1'),
    probeApi('/api/creators?limit=1'),
  ]);
  const vid = vidRes?.items?.[0];
  const cr = crRes?.items?.[0];

  // 10 个 tab + 2 个详情视图（router.ts TABS 全覆盖）
  const views = [
    { name: 'collect', path: '/collect' },
    { name: 'history', path: '/history' },
    { name: 'videos', path: '/videos' },
    { name: 'stats', path: '/stats' },
    { name: 'creators', path: '/creators' },
    { name: 'categories', path: '/categories' },
    { name: 'tags', path: '/tags' },
    { name: 'clients', path: '/clients' },
    { name: 'changes', path: '/changes' },
    { name: 'settings', path: '/settings' },
  ];
  if (vid) views.push({ name: 'video-detail', path: `/videos/${vid.source}/${vid.source_vid}` });
  if (cr) views.push({ name: 'creator-detail', path: `/creators/${cr.id}` });

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: false, // puppeteer 自动建临时 profile，与 MCP/日常 Chrome 隔离
    args: ['--no-first-run', '--disable-extensions', '--window-size=1440,1000'],
    defaultViewport: { width: 1440, height: 1000 },
  });
  log(`[browser] launched headless Chrome (${ms()})`);

  const page = await browser.newPage();
  let consoleErrors = [];
  let apiFails = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/') && res.status() >= 400) apiFails.push(`${res.status()} ${u.replace(BASE, '')}`);
  });

  const results = [];
  for (const v of views) {
    const t = Date.now();
    consoleErrors = [];
    apiFails = [];
    const url = `${BASE}/#${v.path}`;
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise((r) => setTimeout(r, 800)); // 渲染/动画 settle
      const file = `${OUT}/shot-${v.name}.png`;
      await page.screenshot({ path: file });
      const warn = [...consoleErrors.map((e) => `console:${e}`), ...apiFails.map((e) => `api:${e}`)];
      log(`${v.name} url=${url} → ${file} (${Date.now() - t}ms)${warn.length ? ` ⚠ ${warn.slice(0, 3).join(' | ')}` : ''}`);
      results.push({ view: v.name, ok: true, warns: warn });
    } catch (err) {
      // 失败也要留现场：截当前状态 + 打 URL 与页面特征
      const file = `${OUT}/shot-${v.name}-FAILED.png`;
      try { await page.screenshot({ path: file }); } catch { /* 页面可能未就绪 */ }
      log(`[FAIL] ${v.name} url=${url} err=${String(err).slice(0, 200)} console=${consoleErrors.slice(0, 2).join(' | ')} (${Date.now() - t}ms)`);
      results.push({ view: v.name, ok: false, err: String(err) });
    }
  }

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  log(`done: ${results.length - bad.length}/${results.length} ok${bad.length ? `, failed: ${bad.map((b) => b.view).join(',')}` : ''} ${ms()}`);
  if (bad.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[shot] [FATAL]', err);
  process.exit(1);
});
