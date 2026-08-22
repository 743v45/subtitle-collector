import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractExtraFromView, buildIngestPayload, normalizeTags, normalizeUrl } from '../ingest-payload.js';

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

test('回归 2026-08-22①：owner.mid 缺失 → creator 不携带 source_uid 字段（禁 unknown 兜底）', () => {
  // 失败形态（旧）：String(view.owner?.mid ?? 'unknown') → 'unknown'，归属不明的视频全部
  // 合并进同一虚构 UP 行（不可逆脏数据）。通过形态（新）：缺失 → 字段不出现在 payload JSON 里，
  // 由 server 侧决定 video.creator_id 置 null（与 server 侧修复的双端契约）。
  const noMid = { ...view, owner: { name: 'up主', face: 'https://face' } }; // owner 在但无 mid
  const p1 = buildIngestPayload(noMid, [], {});
  assert.ok(!('source_uid' in p1.video.creator), 'source_uid 字段不得出现');
  assert.ok(!JSON.stringify(p1.video.creator).includes('source_uid'), 'payload JSON 里不得出现该字段');
  assert.equal(p1.video.creator.name, 'up主'); // name/avatar 不受影响
  const noOwner = { ...view, owner: undefined }; // owner 整体缺失
  const p2 = buildIngestPayload(noOwner, [], {});
  assert.ok(!('source_uid' in p2.video.creator));
  assert.equal(p2.video.creator.name, null);
  // 正常 mid 仍携带且 String 化（mid 为数字）
  assert.equal(buildIngestPayload(view, [], {}).video.creator.source_uid, '99');
});

// ---------------- extractExtraFromView：字段守卫的缺失分支 ----------------

test('extractExtraFromView：null/undefined → 基础三键全 null，其余字段不出现', () => {
  const expect = { aid: null, cid: null, pic: null };
  assert.deepEqual(extractExtraFromView(null), expect);
  assert.deepEqual(extractExtraFromView(undefined), expect);
});

test('extractExtraFromView：空对象 → 所有 if 守卫走缺失分支（不抛错、不发明值）', () => {
  // view 接口部分失败/截断时只剩骨架：desc/ctime/tid/copyright/state/tags/dimension/
  // pages/rights/honor/ugc_season/stat 全缺失 → extra 只有基础三键
  assert.deepEqual(extractExtraFromView({}), { aid: null, cid: null, pic: null });
  // 字段显式 null 视同缺失（!= null 守卫）
  assert.deepEqual(
    extractExtraFromView({ desc: null, ctime: null, tid: null, copyright: null, state: null, stat: null }),
    { aid: null, cid: null, pic: null },
  );
});

test('extractExtraFromView：旧字段名 publocation 兜底（pub_location 缺失时）', () => {
  assert.equal(extractExtraFromView({ publocation: 'IP 广东' }).publocation, 'IP 广东');
  // pub_location 优先于旧名
  assert.equal(extractExtraFromView({ pub_location: '新', publocation: '旧' }).publocation, '新');
  // 两者都缺 → 不带 publocation 键
  assert.ok(!('publocation' in extractExtraFromView({})));
});

test('extractExtraFromView：ugc_season 存在 → 抽 id/title（合集采集链路）', () => {
  const extra = extractExtraFromView({ ugc_season: { id: 717, title: '合集名', episodes: [] } });
  assert.deepEqual(extra.ugc_season, { id: 717, title: '合集名' });
});

test('extractExtraFromView：stat 部分字段缺失 → 缺项 null（不全量信任接口）', () => {
  const extra = extractExtraFromView({ stat: { view: 5 } });
  assert.deepEqual(extra.stat, {
    view: 5, danmaku: null, reply: null, favorite: null, coin: null, share: null,
    like: null, now_rank: null, his_rank: null,
  });
  // view 自身缺失（风控/截断响应）→ 同样 null，不发明 0
  assert.equal(extractExtraFromView({ stat: { like: 7 } }).stat.view, null);
});

test('extractExtraFromView：tags 非数组（脏数据）→ 不落 tags 键', () => {
  assert.ok(!('tags' in extractExtraFromView({ tags: '游戏' })));
  assert.ok(!('tags' in extractExtraFromView({ tags: null })));
});

// ---------------- normalizeUrl ----------------

test('normalizeUrl：//→https: 归一；https 直通；非字符串原样', () => {
  assert.equal(normalizeUrl('//aisubtitle.hdslb.com/x.json'), 'https://aisubtitle.hdslb.com/x.json');
  assert.equal(normalizeUrl('https://a.com/x.json'), 'https://a.com/x.json');
  assert.equal(normalizeUrl('http://a.com/x'), 'http://a.com/x'); // 非 // 前缀不动协议
  assert.equal(normalizeUrl(null), null);   // 字幕轨无 subtitle_url → 保持 null（调用方过滤）
  assert.equal(normalizeUrl(undefined), undefined);
  assert.equal(normalizeUrl(123), 123);
});

// ---------------- buildIngestPayload：缺省/畸形参数分支 ----------------

test('buildIngestPayload paidInfo：打 paid=true + paid_detail（充电/付费专属标注）', () => {
  // 形态对齐 background.js 的 paidInfo 构造（is_upower_exclusive 等）
  const paidInfo = { is_upower_exclusive: true, is_ugc_pay_preview: false, elec_privilege_type: 2 };
  const payload = buildIngestPayload(view, [], {}, null, paidInfo);
  assert.equal(payload.video.extra.paid, true);
  assert.equal(payload.video.extra.paid_detail, paidInfo);
  // 缺省 paidInfo → 不落 paid/paid_detail 键
  const noPaid = buildIngestPayload(view, [], {}).video.extra;
  assert.ok(!('paid' in noPaid));
  assert.ok(!('paid_detail' in noPaid));
});

test('buildIngestPayload duration/pubdate 缺失 → null（不发明值）', () => {
  const payload = buildIngestPayload({ ...view, duration: undefined, pubdate: undefined }, [], {});
  assert.equal(payload.video.duration, null);
  assert.equal(payload.video.published_at, null);
});

test('buildIngestPayload subs 缺省 → tracks:[]（?? [] 兜底）', () => {
  const payload = buildIngestPayload(view);
  assert.deepEqual(payload.tracks, []);
  assert.equal(payload.video.source_vid, 'BV1xx');
});

test('buildIngestPayload 轨道缺 type / 字幕体不在 bodies → track_type null / payload null', () => {
  const subs = [{ lan: 'ai-ZH', lan_doc: '自动生成（中文）', subtitle_url: '//aisubtitle.hdslb.com/miss.json' }];
  const payload = buildIngestPayload(view, subs, {}); // bodies 空 → 该轨 payload null
  assert.equal(payload.tracks.length, 1);
  assert.equal(payload.tracks[0].track_type, null, '无 type → null');
  assert.equal(payload.tracks[0].versions[0].payload, null, 'bodies 缺失 → null（不报脏数据）');
  assert.equal(payload.tracks[0].versions[0].source_url, 'https://aisubtitle.hdslb.com/miss.json');
});
