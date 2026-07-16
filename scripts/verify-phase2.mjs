#!/usr/bin/env node
/**
 * Phase 2 端到端:打开真实 B站视频页 → inject 拦 player API 取 dash.audio → bg 免 CORS fetch m4s
 *   → offscreen decode + transcribe → RESULT。
 * 验证:音轨 URL 提取 + m4s 免 CORS fetch + m4s(fMP4) 能否被 decodeAudioData(最大风险) + 出文本。
 * 用法:node verify-phase2.mjs <BV|完整URL>(默认一个公开视频,可能失效;建议传一个已知可用的)
 * 需:本机 Chrome + 联网 + B站视频页可访问 + 自动提取开关(脚本自动 SET_EXTRACT true)。
 */
import puppeteer from 'puppeteer';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..', 'apps', 'subtitle-extractor', 'dist');
if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error(`[fatal] ${EXT}/manifest.json 不存在。请先 pnpm --filter @bilibili-ext/subtitle-extractor build。`);
  process.exit(1);
}

const arg = process.argv[2] || 'BV1GJ411x7h7'; // 默认占位,建议传已知可用的 BV
const VIDEO_URL = arg.startsWith('http')
  ? arg
  : `https://www.bilibili.com/video/${arg}`;

let exec = '';
try {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(cand)) exec = cand;
} catch {}
if (!exec) exec = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: exec,
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
});
await new Promise((r) => setTimeout(r, 3000));

const errors = [];
const attach = async (target) => {
  try {
    const p = await target.page();
    if (p) {
      p.on('console', (m) => { if (m.type() === 'error') errors.push(`[${target.url().slice(-25)}] ${m.text().slice(0, 200)}`); });
    }
  } catch {}
};
for (const t of browser.targets()) await attach(t);
browser.on('targetcreated', attach);

const swTarget = browser.targets().find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
if (!swTarget) {
  console.error('[fatal] 未找到扩展 SW');
  await browser.close();
  process.exit(1);
}
const extId = new URL(swTarget.url()).host;
console.log('[setup] extId:', extId, '| 视频:', VIDEO_URL);

// popup 开着注入监听(自动提取时 popup 本来没开,这里开着用来收 offscreen 广播的 RESULT/ERROR)
const popupPage = await browser.newPage();
await popupPage.goto(`chrome-extension://${extId}/popup.html`);
await popupPage.evaluate(() => {
  window.__vc = { result: null, error: null, progress: '', fetchAudio: '' };
  chrome.runtime.onMessage.addListener((m) => {
    if (!m?.type) return;
    if (m.type === 'RESULT') window.__vc.result = m.text || '(空)';
    else if (m.type === 'ERROR') window.__vc.error = m.message;
    else if (m.type === 'PROGRESS') window.__vc.progress = `${m.phase} ${Math.round((m.ratio || 0) * 100)}% ${m.message || ''}`;
  });
});

// 开自动提取开关 + 等 storage 生效
await popupPage.evaluate(() => new Promise((res) => {
  chrome.runtime.sendMessage({ type: 'SET_EXTRACT', enabled: true }, () => res());
}));
await new Promise((r) => setTimeout(r, 800));
console.log('[step] 自动提取已开启,打开 B站视频页…');

// 打开 B站视频页,等播放器加载 + 发 player API(被 inject 拦)
const biliPage = await browser.newPage();
// 显式 attach biliPage,捕获 inject(MAIN world)/ content 的 console.log + error
biliPage.on('console', (m) => {
  const t = m.text();
  if (t.includes('[inject]') || t.includes('[content]') || m.type() === 'error') {
    console.log(`[bili ${m.type()}] ${t.slice(0, 220)}`);
  }
});
try {
  await biliPage.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (e) {
  console.error('[fatal] 打开 B站页失败:', e.message);
  await browser.close();
  process.exit(1);
}

// 等 inject 拦 player API + content FETCH_AUDIO + bg fetch + offscreen transcribe(超时 200s,含模型 decode)
const deadline = Date.now() + 200000;
let resultText = '';
let errMsg = '';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2500));
  const vc = await popupPage.evaluate(() => window.__vc);
  if (vc.result) { resultText = vc.result; break; }
  if (vc.error) { errMsg = vc.error; break; }
  process.stdout.write(`\r[wait] ${vc.progress || '等 inject 取音轨 / bg fetch / offscreen 转写…'}                    `);
}
console.log('');

if (resultText) {
  console.log('[result] 转写文本(前 200 字):', JSON.stringify(resultText.slice(0, 200)));
  console.log('\n✅ Phase 2 端到端通过:B站音轨提取 + m4s fetch + decode + 转写 全链路通');
  await browser.close();
  process.exit(0);
} else {
  console.error('[result] ❌ Phase 2 失败:', errMsg || '超时(可能:视频无 dash.audio / 未登录限流 / m4s decode 失败 / 开关未生效)');
  if (errors.length) console.error('[console errors(后15)]\n' + errors.slice(-15).join('\n'));
  await browser.close();
  process.exit(1);
}
