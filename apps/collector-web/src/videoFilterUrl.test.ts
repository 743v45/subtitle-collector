// VideoList 筛选 ↔ URLSearchParams 序列化纯函数测试（node 内建 TS type-stripping）
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { videoListFromQuery, videoListStateToFilter, videoListToQuery, type VideoListQueryState } from './videoFilterUrl.ts';

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

// ── videoListStateToFilter（web query state → server VideoFilter；listVideos 与导出端点共用）──
// 基准：与 VideoList 内联转换逐字段同口径（日期→ms、分钟→秒、万→绝对值、非法数字省略）

test('stateToFilter：空 state → 全 undefined 的 VideoFilter（date_field 保留缺省）', () => {
  assert.deepEqual(videoListStateToFilter(DEFAULTS), {
    q: undefined, source: undefined, subtitle_q: undefined, tname: undefined,
    tags: undefined, tag_source: undefined, lang: undefined, has_subtitle: undefined,
    date_field: 'first_seen', since: undefined, until: undefined,
    min_duration: undefined, max_duration: undefined, min_view: undefined, max_view: undefined,
    sort: undefined, desc: undefined, page: undefined, size: undefined,
  });
});

test('stateToFilter：全量非默认值逐字段映射（日期/时长/播放单位换算 + tags/tag_source 形态）', () => {
  const s: VideoListQueryState = {
    q: '标题词', sq: '字幕词', source: 'youtube', tname: '科技', tags: ['游戏', '评测'], tagSource: 'manual',
    lang: 'zh', hasSubtitle: true, dateField: 'published_at',
    sinceDate: '2026-01-01', untilDate: '2026-01-31', minDur: '5', maxDur: '10', minView: '2', maxView: '3',
    sort: 'duration', desc: false, page: 3,
  };
  assert.deepEqual(videoListStateToFilter(s), {
    q: '标题词', source: 'youtube', subtitle_q: '字幕词', tname: '科技',
    tags: ['游戏', '评测'], tag_source: ['manual'], lang: 'zh', has_subtitle: true,
    date_field: 'published_at',
    since: new Date('2026-01-01T00:00:00').getTime(),
    until: new Date('2026-01-31T23:59:59.999').getTime(),
    min_duration: 300, max_duration: 600, // 分钟 → 秒
    min_view: 20000, max_view: 30000,     // 万 → 绝对值
    sort: 'duration', desc: false,        // desc=false 显式保留（省略会被 server 缺省降序吃掉）
    page: undefined, size: undefined,
  });
});

test('stateToFilter：非法数字（空/NaN）→ 对应字段省略；sort 未选时 desc 不发', () => {
  const f = videoListStateToFilter({ ...DEFAULTS, minDur: 'abc', maxDur: '', minView: 'xyz', maxView: '5', sort: undefined, desc: false });
  assert.equal(f.min_duration, undefined);
  assert.equal(f.max_duration, undefined);
  assert.equal(f.min_view, undefined);
  assert.equal(f.max_view, 50000); // maxView 合法仍映射
  assert.equal(f.sort, undefined);
  assert.equal(f.desc, undefined);
});

test('stateToFilter：page/size 经 opts 透传（列表用；导出端点不传走 server 全量）', () => {
  const f = videoListStateToFilter({ ...DEFAULTS }, { page: 3, size: 20 });
  assert.equal(f.page, 3);
  assert.equal(f.size, 20);
});
