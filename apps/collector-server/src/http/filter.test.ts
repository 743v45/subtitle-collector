// filter.ts 纯函数单测：toInt / parseBool / parseVideoFilter 全参数矩阵（HTTP 层行 100% 但分支洼地）。
// 跑法：cd apps/collector-server && node --test --import tsx src/http/filter.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | toInt / parseBool / parseVideoFilter 合法+非法全参数 | 通过 | 非法一律忽略不抛错 |
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toInt, parseBool, parseVideoFilter } from './filter.js';

test('toInt: null / 空串 → undefined；数字串 → number；非有限 → undefined', () => {
  assert.equal(toInt(null), undefined);
  assert.equal(toInt(''), undefined);
  assert.equal(toInt('42'), 42);
  assert.equal(toInt('-7'), -7);
  assert.equal(toInt('abc'), undefined); // Number('abc') = NaN → 非有限
  assert.equal(toInt('Infinity'), undefined);
});

test('parseBool: true/1/yes 与 false/0/no（大小写不敏感）；其余或缺省 → undefined', () => {
  assert.equal(parseBool(null), undefined);
  assert.equal(parseBool('true'), true);
  assert.equal(parseBool('TRUE'), true);
  assert.equal(parseBool('1'), true);
  assert.equal(parseBool('yes'), true);
  assert.equal(parseBool('false'), false);
  assert.equal(parseBool('0'), false);
  assert.equal(parseBool('No'), false);
  assert.equal(parseBool('maybe'), undefined);
});

test('parseVideoFilter: 全参数合法 → 完整 VideoFilter', () => {
  const f = parseVideoFilter(new URLSearchParams(
    'q=关键词&creator=up名&creator_id=3&creator_uid=42&source=bilibili&tid=17&tname=单机' +
    '&tag=游戏&tags=a,b&tag_source=manual,bili&subtitle_q=正文&lang=zh&track_type=2' +
    '&has_subtitle=true&since=100&until=200&min_duration=10&max_duration=600' +
    '&min_view=100&max_view=5000&date_field=published_at',
  ));
  assert.deepEqual(f, {
    q: '关键词', creator: 'up名', creator_id: 3, creator_uid: '42', source: 'bilibili',
    tid: 17, tname: '单机', tag: '游戏', tags: ['a', 'b'], tag_source: ['manual', 'bili'],
    subtitle_q: '正文', lang: 'zh', track_type: 2, has_subtitle: true,
    since: 100, until: 200, min_duration: 10, max_duration: 600,
    min_view: 100, max_view: 5000, date_field: 'published_at',
  });
});

test('parseVideoFilter: date_field=first_seen 也识别；tags 逗号分隔去空白', () => {
  const f = parseVideoFilter(new URLSearchParams('date_field=first_seen&tags= a , ,b &has_subtitle=no'));
  assert.equal(f.date_field, 'first_seen');
  assert.deepEqual(f.tags, ['a', 'b']);
  assert.equal(f.has_subtitle, false);
});

test('parseVideoFilter: 全参数非法 → 全部忽略（空 filter，不抛错）', () => {
  const f = parseVideoFilter(new URLSearchParams(
    'q=&creator=&creator_uid=&source=&tname=&tag=&subtitle_q=&lang=' +
    '&creator_id=abc&tid=x&track_type=zz&has_subtitle=maybe' +
    '&since=NaN&until=abc&min_duration=x&max_duration=y&min_view=z&max_view=w' +
    '&tags=,,&tag_source=bogus&date_field=bogus',
  ));
  // tags=,, → split 后全被 filter(Boolean) 滤掉 → 不设；tag_source=bogus → 全滤掉 → 不设
  assert.deepEqual(f, {});
});

test('parseVideoFilter: tag_source 混合非法档 → 只留合法子集', () => {
  const f = parseVideoFilter(new URLSearchParams('tag_source=bogus,ai,season'));
  assert.deepEqual(f.tag_source, ['ai', 'season']);
});

test('parseVideoFilter: 空入参 → 空 filter', () => {
  assert.deepEqual(parseVideoFilter(new URLSearchParams()), {});
});
