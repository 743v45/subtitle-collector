// test/douyin-payload.test.mjs
// 抖音 ingest payload 组装回归（对齐 test/youtube-payload.test.mjs 形态）。
// 覆盖：字段映射（aweme_id/sec_uid/desc）、duration 毫秒→秒、published_at create_time×1000、
// extra.stat 键对齐 B 站（R5 定案）、tags（text_extra 映射）、ugc_season（mix_info，无 mix 不带）、
// play_uri/cover/music/dimension、图集 not_video 判定（isDouyinVideo）、字幕轨 track_type 映射、
// profile → ingest-upper creator 映射。
// 数据口径：docs/plans/douyin/spike-findings.md §1.3（XHR aweme_detail 实测样例，_spike-raw/）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDouyinPayload,
  douyinCreatorFromProfile,
  isDouyinVideo,
  pickDouyinAvatarUrl,
} from '../douyin-payload.js';

// 测试轮次记录（对齐项目 CLAUDE.md §3 / RULES §5）
// | 轮次 | 日期       | 范围                         | 结果 | 备注                                  |
// |------|------------|------------------------------|------|---------------------------------------|
// | T1   | 2026-08-29 | S3 抖音 payload 组装（纯函数）| PASS | `pnpm --dir apps/subtitle-collector test` 全绿（覆盖率锁定达标） |
// | T2   | 2026-08-29 | S8 台账性重构（extra/tracks 拆片段函数，表达式原样搬移） | PASS | 同上命令全绿；T1 断言全数保持（不改行为） |

// 共享 fixture：snake_case aweme_detail（字段取自 _spike-raw/detail-response.network-response 实测样例）
const awemeDetail = {
  aweme_id: '7678956479035512448',
  desc: '英语学习的秘诀 #英语学习 #英语怎么学',
  caption: '英语学习的秘诀 #英语学习 #英语怎么学',
  aweme_type: 0,
  is_subtitled: 0,
  cla_info: null,
  create_time: 1787896381,
  duration: 47948, // 顶层毫秒（与 video.duration 同值）
  author: {
    sec_uid: 'MS4wLjABAAAAZmAOLwOo_Lp1EwVS_LjPNAeBEU9niZs64gYeEmE3sqvJ_5vzXNoJXMbgf9wcZkh0',
    nickname: '英语规划提分姬老师',
    avatar_thumb: { url_list: ['https://p3-pc-sign.douyinpic.com/avatar.jpg'] },
    follower_count: 13226,
    custom_verify: '',
  },
  statistics: { play_count: 0, digg_count: 28, comment_count: 4, share_count: 8, collect_count: 16 },
  region: 'CN',
  is_top: 0,
  is_ads: false,
  share_url: 'https://www.iesdouyin.com/share/video/7678956479035512448/',
  video: {
    duration: 47948,
    play_addr: { uri: 'v0300fg10000da8i3knog65s9j5g544g', url_list: ['https://v26-web.douyinvod.com/x.mp4'] },
    cover: { url_list: ['https://p3-pc-sign.douyinpic.com/cover.jpg'] },
    origin_cover: { url_list: ['https://p3-pc-sign.douyinpic.com/origin.jpg'] },
    dynamic_cover: { url_list: ['https://p3-pc-sign.douyinpic.com/dynamic.webp'] },
    ratio: '720p',
    format: 'mp4',
    is_h265: 0,
    is_source_HDR: 0,
  },
  text_extra: [
    { hashtag_id: '1587111396494349', hashtag_name: '英语学习', start: 19, end: 24, type: 1 },
    { hashtag_id: '1661560280243207', hashtag_name: '英语怎么学', start: 25, end: 31, type: 1 },
    { start: 0, end: 5, type: 0 }, // 非 hashtag 项过滤
    { hashtag_name: '', type: 1 }, // 空 hashtag_name 过滤
  ],
  mix_info: null,
  music: { id: 7678956457940781865, id_str: '7678956457940781865', title: '@英语规划提分姬老师创作的原声' },
};

test('buildDouyinPayload：基本字段映射（source_vid/title/creator/duration 毫秒→秒/published_at 秒→ms）', () => {  const p = buildDouyinPayload(awemeDetail, [], {});
  assert.equal(p.source, 'douyin');
  assert.equal(p.video.source_vid, '7678956479035512448');
  // 抖音无独立标题字段，desc 即标题（caption 同文兜底）
  assert.equal(p.video.title, '英语学习的秘诀 #英语学习 #英语怎么学');
  assert.equal(p.video.creator.source_uid, 'MS4wLjABAAAAZmAOLwOo_Lp1EwVS_LjPNAeBEU9niZs64gYeEmE3sqvJ_5vzXNoJXMbgf9wcZkh0');
  assert.equal(p.video.creator.name, '英语规划提分姬老师');
  assert.equal(p.video.creator.avatar, 'https://p3-pc-sign.douyinpic.com/avatar.jpg');
  // duration 毫秒→秒（47948ms → 47.948s，与 B 站 duration 秒口径对齐）
  assert.equal(p.video.duration, 47.948);
  // create_time unix 秒 ×1000 → ms（对齐 B 站 pubdate×1000 口径）
  assert.equal(p.video.published_at, 1787896381000);
  assert.deepEqual(p.tracks, []);
});

test('buildDouyinPayload：extra.stat 键对齐 B 站（view←play_count 照存 0/like←digg/reply←comment/share/favorite←collect）', () => {
  const p = buildDouyinPayload(awemeDetail, [], {});
  // play_count web 端恒 0（S1 实测）：照存 0（结构对齐优先），web 展示 — 由 S5 处理
  assert.deepEqual(p.video.extra.stat, { view: 0, like: 28, reply: 4, share: 8, favorite: 16 });
});

test('buildDouyinPayload：2026-08-29 字段增强——region/is_top/is_ads/share_url/video_quality/creator.fans；缺失不带键', () => {
  const p = buildDouyinPayload(awemeDetail, [], {});
  const e = p.video.extra;
  assert.equal(e.region, 'CN', 'region 落库');
  assert.equal(e.is_top, 0, 'is_top 落库');
  assert.equal(e.is_ads, false, 'is_ads 落库');
  assert.equal(e.share_url, 'https://www.iesdouyin.com/share/video/7678956479035512448/', 'share_url 原样留存');
  assert.deepEqual(e.video_quality, { ratio: '720p', format: 'mp4', is_h265: 0, is_source_HDR: 0 }, 'video_quality 四键');
  assert.equal(p.video.creator.fans, 13226, 'creator.fans←follower_count');
  assert.equal(p.video.creator.verify, undefined, 'custom_verify 空串不带 verify 键');
  assert.equal(e.chapters, undefined, 'chapter_list 缺失不带 chapters 键');

  // verify 双来源短路:custom_verify 非空直取;空串回落 enterprise_verify_reason
  const verified = buildDouyinPayload({ ...awemeDetail, author: { ...awemeDetail.author, custom_verify: '音乐人' } }, [], {});
  assert.equal(verified.video.creator.verify, '音乐人', 'custom_verify 非空 → verify');
  const entVerified = buildDouyinPayload({ ...awemeDetail, author: { ...awemeDetail.author, custom_verify: '', enterprise_verify_reason: '企业号' } }, [], {});
  assert.equal(entVerified.video.creator.verify, '企业号', 'custom_verify 空串 → enterprise_verify_reason 兜底');

  // 缺失形态：全删新字段 → 不带键不炸
  const bare = buildDouyinPayload({
    aweme_id: '1', desc: 'd', aweme_type: 0, create_time: 1, duration: 1000,
    author: { sec_uid: 's', nickname: 'n' }, statistics: {}, video: { duration: 1000 },
  }, [], {});
  assert.equal(bare.video.extra.region, undefined);
  assert.equal(bare.video.extra.video_quality, undefined);
  assert.equal(bare.video.creator.fans, undefined);

  // chapters 有值形态（结构未实测,按 title/start_time 映射）
  const withChapters = buildDouyinPayload({
    ...awemeDetail, chapter_list: [{ title: '第一章', start_time: 0 }, { title: '第二章', start_time: 60000 }],
  }, [], {});
  assert.deepEqual(withChapters.video.extra.chapters, [{ title: '第一章', start: 0 }, { title: '第二章', start: 60000 }]);
});

test('buildDouyinPayload：字段缺失形态兜底——hashtag_id null/mix 无 desc/music 无 id_str/半 video_quality/chapters 多键名', () => {
  const p = buildDouyinPayload({
    ...awemeDetail,
    text_extra: [{ hashtag_name: '无id话题', type: 1 }],        // hashtag_id 缺 → null
    mix_info: { mix_id: 'mix1' },                               // 无 mix_desc → title null
    music: { id: 123, title: null },                            // 无 id_str → String(id) 兜底
    video: { duration: 47948, ratio: '1080p' },                 // 有 ratio 无 format → 后续键 null
    chapter_list: [{ title: 'c1' }, { startTime: 5 }, { start: 9 }], // 三种时间键名兜底链
  }, null, {});                                                 // captionTracks null → ?? [] 兜底
  assert.deepEqual(p.video.extra.tags, [{ tag_id: null, tag_name: '无id话题' }]);
  assert.deepEqual(p.video.extra.ugc_season, { id: 'mix1', title: null });
  assert.deepEqual(p.video.extra.music, { id: '123', title: null });
  assert.deepEqual(p.video.extra.video_quality, { ratio: '1080p', format: null, is_h265: null, is_source_HDR: null });
  assert.deepEqual(p.video.extra.chapters, [
    { title: 'c1', start: null }, { title: null, start: 5 }, { title: null, start: 9 },
  ]);
  assert.equal(p.tracks.length, 0, 'captionTracks null → 空数组');
});

test('buildDouyinPayload：text_extra → tags[{tag_id,tag_name}]（type=1 且有 hashtag_name 才收）', () => {
  const p = buildDouyinPayload(awemeDetail, [], {});
  assert.deepEqual(p.video.extra.tags, [
    { tag_id: '1587111396494349', tag_name: '英语学习' },
    { tag_id: '1661560280243207', tag_name: '英语怎么学' },
  ]);
});

test('buildDouyinPayload：无 mix_info → 不带 ugc_season 键；有 → {id:mix_id,title:mix_desc}（R5 同键名）', () => {
  const noMix = buildDouyinPayload(awemeDetail, [], {});
  assert.ok(!('ugc_season' in noMix.video.extra), 'mix_info=null 不带 ugc_season');
  const withMix = buildDouyinPayload({
    ...awemeDetail,
    mix_info: { mix_id: '7123456789012345678', mix_desc: '英语全系列' },
  }, [], {});
  assert.deepEqual(withMix.video.extra.ugc_season, { id: '7123456789012345678', title: '英语全系列' });
});

test('buildDouyinPayload：play_uri/aweme_type/cover 三件/music（id_str 优先）', () => {
  const p = buildDouyinPayload(awemeDetail, [], {});
  assert.equal(p.video.extra.play_uri, 'v0300fg10000da8i3knog65s9j5g544g');
  assert.equal(p.video.extra.aweme_type, 0);
  assert.equal(p.video.extra.cover, 'https://p3-pc-sign.douyinpic.com/cover.jpg');
  assert.equal(p.video.extra.origin_cover, 'https://p3-pc-sign.douyinpic.com/origin.jpg');
  assert.equal(p.video.extra.dynamic_cover, 'https://p3-pc-sign.douyinpic.com/dynamic.webp');
  // music.id 是 76.8e18 数字（超 JS 安全整数），归一优先字符串形态 id_str
  assert.equal(p.video.extra.music.id, '7678956457940781865');
  assert.equal(p.video.extra.music.title, '@英语规划提分姬老师创作的原声');
});

test('buildDouyinPayload：dimension 缺（实测 XHR 形态为 null）不带键；有则 {width,height,rotate}', () => {
  const noDim = buildDouyinPayload(awemeDetail, [], {});
  assert.ok(!('dimension' in noDim.video.extra), '实测样例 video.dimension=null → 不带键');
  const withDim = buildDouyinPayload({
    ...awemeDetail,
    video: { ...awemeDetail.video, dimension: { width: 1080, height: 1920, rotate: 0 } },
  }, [], {});
  assert.deepEqual(withDim.video.extra.dimension, { width: 1080, height: 1920, rotate: 0 });
});

test('isDouyinVideo：aweme_type===0 → true；图集（≠0）→ false（R3 范围外）', () => {
  assert.equal(isDouyinVideo(awemeDetail), true);
  assert.equal(isDouyinVideo({ ...awemeDetail, aweme_type: 2 }), false);
  assert.equal(isDouyinVideo({ ...awemeDetail, aweme_type: 150 }), false);
  assert.equal(isDouyinVideo(null), false, '缺 aweme_type 不当视频（保守不入库）');
});

test('buildDouyinPayload：字幕轨 track_type 映射（智能字幕=1/AI；明确人工=2）+ body 缺失轨 payload=null', () => {
  const tracks = [
    { lan: 'zh', lan_doc: '中文（自动生成）', url: 'https://creator.douyin.com/caption/zh.json', is_auto: true },
    { lan: 'en', lan_doc: 'English', url: 'https://creator.douyin.com/caption/en.json', is_auto: false },
  ];
  const bodies = {
    'https://creator.douyin.com/caption/zh.json': { body: [{ from: 0, to: 1.5, content: '大家好' }] },
  };
  const p = buildDouyinPayload(awemeDetail, tracks, bodies);
  assert.equal(p.tracks.length, 2);
  assert.equal(p.tracks[0].lan, 'zh');
  assert.equal(p.tracks[0].track_type, 1, '智能字幕（自动生成）→ 1（B 站 AI/asr 同义）');
  assert.deepEqual(p.tracks[0].versions[0].payload, { body: [{ from: 0, to: 1.5, content: '大家好' }] });
  assert.equal(p.tracks[0].versions[0].source_url, 'https://creator.douyin.com/caption/zh.json');
  assert.equal(p.tracks[0].versions[0].origin, 'external');
  assert.equal(p.tracks[1].track_type, 2, '明确人工 → 2（CC/manual）');
  assert.equal(p.tracks[1].versions[0].payload, null, '无 body 的轨 payload=null（server 侧跳过）');
});

test('buildDouyinPayload：sec_uid 缺失 → creator 不携带 source_uid 字段（禁 unknown 兜底，2026-08-22 契约）', () => {
  const p = buildDouyinPayload({ ...awemeDetail, author: { nickname: 'n' } }, [], {});
  assert.ok(!('source_uid' in p.video.creator));
  assert.ok(!JSON.stringify(p.video.creator).includes('source_uid'));
  // 空串同缺失
  const empty = buildDouyinPayload({ ...awemeDetail, author: { sec_uid: '', nickname: 'n' } }, [], {});
  assert.ok(!('source_uid' in empty.video.creator));
});

test('buildDouyinPayload：duration/create_time 缺失或非法 → null（不发明值）', () => {
  const p = buildDouyinPayload({ aweme_id: '1', desc: 'd', author: { sec_uid: 's' } }, [], {});
  assert.equal(p.video.duration, null);
  assert.equal(p.video.published_at, null);
  // 字符串形态 create_time 不收（防脏值），number 才转
  const p2 = buildDouyinPayload({ ...awemeDetail, create_time: '1787896381' }, [], {});
  assert.equal(p2.video.published_at, null);
});

test('pickDouyinAvatarUrl：{url_list} 形态 / 裸字符串（SSR 未实测形态）/ avatar_uri 兜底', () => {
  assert.equal(pickDouyinAvatarUrl({ avatar_thumb: { url_list: ['https://a/1.jpg'] } }), 'https://a/1.jpg');
  assert.equal(pickDouyinAvatarUrl({ avatar_thumb: 'https://a/2.jpg' }), 'https://a/2.jpg');
  assert.equal(pickDouyinAvatarUrl({ avatar_thumb: {}, avatar_uri: 'https://a/3.jpg' }), 'https://a/3.jpg');
  assert.equal(pickDouyinAvatarUrl({}), null);
  assert.equal(pickDouyinAvatarUrl(null), null);
});

test('douyinCreatorFromProfile：profile/other user → ingest-upper creator（follower_count 字符串容错）', () => {
  // fixture 取自 _spike-raw/profile-other-response.network-response（follower_count 实测两种类型都出现）
  const creator = douyinCreatorFromProfile({
    sec_uid: 'MS4wLjABAAAA6fLul78DB4jAxgf_of2FevRnLmLAngzB9AiWiz1G98',
    nickname: '洛克影视',
    signature: '🌈每日更新精彩影视',
    follower_count: '4142731', // 字符串形态（spike §1.4⑥）
    following_count: 239,
    avatar_thumb: { url_list: ['https://p3-pc.douyinpic.com/aweme-avatar/a.jpg'] },
  });
  assert.deepEqual(creator, {
    source_uid: 'MS4wLjABAAAA6fLul78DB4jAxgf_of2FevRnLmLAngzB9AiWiz1G98',
    name: '洛克影视',
    avatar: 'https://p3-pc.douyinpic.com/aweme-avatar/a.jpg',
    sign: '🌈每日更新精彩影视',
    fans: 4142731,
    following: 239,
  });
});

test('douyinCreatorFromProfile：缺 sec_uid → null（不造脏 creators 行）', () => {
  assert.equal(douyinCreatorFromProfile({ nickname: 'n' }), null);
  assert.equal(douyinCreatorFromProfile(null), null);
});

// ---- 防御分支（覆盖率锁定：脏值/缺省形态不抛错、不发明值）----
test('buildDouyinPayload：入参 null / 全缺省 → 空壳 payload 不抛错；captionTracks 缺省 → tracks=[]', () => {
  const p = buildDouyinPayload(null);
  assert.equal(p.source, 'douyin');
  assert.equal(p.video.source_vid, null);
  assert.equal(p.video.title, null);
  assert.equal(p.video.duration, null);
  assert.equal(p.video.published_at, null);
  assert.deepEqual(p.tracks, []);
  // captionTracks/captionBodies 不传（?? 兜底）
  assert.deepEqual(buildDouyinPayload(awemeDetail).tracks, []);
});

test('buildDouyinPayload：aweme_id 数字形态 String 化；title 回落 caption；顶层 duration 兜底（video 缺）', () => {
  const p = buildDouyinPayload({
    aweme_id: 76789564790, // 数字形态（安全范围内；真实 19 位超 double 精度由 id_str 类字符串键规避）
    desc: null,
    caption: 'caption 兜底标题',
    duration: 47948, // video 缺 → 顶层 duration 兜底
    author: { sec_uid: 123 }, // 非字符串 sec_uid 视同缺失
  }, [], {});
  assert.equal(p.video.source_vid, '76789564790');
  assert.equal(p.video.title, 'caption 兜底标题');
  assert.equal(p.video.duration, 47.948);
  assert.ok(!('source_uid' in p.video.creator), '数字 sec_uid 不当标识');
});

test('buildDouyinPayload：duration 非数（NaN/Infinity）→ null；cover 形态脏值 → null', () => {
  const p = buildDouyinPayload({
    ...awemeDetail,
    video: {
      ...awemeDetail.video,
      duration: NaN,
      cover: { url_list: [] }, // 空列表 → null
      origin_cover: { url_list: [123] }, // 非字符串首项 → null
      dynamic_cover: { url_list: null }, // null 列表 → null
    },
  }, [], {});
  assert.equal(p.video.duration, null);
  assert.equal(p.video.extra.cover, null);
  assert.equal(p.video.extra.origin_cover, null);
  assert.equal(p.video.extra.dynamic_cover, null);
});

test('buildDouyinPayload：dimension 字段缺省 → 各键 null（不发明值）', () => {
  const p = buildDouyinPayload({
    ...awemeDetail,
    video: { ...awemeDetail.video, dimension: {} },
  }, [], {});
  assert.deepEqual(p.video.extra.dimension, { width: null, height: null, rotate: null });
});

test('buildDouyinPayload：stat 字符串数字 / 脏字符串 → Number 化或 null（follower_count 字符串形态同口径）', () => {
  const p = buildDouyinPayload({
    ...awemeDetail,
    statistics: { play_count: '123', digg_count: 'abc', comment_count: '', share_count: 7, collect_count: Infinity },
  }, [], {});
  assert.deepEqual(p.video.extra.stat, { view: 123, like: null, reply: null, share: 7, favorite: null });
});

test('buildDouyinPayload：music 缺 id（id_str/id 都无）→ music.id=null；无 music 对象不带键', () => {
  const p = buildDouyinPayload({ ...awemeDetail, music: { title: 't' } }, [], {});
  assert.deepEqual(p.video.extra.music, { id: null, title: 't' });
  const noMusic = buildDouyinPayload({ ...awemeDetail, music: null }, [], {});
  assert.ok(!('music' in noMusic.video.extra));
});

test('pickDouyinAvatarUrl：url_list 空列表 / 首项非字符串 → 兜底链继续或 null', () => {
  assert.equal(pickDouyinAvatarUrl({ avatar_thumb: { url_list: [] }, avatar_uri: 'https://a/3.jpg' }), 'https://a/3.jpg');
  assert.equal(pickDouyinAvatarUrl({ avatar_thumb: { url_list: [123] } }), null);
  assert.equal(pickDouyinAvatarUrl(undefined), null);
});

test('douyinCreatorFromProfile：字段缺省 → null 化（fans/following 脏值容错）', () => {
  const c = douyinCreatorFromProfile({
    sec_uid: 'MS4wLjAx',
    follower_count: 'x', // 脏字符串 → null
    following_count: '239',
  });
  assert.deepEqual(c, {
    source_uid: 'MS4wLjAx', name: null, avatar: null, sign: null, fans: null, following: 239,
  });
});
