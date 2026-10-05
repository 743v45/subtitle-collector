// navigate 命令目标 URL/host 白名单（C6 兜底闸）纯逻辑的测试。
// server 端同款校验在 apps/collector-server/src/http/clients.ts（validateNavigateUrl）——两端
// 同一份清单字面量（注释互指），本文件锁字面量稳定性 + 判定的正反例（子域放行/伪装域拒）。
// 测试轮次：2026-10-04 pnpm --filter subtitle-collector test 绿（c8 覆盖门过）；
// node scripts/quality-baseline.mjs dry-run——background.js 复杂度/行数零恶化（1352 ≤ 1353）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAVIGATE_HOST_SUFFIXES, isAllowedNavigateHost, isAllowedNavigateUrl, resolveNavigateTarget, handleNavigateCommand } from '../navigate-guard.mjs';

test('isAllowedNavigateHost：白名单域本身与子域放行，伪装域/外部域/非字符串拒', () => {
  // 域本身（裸域，如 bilibili.com 主站搜索页）
  assert.equal(isAllowedNavigateHost('bilibili.com'), true);
  assert.equal(isAllowedNavigateHost('youtube.com'), true);
  assert.equal(isAllowedNavigateHost('douyin.com'), true);
  // 常用子域（www 视频/m 移动/search 搜索/space 空间页）
  assert.equal(isAllowedNavigateHost('www.bilibili.com'), true);
  assert.equal(isAllowedNavigateHost('m.bilibili.com'), true);
  assert.equal(isAllowedNavigateHost('search.bilibili.com'), true);
  assert.equal(isAllowedNavigateHost('www.youtube.com'), true);
  assert.equal(isAllowedNavigateHost('www.douyin.com'), true);
  // 大小写不敏感（URL hostname 已小写化，直调防御）
  assert.equal(isAllowedNavigateHost('WWW.BILIBILI.COM'), true);
  // 伪装域：前缀拼接（evil-bilibili.com）与后缀拼接（bilibili.com.evil.com）都不是子域
  assert.equal(isAllowedNavigateHost('evil-bilibili.com'), false);
  assert.equal(isAllowedNavigateHost('bilibili.com.evil.com'), false);
  assert.equal(isAllowedNavigateHost('example.com'), false);
  // 非法/缺省入参防御（String(null ?? '') → 空串，不在白名单）
  assert.equal(isAllowedNavigateHost(''), false);
  assert.equal(isAllowedNavigateHost(null), false);
  assert.equal(isAllowedNavigateHost(undefined), false);
});

test('isAllowedNavigateUrl：合法三平台 http(s) 页放行，解析失败/协议/host 非法拒', () => {
  // 合法：三平台典型视频/搜索页
  assert.equal(isAllowedNavigateUrl('https://www.bilibili.com/video/BV1xxx411c7mD'), true);
  assert.equal(isAllowedNavigateUrl('http://bilibili.com/search?keyword=x'), true, '裸域 http 放行');
  assert.equal(isAllowedNavigateUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isAllowedNavigateUrl('https://www.douyin.com/video/7123456789012345678'), true);
  // URL 解析失败（background 侧打日志带原值后丢弃）
  assert.equal(isAllowedNavigateUrl('not a url'), false);
  assert.equal(isAllowedNavigateUrl(''), false);
  assert.equal(isAllowedNavigateUrl(undefined), false, '缺 url 字段');
  // 协议收紧：只放行 http(s)
  assert.equal(isAllowedNavigateUrl('ftp://www.bilibili.com/video/BV1xxx'), false);
  assert.equal(isAllowedNavigateUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedNavigateUrl('chrome://extensions'), false);
  // host 收紧：外部域与伪装域
  assert.equal(isAllowedNavigateUrl('https://evil.com/video/BV1xxx'), false);
  assert.equal(isAllowedNavigateUrl('https://bilibili.com.evil.com/video/BV1xxx'), false);
});

test('白名单清单稳定：三平台域名，与 server 端 clients.ts 保持同一份字面量', () => {
  // 字面量锁死：改动须同步 server 端 clients.ts 的 NAVIGATE_HOST_SUFFIXES（两端注释互指）
  assert.deepEqual(NAVIGATE_HOST_SUFFIXES, ['bilibili.com', 'youtube.com', 'douyin.com']);
});

test('resolveNavigateTarget：合法返回原 URL（原样透传开 tab），非法返回 null', () => {
  // 合法：返回入参原值（handleNavigateCommand 拿它开 tab，与校验前字节一致）
  assert.equal(resolveNavigateTarget('https://www.bilibili.com/video/BV1xxx411c7mD'), 'https://www.bilibili.com/video/BV1xxx411c7mD');
  assert.equal(resolveNavigateTarget('https://www.douyin.com/video/7123456789012345678'), 'https://www.douyin.com/video/7123456789012345678');
  // 非法：不可解析 / 非 http(s) / host 不在白名单族 → null（调用方打日志静默丢弃）
  assert.equal(resolveNavigateTarget('not a url'), null);
  assert.equal(resolveNavigateTarget(undefined), null);
  assert.equal(resolveNavigateTarget('chrome://extensions'), null);
  assert.equal(resolveNavigateTarget('https://evil.com/video/BV1xxx'), null);
});

test('handleNavigateCommand：合法目标开 tab 并回执 ok:true；被拒打日志且静默丢弃（不回执、不开 tab）', async () => {
  // chrome.tabs 经 globalThis.chrome 注入 fake（guard 模块在扩展内用全局 chrome，node:test 下注入等价物）；
  // ws 由参数传入 fake；console.warn 临时接管捕日志（被拒路径的可观察性出口）。
  const created = [];
  const sent = [];
  const warns = [];
  const origWarn = console.warn;
  const origChrome = globalThis.chrome;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  globalThis.chrome = { tabs: { create: async (opts) => { created.push(opts); return { id: 42 }; } } };
  try {
    const ws = { send: (s) => sent.push(s) };
    // 合法：B 站视频页 → 恰好开一个 tab（URL 原样）+ 回执 result ok:true（id 透传），零告警
    await handleNavigateCommand(ws, { id: 'n1', url: 'https://www.bilibili.com/video/BV1xxx411c7mD' });
    assert.deepEqual(created, [{ url: 'https://www.bilibili.com/video/BV1xxx411c7mD' }]);
    assert.deepEqual(sent, [JSON.stringify({ type: 'result', id: 'n1', ok: true, data: { opened: true } })]);
    assert.equal(warns.length, 0);
    // 非法：伪装域（后缀拼接）→ 不开 tab、不回执（server 侧按超时收尾），warn 带目标 URL
    await handleNavigateCommand(ws, { id: 'n2', url: 'https://bilibili.com.evil.com/video/BV1xxx' });
    assert.equal(created.length, 1, '被拒路径不得开 tab');
    assert.equal(sent.length, 1, '被拒路径不得回执');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /navigate 目标被拒/);
    assert.match(warns[0], /bilibili\.com\.evil\.com/);
  } finally {
    console.warn = origWarn;
    if (origChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = origChrome;
  }
});
