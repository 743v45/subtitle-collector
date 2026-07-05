// 脚本方式验证：打开浏览器 → 点 AI 字幕 → 拦明文 aisubtitle，能否采到充电专属视频字幕。
// 复用 debug Chrome profile（/tmp/chrome-debug-bili）的登录态。用法：node scripts/test-navigate-collect.mjs <bvid>
import puppeteer from 'puppeteer';

const BVID = process.argv[2] ?? 'BV1L6Ty6uEQ5';
const browser = await puppeteer.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  userDataDir: '/tmp/chrome-debug-bili',
  args: ['--no-first-run', '--no-default-browser-check', '--disable-popup-blocking'],
});
try {
  const page = await browser.newPage();
  let aiUrl = null, aiBody = null;
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('aisubtitle') || url.includes('/bfs/ai_subtitle/')) {
      try { aiBody = await resp.json(); aiUrl = url; console.log(`[拦到 aisubtitle] ${url.slice(0, 70)} body_len=${JSON.stringify(aiBody).length}`); } catch {}
    }
  });
  console.log(`[打开] https://www.bilibili.com/video/${BVID}/`);
  await page.goto(`https://www.bilibili.com/video/${BVID}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 等字幕按钮就绪
  await page.waitForSelector('.bpx-player-ctrl-subtitle', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1500));
  // 点字幕按钮开菜单
  await page.click('.bpx-player-ctrl-subtitle');
  // 等 + 点"中文"(AI) 语言项（带重试，菜单渲染可能延迟）
  let picked = false;
  for (let i = 0; i < 10 && !picked; i++) {
    picked = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.bpx-player-ctrl-subtitle-language-item')];
      const ai = items.find((el) => /中文|AI|简体/.test(el.textContent));
      if (ai) { ai.click(); return true; }
      return false;
    });
    if (!picked) await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[点 AI 字幕语言项] ${picked}`);
  // 等 aisubtitle 响应
  for (let i = 0; i < 20 && !aiBody; i++) await new Promise((r) => setTimeout(r, 500));
  console.log(`[结果] ${aiBody ? `✅ 字幕采到 body_len=${JSON.stringify(aiBody).length} lang=${aiBody.lang}` : '❌ 未拦到 aisubtitle'}`);
  if (aiBody?.body) console.log(`[首句] ${aiBody.body[0]?.content}`);
} finally {
  await browser.close();
}
