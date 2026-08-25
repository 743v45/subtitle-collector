// yt-login（YouTube 登录态抽取）测试：镜像 bili-login.test.mjs 模式（2026-08-25 全链路可观察镜像）。
// 背景：未登录是 YouTube 批量 no_subtitle（年龄限制视频播不了）与 pot_limited（pot 受限加重）
// 的判因维度，登录态必须从首页 HTML 的 ytcfg LOGGED_IN 标记正确抽取。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLoginFromYoutube, ytLoginInfoOf, warnYtLoggedOut } from '../yt-login.mjs';
import { createLoginTracker } from '../bili-login.mjs';

// ── ytLoginInfoOf / warnYtLoggedOut：回执装配与未登录告警（fetch-youtube-subtitle 消费）──

test('ytLoginInfoOf：已知 → {yt_login}；未知(null) → 空对象(字段省略)', () => {
  assert.deepEqual(ytLoginInfoOf({ is_login: true }), { yt_login: true });
  assert.deepEqual(ytLoginInfoOf({ is_login: false }), { yt_login: false });
  assert.deepEqual(ytLoginInfoOf(null), {});
});

test('warnYtLoggedOut：未登录 → warn 日志带 videoId 与原因；已登录/未知 → 不打', () => {
  const logs = [];
  const log = (msg, level) => logs.push([msg, level]);
  warnYtLoggedOut({ is_login: false }, 'hX7yG1KVYhI', log);
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /未登录.*hX7yG1KVYhI/);
  assert.equal(logs[0][1], 'warn');
  warnYtLoggedOut({ is_login: true }, 'hX7yG1KVYhI', log);
  warnYtLoggedOut(null, 'hX7yG1KVYhI', log);
  assert.equal(logs.length, 1, '已登录/未知不打');
});

// ── extractLoginFromYoutube：首页 HTML 内嵌 ytcfg.set 的 LOGGED_IN 标记 ──

test('extractLoginFromYoutube：已登录 HTML → is_login true', () => {
  const html = '<script>ytcfg.set({"CLIENT_CANARY_REGION":"","LOGGED_IN":true,"PAGE_BUILD_LABEL":"youtube.desktop.web_20260801_00_RC01","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20260801.00.00"});</script>';
  assert.deepEqual(extractLoginFromYoutube({ ok: true, data: html }), { is_login: true });
});

test('extractLoginFromYoutube：未登录 HTML → is_login false', () => {
  const html = '<script>ytcfg.set({"CLIENT_CANARY_REGION":"","LOGGED_IN":false,"PAGE_BUILD_LABEL":"youtube.desktop.web_20260801_00_RC01"});</script>';
  assert.deepEqual(extractLoginFromYoutube({ ok: true, data: html }), { is_login: false });
});

test('extractLoginFromYoutube：无标记（consent 墙/风控页/改版/畸形）→ null（探测失败 ≠ 未登录）', () => {
  const consentHtml = '<html><head><title>Before you continue to YouTube</title></head><body>consent 页无 ytcfg</body></html>';
  assert.equal(extractLoginFromYoutube({ ok: true, data: consentHtml }), null, 'consent 页无标记');
  assert.equal(extractLoginFromYoutube({ ok: true, data: '' }), null, '空串');
  assert.equal(extractLoginFromYoutube(null), null, '响应 null');
  assert.equal(extractLoginFromYoutube({ ok: true, data: null }), null, 'data 非字符串');
});

// ── createLoginTracker 泛化：extract 注入 yt 解析（标记缺失保留旧值，对齐探测失败语义）──

test('createLoginTracker：注入 yt extract——首次抽取 + 变化 onChange + 标记缺失保留旧值不上报', async () => {
  const ytHtml = (loggedIn) => ({ ok: true, data: `ytcfg.set({"LOGGED_IN":${loggedIn}});` });
  let resp = ytHtml(true);
  const changes = [];
  const t = createLoginTracker({
    fetchNav: async () => resp,
    extract: extractLoginFromYoutube,
    onChange: (l) => changes.push(l),
    ttlMs: 60 * 1000,
  });
  assert.equal(t.current, null, '初始未知');
  await t.maybeRefresh();
  assert.deepEqual(t.current, { is_login: true });
  assert.equal(changes.length, 1, '首测视为变化上报');

  // 标记缺失（consent/风控页，HTTP 仍 200）→ 保留旧值不上报（探测失败 ≠ 未登录）
  resp = { ok: true, data: '<html><title>Before you continue to YouTube</title></html>' };
  await t.maybeRefresh(true);
  assert.deepEqual(t.current, { is_login: true }, '标记缺失保留旧值');
  assert.equal(changes.length, 1);

  // 登录 → 退出：变化触发第二次 onChange
  resp = ytHtml(false);
  await t.maybeRefresh(true);
  assert.deepEqual(t.current, { is_login: false });
  assert.equal(changes.length, 2);
});
