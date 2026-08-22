// VideoList 筛选 ↔ URLSearchParams 序列化纯函数测试（node 内建 TS type-stripping）
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { videoListFromQuery, videoListToQuery, type VideoListQueryState } from './videoFilterUrl.ts';

const DEFAULTS: VideoListQueryState = {
  q: '', sq: '', source: '', tname: '', tags: [], tagSource: '', lang: '',
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
    q: '关键词', sq: '字幕词', source: 'youtube', tname: '科技', tags: ['游戏', '评测'], tagSource: 'manual',
    lang: 'zh', hasSubtitle: true, dateField: 'published_at',
    sinceDate: '2026-01-01', untilDate: '2026-02-01', minDur: '5', maxDur: '30', minView: '1', maxView: '100',
    sort: 'view', desc: false, page: 3,
  };
  const back = videoListFromQuery(videoListToQuery(s));
  assert.deepEqual(back, s);
});

// ── 多标签筛选（tags=a,b，旧单数 tag= 兼容读入不再写出）──
test('tags 空数组省略不写 query', () => {
  assert.equal(videoListToQuery({ ...DEFAULTS, tags: [] }).get('tags'), null);
});

test('tags 单值：tags=游戏，往返还原单元素数组', () => {
  const u = videoListToQuery({ ...DEFAULTS, tags: ['游戏'] });
  assert.equal(u.get('tags'), '游戏');
  assert.deepEqual(videoListFromQuery(u).tags, ['游戏']);
});

test('tags 多值：tags=a,b 逗号 join，往返还原数组', () => {
  const u = videoListToQuery({ ...DEFAULTS, tags: ['游戏', '评测'] });
  assert.equal(u.get('tags'), '游戏,评测');
  assert.deepEqual(videoListFromQuery(u).tags, ['游戏', '评测']);
});

test('fromQuery 对齐 server 口径：split + trim + 去空段', () => {
  assert.deepEqual(videoListFromQuery(new URLSearchParams('tags=游戏, ,评测,')).tags, ['游戏', '评测']);
});

test('旧单数 tag= 兼容读入（单元素数组）；toQuery 不再写出 tag=', () => {
  assert.deepEqual(videoListFromQuery(new URLSearchParams('tag=游戏')).tags, ['游戏']);
  // 旧参数优先级低于新参数：同在时以 tags 为准（单/复双真相只认复数）
  assert.deepEqual(videoListFromQuery(new URLSearchParams('tag=旧&tags=新')).tags, ['新']);
  assert.equal(videoListToQuery({ ...DEFAULTS, tags: ['游戏'] }).get('tag'), null);
});

test('含逗号标签名序列化时丢弃（server split(\',\') 无法表达的防御）', () => {
  const u = videoListToQuery({ ...DEFAULTS, tags: ['正常', '含,逗号'] });
  assert.equal(u.get('tags'), '正常');
});

test('tags 与 page 联动：序列化层往返两字段都保留（翻页由 useQueryUpdater resetPage 驱动）', () => {
  const s: VideoListQueryState = { ...DEFAULTS, tags: ['游戏', '评测'], page: 3 };
  const back = videoListFromQuery(videoListToQuery(s));
  assert.deepEqual(back.tags, ['游戏', '评测']);
  assert.equal(back.page, 3);
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
