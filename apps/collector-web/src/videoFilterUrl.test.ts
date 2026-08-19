// VideoList 筛选 ↔ URLSearchParams 序列化纯函数测试（node 内建 TS type-stripping）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoListFromQuery, videoListToQuery, type VideoListQueryState } from './videoFilterUrl.ts';

const DEFAULTS: VideoListQueryState = {
  q: '', sq: '', source: '', tname: '', tag: '', tagSource: '', lang: '',
  hasSubtitle: false, dateField: 'first_seen',
  sinceDate: '', untilDate: '', minDur: '', maxDur: '', minView: '', maxView: '',
  sort: undefined, desc: true, page: 1,
};

test('videoListFromQuery：空 query → 全默认', () => {
  assert.deepEqual(videoListFromQuery(new URLSearchParams('')), DEFAULTS);
});

test('videoListToQuery：默认值 → 空串（空值省略，URL 干净）', () => {
  assert.equal(videoListToQuery(DEFAULTS).toString(), '');
});

test('roundtrip：全量非默认值 → query → 还原相等', () => {
  const s: VideoListQueryState = {
    q: '关键词', sq: '字幕词', source: 'youtube', tname: '科技', tag: '游戏', tagSource: 'manual',
    lang: 'zh', hasSubtitle: true, dateField: 'published_at',
    sinceDate: '2026-01-01', untilDate: '2026-02-01', minDur: '5', maxDur: '30', minView: '1', maxView: '100',
    sort: 'view', desc: false, page: 3,
  };
  const back = videoListFromQuery(videoListToQuery(s));
  assert.deepEqual(back, s);
});

test('desc=false 写 desc=0；desc=true（默认）不写', () => {
  assert.equal(videoListToQuery({ ...DEFAULTS, sort: 'view', desc: false }).get('desc'), '0');
  assert.equal(videoListToQuery({ ...DEFAULTS, sort: 'view', desc: true }).get('desc'), null);
});

test('hasSubtitle=true 写 has_subtitle=1；false 不写', () => {
  assert.equal(videoListToQuery({ ...DEFAULTS, hasSubtitle: true }).get('has_subtitle'), '1');
  assert.equal(videoListToQuery({ ...DEFAULTS, hasSubtitle: false }).get('has_subtitle'), null);
});

test('page 非法容错：非数字 / <=1 → 1', () => {
  assert.equal(videoListFromQuery(new URLSearchParams('page=abc')).page, 1);
  assert.equal(videoListFromQuery(new URLSearchParams('page=-2')).page, 1);
  assert.equal(videoListFromQuery(new URLSearchParams('page=0')).page, 1);
  assert.equal(videoListFromQuery(new URLSearchParams('page=7')).page, 7);
});

test('dateField 非法值回落 first_seen', () => {
  assert.equal(videoListFromQuery(new URLSearchParams('date_field=bogus')).dateField, 'first_seen');
  assert.equal(videoListFromQuery(new URLSearchParams('date_field=published_at')).dateField, 'published_at');
});

test('sort 非法值回落 undefined', () => {
  assert.equal(videoListFromQuery(new URLSearchParams('sort=bogus')).sort, undefined);
  assert.equal(videoListFromQuery(new URLSearchParams('sort=duration')).sort, 'duration');
});
