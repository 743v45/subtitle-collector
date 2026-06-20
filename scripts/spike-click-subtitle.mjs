// 前置：Task 7 在根 package.json 装 puppeteer；用 --user-data-dir 复用已登录 B 站的 Chrome profile。
// 目的：在真实视频页 element.click() 字幕开关后，5s 内是否出现 aisubtitle/bfs/subtitle 请求。
// 一次性验证脚本，不入正式测试套件。
import puppeteer from 'puppeteer';

const VIDEO = process.argv[2] || 'https://www.bilibili.com/video/BV1mhjg6SEJy';
const PROFILE = process.env.CHROME_PROFILE || `${process.env.HOME}/.spike-bilibili-profile`;

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: PROFILE, // 复用登录态；首次跑需手动登录一次
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
});
const page = await browser.newPage();
let observed = false;
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('aisubtitle') || u.includes('bfs/subtitle') || u.includes('bfs/ai_subtitle')) observed = true;
});

await page.goto(VIDEO, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000)); // 等播放器就绪

// 方案 A：直接 click()
async function tryClick(strategy) {
  observed = false;
  const handle = await page.$(".bpx-player-ctrl-btn-icon, [aria-label*='字幕'], .subtitle-btn");
  if (!handle) return { found: false, observed: false, strategy };
  if (strategy === 'click') {
    await handle.click();
  } else {
    await handle.evaluate((el) => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }
  await new Promise(r => setTimeout(r, 5000));
  return { found: true, observed, strategy };
}

const A = await tryClick('click');
console.log('[A] element.click() →', A.observed ? '✅ 触发字幕请求' : '❌ 未触发');
const B = A.observed ? A : await tryClick('pointer');
console.log('[B] pointerdown+up+click →', B.observed ? '✅ 触发' : '❌ 未触发');
console.log('\n结论：', B.observed
  ? 'operate 可走 click 路线（content.js subtitleObserved=true 即生效）'
  : 'click 路线不可行 → operate 必须 CDP 降级（attach debugger + Input.dispatchMouseEvent）');

await browser.close();
