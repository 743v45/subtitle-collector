// bili-login（B 站登录态抽取）测试：对齐 wbi.test.mjs 的 extractKeysFromNav 模式。
// 背景：充电视频 AI 字幕接口未登录返回空（2026-08-24 批量 1190 no_subtitle 根因），
// 登录态必须从 nav 响应正确抽取（isLogin/mid/uname/vipStatus → is_login/mid/uname/vip）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLoginFromNav, createLoginTracker, loginInfoOf, warnLoggedOut } from '../bili-login.mjs';

// ── loginInfoOf / warnLoggedOut：回执装配与未登录告警（fetch-subtitle 消费）──

test('loginInfoOf：已知 → {login}；未知(null) → 空对象(字段省略)', () => {
  assert.deepEqual(loginInfoOf({ is_login: true }), { login: true });
  assert.deepEqual(loginInfoOf({ is_login: false }), { login: false });
  assert.deepEqual(loginInfoOf(null), {});
});

test('warnLoggedOut：未登录 → warn 日志带 bvid 与原因；已登录/未知 → 不打', () => {
  const logs = [];
  const log = (msg, level) => logs.push([msg, level]);
  warnLoggedOut({ is_login: false }, 'BV1x', log);
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /BV1x.*未登录/);
  assert.equal(logs[0][1], 'warn');
  warnLoggedOut({ is_login: true }, 'BV1x', log);
  warnLoggedOut(null, 'BV1x', log);
  assert.equal(logs.length, 1, '已登录/未知不打');
});

test('extractLoginFromNav：已登录 → is_login true + mid 转字符串 + uname + vip 状态', () => {
  const nav = {
    code: 0,
    data: {
      isLogin: true,
      mid: 3546645614562148,
      uname: '测试用户',
      vipStatus: 1,
      wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/xxx.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/yyy.png' },
    },
  };
  assert.deepEqual(extractLoginFromNav(nav), {
    is_login: true,
    mid: '3546645614562148',
    uname: '测试用户',
    vip: true,
  });
});

test('extractLoginFromNav：未登录 → is_login false，不带账号字段（wbi_img 仍有）', () => {
  const nav = {
    code: 0,
    data: {
      isLogin: false,
      wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/xxx.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/yyy.png' },
    },
  };
  // 未登录时 nav 不带 mid/uname/vipStatus——快照只报 is_login:false
  assert.deepEqual(extractLoginFromNav(nav), { is_login: false });
});

test('extractLoginFromNav：畸形响应（null/缺 data/isLogin 非布尔）→ 兜底未登录不炸', () => {
  assert.deepEqual(extractLoginFromNav(null), { is_login: false });
  assert.deepEqual(extractLoginFromNav({}), { is_login: false });
  assert.deepEqual(extractLoginFromNav({ data: { isLogin: 'yes' } }), { is_login: false }, 'isLogin 非布尔按未登录');
});

test('extractLoginFromNav：已登录但 uname 空串 / mid 非数字 → 对应字段省略，is_login 仍 true', () => {
  const r = extractLoginFromNav({ data: { isLogin: true, uname: '', mid: 'not-a-number' } });
  assert.equal(r.is_login, true);
  assert.equal(r.uname, undefined, '空串昵称省略');
  assert.equal(r.mid, undefined, '非数字 mid 省略');
});

// ── createLoginTracker：TTL 缓存状态机（fetchNav 注入）──

test('createLoginTracker：首次刷新拉取 + 变化触发 onChange；TTL 内零请求；探测失败保留旧值', async () => {
  const navOk = (isLogin) => ({ ok: true, data: { isLogin, ...(isLogin ? { mid: 7, uname: '甲' } : {}) } });
  let resp = navOk(true);
  let calls = 0;
  const changes = [];
  const t = createLoginTracker({
    fetchNav: async () => { calls++; return resp; },
    onChange: (l) => changes.push(l),
    ttlMs: 60 * 1000,
  });
  assert.equal(t.current, null, '初始未知');
  await t.maybeRefresh();
  assert.deepEqual(t.current, { is_login: true, mid: '7', uname: '甲', vip: false });
  assert.equal(changes.length, 1, '首测视为变化上报');

  await t.maybeRefresh();
  assert.equal(calls, 1, 'TTL 内零请求');

  // 探测失败（接口非 ok / 抛错）→ 保留旧值不上报
  resp = { ok: false, code: 'need_login' };
  await t.maybeRefresh(true);
  assert.equal(t.current.is_login, true, '非 ok 保留旧值');
  assert.equal(changes.length, 1);
  resp = null; // 响应空（网络层异常形态）：parsed?.ok 短路同样保留旧值
  const t2resp = await t.maybeRefresh(true);
  assert.equal(t2resp.is_login, true, '异常保留旧值');

  // 登录 → 退出：变化触发第二次 onChange
  resp = navOk(false);
  await t.maybeRefresh(true);
  assert.deepEqual(t.current, { is_login: false });
  assert.equal(changes.length, 2);
});
