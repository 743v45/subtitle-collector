import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneExpired } from '../storage-prune.mjs';

function mockStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries(data);
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k); },
  };
}

const TTL = 3600 * 1000;
const NOW = 10_000_000;

test('pruneExpired：删前缀内 done 且超 TTL 的键，返回删除数', async () => {
  const st = mockStorage({
    'ytChannelVideos:UCa': { done: true, fetchedAt: NOW - TTL - 1, items: [] },   // 过期 → 删
    'ytChannelVideos:UCb': { done: true, fetchedAt: NOW - TTL + 1000, items: [] }, // TTL 内 → 留
    'ytChannelVideos:UCc': { done: false, fetchedAt: NOW - TTL - 1, items: [] },   // 中间态 → 留（恢复逻辑要看）
    'ytChannelVideos:UCd': { done: true, error: 'x', fetchedAt: NOW - TTL - 1 },   // 过期失败缓存 → 删
    'seasonVideos:7': { done: true, fetchedAt: NOW - TTL - 1 },                    // 其它前缀 → 留
    upperInfoAt: '12345',                                                          // 非对象值 → 留
    clientId: 'abc123',
  });
  const n = await pruneExpired(st, 'ytChannelVideos:', TTL, NOW);
  assert.equal(n, 2);
  assert.ok(!st.data.has('ytChannelVideos:UCa'));
  assert.ok(!st.data.has('ytChannelVideos:UCd'));
  assert.ok(st.data.has('ytChannelVideos:UCb'));
  assert.ok(st.data.has('ytChannelVideos:UCc'));
  assert.ok(st.data.has('seasonVideos:7'));
  assert.ok(st.data.has('upperInfoAt'));
});

test('pruneExpired：无过期键时不发 remove（零删除返回 0）', async () => {
  const st = mockStorage({ 'seasonVideos:1': { done: true, fetchedAt: NOW - 10 } });
  const n = await pruneExpired(st, 'seasonVideos:', TTL, NOW);
  assert.equal(n, 0);
  assert.ok(st.data.has('seasonVideos:1'));
});

test('pruneExpired：fetchedAt 缺失/非数字不删（坏数据保守保留）', async () => {
  const st = mockStorage({
    'upperAllVideos:9': { done: true },
    'upperAllVideos:8': { done: true, fetchedAt: 'oops' },
  });
  const n = await pruneExpired(st, 'upperAllVideos:', TTL, NOW);
  assert.equal(n, 0);
});

test('pruneExpired：前缀内非对象值（字符串/数字/null）保守保留', async () => {
  // 同前缀下可能混存其它类型的键（如手写的标记/时间戳）：v == null || typeof !== 'object' → 不删
  const st = mockStorage({
    'ytChannelVideos:str': '1680000000000',
    'ytChannelVideos:num': 42,
    'ytChannelVideos:nul': null,
  });
  const n = await pruneExpired(st, 'ytChannelVideos:', TTL, NOW);
  assert.equal(n, 0);
  assert.ok(st.data.has('ytChannelVideos:str'));
  assert.ok(st.data.has('ytChannelVideos:num'));
  assert.ok(st.data.has('ytChannelVideos:nul'));
});

test('pruneExpired：恰好等于 TTL（未超过）不删（> 严格比较）', async () => {
  const st = mockStorage({ 'seasonVideos:eql': { done: true, fetchedAt: NOW - TTL } });
  assert.equal(await pruneExpired(st, 'seasonVideos:', TTL, NOW), 0);
  assert.ok(st.data.has('seasonVideos:eql'));
});
