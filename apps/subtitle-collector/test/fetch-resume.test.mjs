import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectStaleFetches, RESUME_GRACE_MS } from '../fetch-resume.mjs';

const NOW = 10_000_000;

test('selectStaleFetches：done:false 且超宽限期 → 选中并给出 prefix/id', () => {
  const all = {
    'ytChannelVideos:UCx': { done: false, error: null, fetchedAt: NOW - RESUME_GRACE_MS - 1 },
    'upperAllVideos:42': { done: false, error: null, fetchedAt: NOW - RESUME_GRACE_MS - 1 },
  };
  assert.deepEqual(selectStaleFetches(all, ['ytChannelVideos:', 'upperAllVideos:'], NOW), [
    { key: 'ytChannelVideos:UCx', prefix: 'ytChannelVideos:', id: 'UCx' },
    { key: 'upperAllVideos:42', prefix: 'upperAllVideos:', id: '42' },
  ]);
});

test('selectStaleFetches：宽限期内（正常慢拉取）不选', () => {
  const all = { 'ytChannelVideos:UCx': { done: false, error: null, fetchedAt: NOW - RESUME_GRACE_MS } };
  assert.deepEqual(selectStaleFetches(all, ['ytChannelVideos:'], NOW), []);
});

test('selectStaleFetches：已完成/带 error 的不选（终态由消费方处理）', () => {
  const all = {
    'ytChannelVideos:UCa': { done: true, error: null, fetchedAt: NOW - RESUME_GRACE_MS - 1 },
    'ytChannelVideos:UCb': { done: false, error: 'arc/search -412', fetchedAt: NOW - RESUME_GRACE_MS - 1 },
  };
  assert.deepEqual(selectStaleFetches(all, ['ytChannelVideos:'], NOW), []);
});

test('selectStaleFetches：非关注前缀 / 非对象值跳过不炸', () => {
  const all = {
    'seasonVideos:3': { done: false, error: null, fetchedAt: 1 },
    clientId: 'abc123',
    'upperAllVideos:x': null,
  };
  assert.deepEqual(selectStaleFetches(all, ['ytChannelVideos:', 'upperAllVideos:'], NOW), []);
});

test('selectStaleFetches：fetchedAt 缺失不选（无据判定中断）', () => {
  const all = { 'upperAllVideos:1': { done: false, error: null } };
  assert.deepEqual(selectStaleFetches(all, ['upperAllVideos:'], NOW), []);
});
