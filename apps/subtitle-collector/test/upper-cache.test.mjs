// apps/subtitle-collector/test/upper-cache.test.mjs
// upperAllCacheHit 纯函数测试：list-upper-videos（WS 路径）复用 popup 全量任务
// storage 缓存（upperAllVideos:{mid}）的命中判定。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upperAllCacheHit } from '../upper-cache.mjs';

const TTL = 3600 * 1000;
const NOW = 10_000_000;
const ITEMS = [
  { bvid: 'BV1', title: 'a', created: 1, play: 10, length: '1:00', pic: null },
  { bvid: 'BV2', title: 'b', created: 2, play: 20, length: '2:00', pic: null },
];

test('命中：done + 无 error + TTL 内 → 返回 {total: items.length, items}（total 对齐条数保证翻页方自然终止）', () => {
  const hit = upperAllCacheHit({ items: ITEMS, total: 999, done: true, error: null, fetchedAt: NOW - TTL + 1 }, TTL, NOW);
  assert.deepEqual(hit, { total: ITEMS.length, items: ITEMS });
});

test('未命中：未完成（done:false 拉取中）/ 带 error（风控中断）/ 超 TTL / 缺 fetchedAt / items 非数组', () => {
  assert.equal(upperAllCacheHit({ items: ITEMS, total: 2, done: false, error: null, fetchedAt: NOW - 1 }, TTL, NOW), null);
  assert.equal(upperAllCacheHit({ items: ITEMS, total: 2, done: true, error: 'arc/search -412', fetchedAt: NOW - 1 }, TTL, NOW), null);
  assert.equal(upperAllCacheHit({ items: ITEMS, total: 2, done: true, error: null, fetchedAt: NOW - TTL }, TTL, NOW), null, '恰好到 TTL 视为过期');
  assert.equal(upperAllCacheHit({ items: ITEMS, total: 2, done: true, error: null }, TTL, NOW), null);
  assert.equal(upperAllCacheHit({ items: 'nope', done: true, error: null, fetchedAt: NOW }, TTL, NOW), null);
  assert.equal(upperAllCacheHit(undefined, TTL, NOW), null, '无缓存键');
  assert.equal(upperAllCacheHit(null, TTL, NOW), null);
});

test('命中：空 items（UP 无视频）也算有效全量结果（total:0 + items:[]）', () => {
  const hit = upperAllCacheHit({ items: [], total: 0, done: true, error: null, fetchedAt: NOW }, TTL, NOW);
  assert.deepEqual(hit, { total: 0, items: [] });
});
