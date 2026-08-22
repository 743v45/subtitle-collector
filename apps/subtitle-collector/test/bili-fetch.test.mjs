import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBiliResponse, formatSearchResult, fetchSubtitleView, biliFetch } from '../bili-fetch.js';

test('parseBiliResponse code:0 返回 data', () => {
  assert.deepEqual(parseBiliResponse({ code: 0, data: { foo: 1 } }), { ok: true, data: { foo: 1 } });
});

test('parseBiliResponse code:-101 → need_login', () => {
  assert.deepEqual(parseBiliResponse({ code: -101 }), { ok: false, code: 'need_login' });
});

test('parseBiliResponse code:-412 → risk_control', () => {
  assert.deepEqual(parseBiliResponse({ code: -412 }), { ok: false, code: 'risk_control' });
});

test('parseBiliResponse 其他错误码透传', () => {
  assert.deepEqual(parseBiliResponse({ code: -509, message: 'x' }), { ok: false, code: 'bili_-509', message: 'x' });
});

test('formatSearchResult 把 search response.data 格式化成 {total, items}', () => {
  // 2026-08 实测：B 站把 data.page 从 {count} 对象改为数字（页码），总数挪到顶层 numResults
  const data = {
    page: 1,
    numResults: 137,
    result: [
      { bvid: 'BV1a', title: 't1', author: 'up1', mid: 11, play: 100, duration: 120, pubdate: 1700000000 },
      { bvid: 'BV2b', title: 't2', author: 'up2', mid: 22, play: 200, duration: 60, pubdate: 1700000001 },
    ],
  };
  const out = formatSearchResult(data);
  assert.equal(out.total, 137);
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].bvid, 'BV1a');
  assert.equal(out.items[0].up, 'up1');
  assert.equal(out.items[0].mid, 11);
});

test('formatSearchResult 兼容旧形态 page.count（老缓存/降级响应）', () => {
  const out = formatSearchResult({ page: { count: 42 }, result: [] });
  // 旧字段不存在于新实现时兜底 items.length；numResults 缺失 → total=0（items 空）
  assert.equal(out.total, 0);
});

test('formatSearchResult 清理 title 中的 <em class="keyword"> 高亮标签', () => {
  const data = {
    page: { count: 1 },
    result: [
      { bvid: 'BV1a', title: '<em class="keyword">t1</em>', author: 'up1', mid: 11, play: 100, duration: 120, pubdate: 1700000000 },
    ],
  };
  const out = formatSearchResult(data);
  assert.equal(out.items[0].title, 't1');
});

test('parseBiliResponse 缺 code → malformed', () => {
  assert.deepEqual(parseBiliResponse({}), { ok: false, code: 'malformed', message: 'non-json or missing code' });
  assert.deepEqual(parseBiliResponse(null), { ok: false, code: 'malformed', message: 'non-json or missing code' });
});

// ── fetchSubtitleView / biliFetch（mock globalThis.fetch，真 Response；不依赖真实网络/登录态）──

function mockFetch(responder) {
  const reqs = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const rec = { url: String(url), init };
    reqs.push(rec);
    return Promise.resolve(responder(rec));
  };
  return { reqs, restore: () => { globalThis.fetch = orig; } };
}

const bytes = (s) => new TextEncoder().encode(s); // 伪 protobuf 字节流

test('fetchSubtitleView：网络抛错 / 非 2xx / 无 URL / 空体 → []', async () => {
  const dead = mockFetch(() => { throw new TypeError('Failed to fetch'); });
  try { assert.deepEqual(await fetchSubtitleView(1, 2), []); } finally { dead.restore(); }

  const bad = mockFetch(() => new Response('', { status: 500 }));
  try { assert.deepEqual(await fetchSubtitleView(1, 2), []); } finally { bad.restore(); }

  const noUrl = mockFetch(() => new Response(bytes('garbage bytes without subtitle urls')));
  try { assert.deepEqual(await fetchSubtitleView(1, 2), []); } finally { noUrl.restore(); }

  const empty = mockFetch(() => new Response(''));
  try { assert.deepEqual(await fetchSubtitleView(1, 2), []); } finally { empty.restore(); }
});

test('fetchSubtitleView：URL 与 lang 明文按序配对（ai-zh / zh-Hans）+ type 1 + 请求参数/Referer', async () => {
  const text = 'hdr ai-zh //aisubtitle.hdslb.com/ts?auth_key=0123456789abcdef-cdfe zh-Hans //subtitle.bilibili.com/t2?auth_key=abcdef0123456789-abcd';
  const m = mockFetch(() => new Response(bytes(text)));
  try {
    const subs = await fetchSubtitleView(11, 22);
    assert.equal(subs.length, 2);
    assert.equal(subs[0].lan, 'ai-zh');
    assert.equal(subs[0].lan_doc, 'AI（简中）');
    assert.ok(subs[0].subtitle_url.startsWith('https://aisubtitle.hdslb.com/ts?auth_key=0123456789abcdef-cdfe'), subs[0].subtitle_url);
    assert.equal(subs[0].type, 1);
    assert.equal(subs[1].lan, 'zh-Hans');
    assert.equal(subs[1].lan_doc, '简体中文');
    assert.ok(subs[1].subtitle_url.startsWith('https://subtitle.bilibili.com/t2?auth_key=abcdef0123456789-abcd'), subs[1].subtitle_url);
    // 请求侧：oid/pid 参数 + 固定 Referer
    const u = new URL(m.reqs[0].url);
    assert.equal(u.searchParams.get('oid'), '11');
    assert.equal(u.searchParams.get('pid'), '22');
    assert.equal(m.reqs[0].init.headers.Referer, 'https://www.bilibili.com/');
  } finally { m.restore(); }
});

test('fetchSubtitleView：lang 配不上默认 ai-zh；含控制字符编码的「加密 URL」被过滤', async () => {
  // 一个明文 lang（ai-en）+ 一个含 %00 的加密 URL（应被过滤，扩展不可直接 fetch）
  const text = 'ai-en //aisubtitle.hdslb.com/a?auth_key=aaaaaaaaaaaaaaa1-bbbb //subtitle.bilibili.com/b%00c?auth_key=cccccccccccccccc-dddd';
  const m = mockFetch(() => new Response(bytes(text)));
  try {
    const subs = await fetchSubtitleView(1, 2);
    assert.equal(subs.length, 1, '加密 URL 应被过滤');
    assert.equal(subs[0].lan, 'ai-en');
    assert.equal(subs[0].lan_doc, 'AI（English）');
  } finally { m.restore(); }
});

test('fetchSubtitleView：lang 比 URL 少 → 缺位默认 ai-zh / AI（简中）', async () => {
  const text = 'ai-zh //aisubtitle.hdslb.com/only?auth_key=1111111111111111-2222 //aisubtitle.hdslb.com/second?auth_key=3333333333333333-4444';
  const m = mockFetch(() => new Response(bytes(text)));
  try {
    const subs = await fetchSubtitleView(1, 2);
    assert.equal(subs.length, 2);
    assert.deepEqual([subs[0].lan, subs[1].lan], ['ai-zh', 'ai-zh']);
    assert.equal(subs[1].lan_doc, 'AI（简中）');
  } finally { m.restore(); }
});

test('biliFetch：wbi 无 wbiKeys 抛错；wbi 签名请求带查询串 + Referer', async () => {
  await assert.rejects(() => biliFetch('/x/some', { wbi: true, params: { a: 1 } }), /wbiKeys required/);
  const m = mockFetch(() => new Response(JSON.stringify({ code: 0, data: { ok: 1 } })));
  try {
    const out = await biliFetch('/x/wbi/test', {
      wbi: true,
      params: { foo: 'bar' },
      wbiKeys: { img_key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sub_key: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    assert.deepEqual(out, { ok: true, data: { ok: 1 } });
    assert.ok(m.reqs[0].url.startsWith('https://api.bilibili.com/x/wbi/test?'), 'wbi 请求须带签名查询串');
    assert.ok(m.reqs[0].url.includes('foo=bar'), '原参数保留在签名串里');
    assert.equal(m.reqs[0].init.headers.Referer, 'https://www.bilibili.com/');
  } finally { m.restore(); }
});

test('biliFetch：非 wbi 参数拼 qs；空参数不加 ?；非 JSON 响应 → malformed', async () => {
  const m = mockFetch(() => new Response(JSON.stringify({ code: 0, data: [] })));
  try {
    await biliFetch('/x/plain', { params: { keyword: '测试' } });
    assert.equal(m.reqs[0].url, 'https://api.bilibili.com/x/plain?keyword=' + encodeURIComponent('测试'));
    await biliFetch('/x/bare');
    assert.equal(m.reqs[1].url, 'https://api.bilibili.com/x/bare');
  } finally { m.restore(); }

  const nj = mockFetch(() => new Response('<html>anti-crawler</html>'));
  try {
    assert.deepEqual(await biliFetch('/x/any'), { ok: false, code: 'malformed', message: 'non-json or missing code' });
  } finally { nj.restore(); }
});
