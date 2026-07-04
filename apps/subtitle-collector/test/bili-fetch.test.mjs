import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBiliResponse, formatSearchResult } from '../bili-fetch.js';

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
  const data = {
    page: { count: 137 },
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

test('parseBiliResponse 缺 code → malformed', () => {
  assert.deepEqual(parseBiliResponse({}), { ok: false, code: 'malformed', message: 'non-json or missing code' });
  assert.deepEqual(parseBiliResponse(null), { ok: false, code: 'malformed', message: 'non-json or missing code' });
});
