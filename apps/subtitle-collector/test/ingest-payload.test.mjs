import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractExtraFromView, buildIngestPayload, normalizeTags } from '../ingest-payload.js';

const view = {
  bvid: 'BV1xx', aid: 11, cid: 22, title: '标题', pic: 'https://pic',
  desc: '简介', ctime: 1700000000, pubdate: 1700000000, tid: 17, tname: '单机游戏',
  copyright: 1, state: 0, pub_location: 'IP 上海',
  tags: [{ tag_id: 1, tag_name: '游戏' }], dimension: { width: 1920, height: 1080, rotate: 0 },
  pages: [{ cid: 22, page: 1, part: 'P1', duration: 120 }],
  rights: { download: 1 }, honor_reply: { honor: [] }, ugc_season: null,
  stat: { view: 10, danmaku: 1, reply: 2, favorite: 3, coin: 4, share: 5, like: 6, now_rank: 0, his_rank: 0 },
  duration: 120, owner: { mid: 99, name: 'up主', face: 'https://face' },
};

test('extractExtraFromView 抽齐 extra 字段', () => {
  const extra = extractExtraFromView(view);
  assert.equal(extra.aid, 11);
  assert.equal(extra.cid, 22);
  assert.equal(extra.pic, 'https://pic');
  assert.equal(extra.desc, '简介');
  assert.equal(extra.tid, 17);
  // tname 不再由扩展抽取（view API 的 tname 恒空串），改由 server 用 zones 字典按 tid 反查 enrich
  assert.equal(extra.tname, undefined);
  assert.equal(extra.publocation, 'IP 上海');
  assert.deepEqual(extra.tags, [{ tag_id: 1, tag_name: '游戏' }]);
  assert.equal(extra.stat.view, 10);
});

test('buildIngestPayload 组装完整 payload（含轨+版本）', () => {
  const subs = [{ lan: 'zh-Hans', lan_doc: '简体中文', type: 2, subtitle_url: '//aisubtitle.hdslb.com/x.json' }];
  const bodies = { 'https://aisubtitle.hdslb.com/x.json': { body: [{ from: 0, to: 1, content: '字' }] } };
  const payload = buildIngestPayload(view, subs, bodies);
  assert.equal(payload.source, 'bilibili');
  assert.equal(payload.video.source_vid, 'BV1xx');
  assert.equal(payload.video.title, '标题');
  assert.equal(payload.video.creator.name, 'up主');
  assert.equal(payload.video.creator.avatar, 'https://face');
  assert.equal(payload.video.duration, 120);
  assert.equal(payload.video.published_at, 1700000000000);
  assert.equal(payload.tracks.length, 1);
  assert.equal(payload.tracks[0].lan, 'zh-Hans');
  assert.equal(payload.tracks[0].versions[0].origin, 'external');
  assert.deepEqual(payload.tracks[0].versions[0].payload, { body: [{ from: 0, to: 1, content: '字' }] });
});

test('buildIngestPayload 无字幕 → tracks:[]', () => {
  const payload = buildIngestPayload(view, [], {});
  assert.deepEqual(payload.tracks, []);
  assert.equal(payload.video.source_vid, 'BV1xx'); // video 仍组装
});

test('normalizeTags 规整 /x/tag/archive/tags 响应 data → [{tag_id,tag_name}]', () => {
  // 真实接口 data 元素含大量额外字段，只取 tag_id/tag_name（对齐 extra.tags schema）
  const data = [
    { tag_id: 1, tag_name: '游戏', cover: '', type: 3, likes: 5, hated: 0 },
    { tag_id: 2, tag_name: '实况', cover: 'x', count: 10 },
  ];
  assert.deepEqual(normalizeTags(data), [{ tag_id: 1, tag_name: '游戏' }, { tag_id: 2, tag_name: '实况' }]);
  assert.deepEqual(normalizeTags(undefined), []); // 接口失败兜底
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags('not-array'), []);
  assert.deepEqual(normalizeTags([]), []);
});

test('buildIngestPayload tags 参数覆盖 extra.tags（主动路径 /x/tag/archive/tags）', () => {
  // view 响应不含 tags（对齐 /x/web-interface/view 实际），由 background 单独抓标签传入
  const viewNoTags = { ...view, tags: undefined };
  const tags = [{ tag_id: 7, tag_name: '科技' }, { tag_id: 8, tag_name: '数码' }];
  const payload = buildIngestPayload(viewNoTags, [], {}, tags);
  assert.deepEqual(payload.video.extra.tags, tags);
});

test('buildIngestPayload tags 为空/缺省 → 不覆盖 extractExtraFromView 的 tags', () => {
  // 缺省：保留 view 自带 tags
  assert.deepEqual(buildIngestPayload(view, [], {}).video.extra.tags, [{ tag_id: 1, tag_name: '游戏' }]);
  // 空数组：主动路径接口失败时 tags=[]，保留 view 自带 tags（不写成空）
  assert.deepEqual(buildIngestPayload(view, [], {}, []).video.extra.tags, [{ tag_id: 1, tag_name: '游戏' }]);
  // view 无 tags 且未传 → extra 不含 tags 键
  const viewNoTags = { ...view, tags: undefined };
  assert.ok(!('tags' in buildIngestPayload(viewNoTags, [], {}).video.extra));
});
