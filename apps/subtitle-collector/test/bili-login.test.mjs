// bili-login（B 站登录态抽取）测试：对齐 wbi.test.mjs 的 extractKeysFromNav 模式。
// 背景：充电视频 AI 字幕接口未登录返回空（2026-08-24 批量 1190 no_subtitle 根因），
// 登录态必须从 nav 响应正确抽取（isLogin/mid/uname/vipStatus → is_login/mid/uname/vip）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLoginFromNav } from '../bili-login.mjs';

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
