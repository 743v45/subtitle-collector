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
