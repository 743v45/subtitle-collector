// test/dy-profile-error.test.mjs
// 「博主不存在」终态识别回归（2026-08-30 spike：docs/plans/douyin/upper-page-spike.md 修法 ①③）。
// 背景：sec_uid 已注销的博主页 profile/other 回 200 + status_code:2「UserId不合法」+ user:{}，
// 旧判定（user truthiness）让 {} 穿透伪装 ok+total:0，或 profile 未送达时 M2 误报「页面改版或未注入」。
// 本文件锁定：inject-dy 对 status_code!==0 / user 缺 sec_uid / 空体 / 坏 JSON 发 PROFILE_OTHER_ERROR
// （status_msg 透传）；content-dy 收到即置 error 态秒级失败（含就绪竞态的缓冲重放路径）。
// 沙箱模式对齐 content-required-fields-warn.test.mjs（readFileSync+vm，不进 c8 覆盖口径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { ssrVideoDetailToAwemeDetail, extractDouyinCaptionTracks } from '../douyin-format.mjs';
import { buildDouyinPayload } from '../douyin-payload.js';

// 测试轮次记录（对齐项目 CLAUDE.md §3 / RULES §5）
// | 轮次 | 日期       | 范围                                                        | 结果 | 备注 |
// |------|------------|-------------------------------------------------------------|------|------|
// | T1   | 2026-08-30 | spike ①③：inject-dy PROFILE_OTHER_ERROR + content-dy 错误态 | PASS | `pnpm qa` 全绿；扩展 pnpm test 覆盖率锁定达标 |

const SEC = 'MS4wLjABAAAA2y53DZw7-0cG6yOfaZCJesMdyIdXhqLPu2abnCFjkUs';
// spike §8 原始证据逐字形态（死 sec_uid profile/other 响应体，129 B）
const DEAD_PROFILE_BODY = JSON.stringify({
  extra: null, log_pb: { impr_id: '20260830' }, status_code: 2, status_msg: 'UserId不合法', user: {},
});
// 健康样本（spike §2：status_code:0 + 完整 user，节选关键键）
const HEALTHY_PROFILE_BODY = JSON.stringify({
  status_code: 0, status_msg: '', user: { sec_uid: SEC, nickname: '测试博主', follower_count: 42 },
});
const PROFILE_URL = `https://www-hj.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=${SEC}&aid=6383`; // 灰度 host（spike §6.6 登记）——子串匹配天然兼容，一并回归
const POST_URL = `https://www-hj.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0&count=18`;

// ── inject-dy 沙箱（XHR hook 路驱动 handlePayload；MAIN world 脚本无 import，直接整文件跑）──
function loadInject() {
  const posted = [];
  const warns = [];
  const logs = [];
  class FakeXHR {
    addEventListener(type, fn) { (this._listeners ??= {})[type] = fn; }
    open(method, url) { this._url = url; }
    send() {}
  }
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => warns.push(a.join(' ')), error() {} },
    setTimeout: () => 0, clearTimeout() {}, // pollSsr 的 20s 轮询不真跑
    URL,
    location: { origin: 'https://www.douyin.com' },
    XMLHttpRequest: FakeXHR,
    window: { postMessage: (m) => posted.push(m), fetch: async () => {} },
  };
  vm.runInNewContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'inject-dy.js'), 'utf8'), sandbox);
  // 模拟页面 XHR：走 inject-dy 包装后的 open/send，再手动触发 load（this 上带响应特征）
  const fireXhr = (url, responseText) => {
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('GET', url);
    xhr.send();
    xhr.status = 200;
    xhr.responseType = '';
    xhr.responseText = responseText;
    xhr._listeners.load.call(xhr);
  };
  return { posted, warns, logs, fireXhr };
}

// ── content-dy 沙箱（import 剥离后以真实依赖函数作全局注入；ISOLATED world 消息驱动）──
function loadContentDy() {
  const warns = [];
  let winMessage = null;
  let runtimeHandler = null;
  const sandbox = {
    console: { log() {}, warn: (...a) => warns.push(a.join(' ')), error() {} },
    setTimeout: () => 0, clearTimeout() {}, // 滚动定时器不真跑
    ssrVideoDetailToAwemeDetail, extractDouyinCaptionTracks, buildDouyinPayload, // 剥离的 import 以真身注入
    chrome: { runtime: { onMessage: { addListener: (fn) => { runtimeHandler = fn; } } } },
    window: null,
  };
  const win = { addEventListener: (_t, fn) => { winMessage = fn; } };
  sandbox.window = win;
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'content-dy.js'), 'utf8')
    .replace(/^import[^\n]*\n/gm, '');
  vm.runInNewContext(src, sandbox);
  return {
    warns,
    // inject-dy 消息信封（window message 事件）
    dispatch: (type, data) => winMessage({ source: win, data: { source: 'dy-sub-ext', type, data } }),
    // chrome.runtime 消息（DY_UPPER_START / GET_UPPER_STATE）
    runtime: (msg) => new Promise((resolve) => { runtimeHandler(msg, {}, resolve); }),
  };
}

// ── inject-dy：PROFILE_OTHER_ERROR 判据（spike ① 双保险：status_code + user.sec_uid）──

test('inject：死 sec_uid profile（200 + status_code:2「UserId不合法」+ user:{}）→ PROFILE_OTHER_ERROR 透传 status_msg，不再发 PROFILE_OTHER', () => {
  const h = loadInject();
  h.fireXhr(PROFILE_URL, DEAD_PROFILE_BODY);
  assert.equal(h.posted.filter((m) => m.type === 'PROFILE_OTHER').length, 0, 'user:{} 不得再伪装正常 profile');
  const err = h.posted.find((m) => m.type === 'PROFILE_OTHER_ERROR');
  assert.ok(err, '必须发 PROFILE_OTHER_ERROR');
  assert.equal(err.data.secUid, SEC, 'secUid 从请求 URL 抽取（回传供 content-dy 归属过滤）');
  assert.equal(err.data.kind, 'status');
  assert.equal(err.data.statusCode, 2);
  assert.equal(err.data.statusMsg, 'UserId不合法', 'status_msg 原样透传（错误文案的数据源）');
  assert.ok(h.warns.some((w) => w.includes('PROFILE_OTHER_ERROR')), '失败路径留 warn 线索');
});

test('inject：status_code:0 但 user 缺 sec_uid（user:{}）→ 同样报 PROFILE_OTHER_ERROR（双保险第二判据）', () => {
  const h = loadInject();
  h.fireXhr(PROFILE_URL, JSON.stringify({ status_code: 0, status_msg: '', user: {} }));
  assert.equal(h.posted.filter((m) => m.type === 'PROFILE_OTHER').length, 0);
  const err = h.posted.find((m) => m.type === 'PROFILE_OTHER_ERROR');
  assert.ok(err);
  assert.equal(err.data.kind, 'status');
  assert.equal(err.data.statusCode, 0);
});

test('inject：健康 profile（status_code:0 完整 user）→ 照常 PROFILE_OTHER 带原 user，无错误消息（回归）', () => {
  const h = loadInject();
  h.fireXhr(PROFILE_URL, HEALTHY_PROFILE_BODY);
  assert.equal(h.posted.filter((m) => m.type === 'PROFILE_OTHER_ERROR').length, 0, '健康样本不得误报错误');
  const ok = h.posted.find((m) => m.type === 'PROFILE_OTHER');
  assert.ok(ok, '照常透传 PROFILE_OTHER');
  assert.equal(ok.data.secUid, SEC);
  assert.equal(ok.data.user.nickname, '测试博主', 'user 原样透传（douyinCreatorFromProfile 口径）');
});

// ── inject-dy：profile 空 body / 坏 JSON 归入错误（spike ③，与 POST_LIST_EMPTY 对称）──

test('inject：profile 200 空体 → PROFILE_OTHER_ERROR（empty-body）；post 空体仍走 POST_LIST_EMPTY 互不干扰', () => {
  const h = loadInject();
  h.fireXhr(PROFILE_URL, '');
  const err = h.posted.find((m) => m.type === 'PROFILE_OTHER_ERROR');
  assert.ok(err, 'profile 空体不再静默丢弃');
  assert.equal(err.data.kind, 'empty-body');
  assert.equal(err.data.secUid, SEC);

  h.fireXhr(POST_URL, '');
  assert.ok(h.posted.some((m) => m.type === 'POST_LIST_EMPTY'), 'post 空体的「需登录」路径保持原样');
});

test('inject：profile 坏 JSON → PROFILE_OTHER_ERROR（bad-json）；detail 坏 JSON 维持告警丢弃（范围仅 profile）', () => {
  const h = loadInject();
  h.fireXhr(PROFILE_URL, '{"status_code":2,');
  const err = h.posted.find((m) => m.type === 'PROFILE_OTHER_ERROR');
  assert.ok(err, 'profile 坏 JSON 必须上报错误消息');
  assert.equal(err.data.kind, 'bad-json');

  h.fireXhr('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=7', 'not-json{');
  assert.equal(h.posted.length, 1, 'detail 坏 JSON 不发消息（维持原行为）');
  assert.ok(h.warns.some((w) => w.includes('JSON 解析失败')));
});

// ── content-dy：错误态置位（秒级失败，含就绪竞态缓冲重放）──

test('content：DY_UPPER_START 后收到 PROFILE_OTHER_ERROR → 立即 error 态「博主不存在（UserId不合法）」（不等窗口）', async () => {
  const h = loadContentDy();
  assert.equal((await h.runtime({ type: 'DY_UPPER_START', secUid: SEC })).ok, true);
  const st0 = await h.runtime({ type: 'GET_UPPER_STATE' });
  assert.equal(st0.state, 'running', '启动即 running（窗口期）');

  h.dispatch('PROFILE_OTHER_ERROR', { secUid: SEC, kind: 'status', statusCode: 2, statusMsg: 'UserId不合法' });
  const st = await h.runtime({ type: 'GET_UPPER_STATE' });
  assert.equal(st.state, 'error', '错误态秒级置位（background 下轮轮询即收尾，不耗 20s）');
  assert.match(st.error, /博主不存在（UserId不合法）/);

  // 首错优先：后续消息不得覆盖已定性的错误
  h.dispatch('PROFILE_OTHER_ERROR', { secUid: SEC, kind: 'status', statusCode: 9, statusMsg: '后来者' });
  const st2 = await h.runtime({ type: 'GET_UPPER_STATE' });
  assert.match(st2.error, /博主不存在（UserId不合法）/, '首错优先不被覆盖');
});

test('content：错误先于 DY_UPPER_START 到达（就绪竞态）→ 缓冲重放同样置 error（spike ① 竞态安全）', async () => {
  const h = loadContentDy();
  h.dispatch('PROFILE_OTHER_ERROR', { secUid: SEC, kind: 'status', statusCode: 2, statusMsg: 'UserId不合法' });
  assert.equal((await h.runtime({ type: 'DY_UPPER_START', secUid: SEC })).ok, true);
  const st = await h.runtime({ type: 'GET_UPPER_STATE' });
  assert.equal(st.state, 'error', '重放缓冲里的错误消息同样生效');
  assert.match(st.error, /博主不存在（UserId不合法）/);
});

test('content：empty-body / bad-json → 「博主资料异常」明确文案；POST_LIST_EMPTY 先到则「需登录」保留（首错优先）', async () => {
  const empty = loadContentDy();
  await empty.runtime({ type: 'DY_UPPER_START', secUid: SEC });
  empty.dispatch('PROFILE_OTHER_ERROR', { secUid: SEC, kind: 'empty-body', statusCode: null, statusMsg: '' });
  assert.match((await empty.runtime({ type: 'GET_UPPER_STATE' })).error, /博主资料异常（profile\/other 200 空体）/);

  const bad = loadContentDy();
  await bad.runtime({ type: 'DY_UPPER_START', secUid: SEC });
  bad.dispatch('PROFILE_OTHER_ERROR', { secUid: SEC, kind: 'bad-json', statusCode: null, statusMsg: '' });
  assert.match((await bad.runtime({ type: 'GET_UPPER_STATE' })).error, /博主资料异常（profile\/other 响应不可解析）/);

  const loginFirst = loadContentDy();
  await loginFirst.runtime({ type: 'DY_UPPER_START', secUid: SEC });
  loginFirst.dispatch('POST_LIST_EMPTY', { secUid: SEC });
  loginFirst.dispatch('PROFILE_OTHER_ERROR', { secUid: SEC, kind: 'status', statusCode: 2, statusMsg: 'UserId不合法' });
  const st = await loginFirst.runtime({ type: 'GET_UPPER_STATE' });
  assert.match(st.error, /未登录抖音/, '「需登录」定性在先，不被博主不存在覆盖');
});

test('content：健康 profile → 聚合照常（profile 入状态机无错误）＋ POST_LIST done 收尾（回归）', async () => {
  const h = loadContentDy();
  await h.runtime({ type: 'DY_UPPER_START', secUid: SEC });
  h.dispatch('PROFILE_OTHER', { secUid: SEC, user: { sec_uid: SEC, nickname: '测试博主' } });
  h.dispatch('POST_LIST', {
    secUid: SEC, hasMore: false,
    awemeList: [{ aweme_id: '7123456789012345678', desc: '某作品', aweme_type: 0, create_time: 1787896381, duration: 61000, statistics: { play_count: 0 }, video: { cover: { url_list: ['https://c.jpg'] } } }],
  });
  const st = await h.runtime({ type: 'GET_UPPER_STATE' });
  assert.equal(st.state, 'done', '翻页尽头正常收尾');
  assert.equal(st.profile.nickname, '测试博主');
  assert.equal(st.items.length, 1, '作品正常聚合');
  assert.equal(st.error, null);
});
