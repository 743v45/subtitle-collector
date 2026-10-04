// subSearchFilterUrl 纯函数测试：fromQuery 解析 / toQuery 序列化 / 默认值省略 / roundtrip。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 默认解析 + 全量序列化 + roundtrip + ctx 默认省略 | 通过 | |
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SUB_SEARCH_DEFAULTS, subSearchFromQuery, subSearchToQuery } from './subSearchFilterUrl';

test('fromQuery：空 query → 全默认（regex/case 关、ctx 10）', () => {
  const s = subSearchFromQuery(new URLSearchParams());
  assert.deepEqual(s, SUB_SEARCH_DEFAULTS);
});

test('fromQuery：全量参数解析（regex=1/case=1/ctx/source/creator）', () => {
  const s = subSearchFromQuery(new URLSearchParams('kw=%E6%B5%B7&regex=1&case=1&ctx=15&source=youtube&creator=U%E4%B8%BB'));
  assert.equal(s.kw, '海');
  assert.equal(s.regex, true);
  assert.equal(s.caseSensitive, true);
  assert.equal(s.ctx, '15');
  assert.equal(s.source, 'youtube');
  assert.equal(s.creator, 'U主');
});

test('toQuery：默认态 → 空 query（URL 干净）', () => {
  assert.equal(subSearchToQuery(SUB_SEARCH_DEFAULTS).toString(), '');
});

test('toQuery：非默认逐项写出（ctx≠10 才写）', () => {
  const u = subSearchToQuery({ kw: '海', regex: true, caseSensitive: true, ctx: '15', source: 'douyin', creator: '某人' });
  assert.equal(u.get('kw'), '海');
  assert.equal(u.get('regex'), '1');
  assert.equal(u.get('case'), '1');
  assert.equal(u.get('ctx'), '15');
  assert.equal(u.get('source'), 'douyin');
  assert.equal(u.get('creator'), '某人');
});

test('toQuery：ctx=10（默认）省略不写', () => {
  const u = subSearchToQuery({ ...SUB_SEARCH_DEFAULTS, kw: 'x', ctx: '10' });
  assert.equal(u.has('ctx'), false);
  assert.equal(u.get('kw'), 'x');
});

test('roundtrip：fromQuery(toQuery) 恒等（默认项除外）', () => {
  const s = { kw: 'a(b)', regex: false, caseSensitive: true, ctx: '3', source: 'bilibili', creator: '' };
  const back = subSearchFromQuery(subSearchToQuery(s));
  assert.deepEqual(back, { ...s, creator: '' });
});
