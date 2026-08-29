// test/douyin-format.test.mjs
// 抖音数据形态归一回归：SSR videoDetail（camelCase）→ aweme_detail（snake_case）字段对照、
// 字幕 JSON 归一（utterances 毫秒→秒 / body 透传 / captions 变体）、post 列表 200 空体识别、
// cla_info 字幕轨抽取（结构未实测的多形态容错）。
// 依据：docs/plans/douyin/spike-findings.md §1.3（SSR 69 键摘录）/ §2（字幕判据）/ §3（空体 gating）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ssrVideoDetailToAwemeDetail,
  normalizeDouyinCaption,
  isDouyinEmptyPostBody,
  extractDouyinCaptionTracks,
  extractDouyinUpperKey,
} from '../douyin-format.mjs';

// 测试轮次记录（对齐项目 CLAUDE.md §3 / RULES §5）
// | 轮次 | 日期       | 范围                         | 结果 | 备注                                  |
// |------|------------|------------------------------|------|---------------------------------------|
// | T1   | 2026-08-29 | S3 抖音形态归一（纯函数）    | PASS | `pnpm --dir apps/subtitle-collector test` 全绿（覆盖率锁定达标） |
// | T2   | 2026-08-29 | S8 台账性重构（ssr 映射拆子函数，表达式原样搬移）+ extractDouyinUpperKey 新增 | PASS | 同上命令全绿；重构不改行为，T1 断言全数保持 |
// | T3   | 2026-08-30 | 审查 M3：sec_uid 前缀统一 ^MS4wLjAB（三处镜像），补第 8 位非 B 拒收用例 | PASS | 同上命令全绿 |

// 共享 fixture：SSR videoDetail（camelCase，字段取自 spike-findings §1.3 实测摘录）
const ssrVideoDetail = {
  awemeId: '7668187099408944399',
  desc: '影视解说片段 #扫毒风暴',
  caption: '影视解说片段 #扫毒风暴',
  awemeType: 0,
  createTime: 1785388945,
  video: {
    duration: 507467, // 毫秒（与 <video>.duration=507.434 互证）
    uri: 'v0d00fg10000d9ld257og65s7fo674bg',
    playAddr: [{ src: 'https://v11-weba.douyinvod.com/a.mp4' }, { src: 'https://v26-web.douyinvod.com/b.mp4' }],
  },
  stats: { playCount: 0, diggCount: 1234, commentCount: 56, shareCount: 78, collectCount: 90 },
  authorInfo: {
    uid: '123456',
    secUid: 'MS4wLjABAAAA6fLul78DB4jAxgf_of2FevRnLmLAngzB9AiWiz1G98',
    nickname: '洛克影视',
    followerCount: 4142731,
    avatarUri: 'https://p3-pc.douyinpic.com/aweme-avatar/a.jpg',
  },
  textExtra: [
    { hashtagId: '1587111396494349', hashtagName: '扫毒风暴', start: 7, end: 12, type: 1 },
    { start: 0, end: 5, type: 0 }, // 非 hashtag 项（type≠1）
  ],
  mixInfo: { mixId: '7123456789012345678', mixName: '扫毒风暴全解说', desc: '合集简介', currentEpisode: 3, totalEpisode: 20 },
  music: { id: 7678956457940781865, title: '@洛克影视创作的原声' },
};

// ---- SSR → snake_case 对照（spike §1.3 / §1.4⑤）----
test('ssrVideoDetailToAwemeDetail：核心字段 camelCase → snake_case 对照', () => {
  const d = ssrVideoDetailToAwemeDetail(ssrVideoDetail);
  assert.equal(d.aweme_id, '7668187099408944399');
  assert.equal(d.desc, '影视解说片段 #扫毒风暴');
  assert.equal(d.aweme_type, 0);
  assert.equal(d.create_time, 1785388945);
  // 视频时长毫秒原样保留（毫秒→秒在 payload 层做，两形态同口径）
  assert.equal(d.video.duration, 507467);
  assert.equal(d.video.play_addr.uri, 'v0d00fg10000d9ld257og65s7fo674bg');
  // playAddr [{src}] → url_list 字符串数组
  assert.deepEqual(d.video.play_addr.url_list, [
    'https://v11-weba.douyinvod.com/a.mp4',
    'https://v26-web.douyinvod.com/b.mp4',
  ]);
  // stats → statistics（键名对齐 XHR 形态）
  assert.deepEqual(d.statistics, { play_count: 0, digg_count: 1234, comment_count: 56, share_count: 78, collect_count: 90 });
  // authorInfo → author（secUid/nickname/follower_count；avatarUri 作兜底键透传）
  assert.equal(d.author.sec_uid, 'MS4wLjABAAAA6fLul78DB4jAxgf_of2FevRnLmLAngzB9AiWiz1G98');
  assert.equal(d.author.nickname, '洛克影视');
  assert.equal(d.author.follower_count, 4142731);
  assert.equal(d.author.avatar_uri, 'https://p3-pc.douyinpic.com/aweme-avatar/a.jpg');
  // textExtra → text_extra（hashtag_id/hashtag_name；start/end/type 原样）
  assert.equal(d.text_extra.length, 2);
  assert.deepEqual(d.text_extra[0], {
    hashtag_id: '1587111396494349', hashtag_name: '扫毒风暴', start: 7, end: 12, type: 1,
  });
});

test('ssrVideoDetailToAwemeDetail：mixInfo → mix_info（mixId→mix_id，desc 优先于 mixName 作 mix_desc）', () => {
  const d = ssrVideoDetailToAwemeDetail(ssrVideoDetail);
  // spike §1.4⑤：mixInfo.mixId/mixName ↔ mix_info.mix_id/mix_desc；desc 语义更贴 mix_desc，优先
  assert.equal(d.mix_info.mix_id, '7123456789012345678');
  assert.equal(d.mix_info.mix_desc, '合集简介');
});

test('ssrVideoDetailToAwemeDetail：mixInfo 只有 mixName 时 mix_desc 回落 mixName', () => {
  const d = ssrVideoDetailToAwemeDetail({ ...ssrVideoDetail, mixInfo: { mixId: '1', mixName: '合集名' } });
  assert.equal(d.mix_info.mix_desc, '合集名');
});

test('ssrVideoDetailToAwemeDetail：authorInfo 带 avatarThumb/uid 数字 → avatar_thumb 透传 + uid 字符串化（2026-08-30 补分支）', () => {
  // avatarThumb 形态未实测（spike 登记），透传由 pickDouyinAvatarUrl 容错；此处锁 spread 分支行为
  const d = ssrVideoDetailToAwemeDetail({
    ...ssrVideoDetail,
    authorInfo: { uid: 1234567890, secUid: 'MS4wLjABAAAAsrconly', nickname: '头像博主', avatarThumb: { url_list: ['https://p3.douyinpic.com/thumb.jpg'] } },
  });
  assert.equal(d.author.uid, '1234567890', '数字 uid → String');
  assert.deepEqual(d.author.avatar_thumb, { url_list: ['https://p3.douyinpic.com/thumb.jpg'] });
  assert.equal(d.author.avatar_uri, undefined, '无 avatarUri 不带键');
});

test('ssrVideoDetailToAwemeDetail：music.id 数字超精度 → 优先字符串形态（idStr）；无 idStr 回落 String(id)', () => {
  const d = ssrVideoDetailToAwemeDetail(ssrVideoDetail);
  // fixture 的 music.id 是数字（JSON.parse 已丢精度），归一只做字符串化不断言数值
  assert.equal(typeof d.music.id_str, 'string');
  assert.equal(d.music.title, '@洛克影视创作的原声');
  const d2 = ssrVideoDetailToAwemeDetail({ music: { idStr: '7678956457940781865', title: 't' } });
  assert.equal(d2.music.id_str, '7678956457940781865');
});

test('ssrVideoDetailToAwemeDetail：缺 stats/video/mix/music 等字段容忍缺省不抛错', () => {
  // SSR 版本漂移（spike 风险登记①）：字段缺失时对应缺省，不抛错——XHR hook 路兜底
  const d = ssrVideoDetailToAwemeDetail({ awemeId: '123', desc: 'd' });
  assert.equal(d.aweme_id, '123');
  assert.deepEqual(d.statistics, { play_count: null, digg_count: null, comment_count: null, share_count: null, collect_count: null });
  assert.equal(d.video.play_addr.uri, null);
  assert.ok(!('mix_info' in d), '无 mixInfo 不带 mix_info 键');
  assert.ok(!('music' in d), '无 music 不带 music 键');
  assert.deepEqual(d.text_extra, []);
});

test('ssrVideoDetailToAwemeDetail：null / 非对象入参 → {}（安全兜底）', () => {
  assert.deepEqual(ssrVideoDetailToAwemeDetail(null), {});
  assert.deepEqual(ssrVideoDetailToAwemeDetail(undefined), {});
  assert.deepEqual(ssrVideoDetailToAwemeDetail('str'), {});
});

test('ssrVideoDetailToAwemeDetail：脏形态防御（playAddr 坏项/textExtra 项缺字段/mixInfo 无 mixId/music 无 id）', () => {
  const d = ssrVideoDetailToAwemeDetail({
    awemeId: 7668187099, // 数字形态也 String 化（真实 19 位数字超 double 精度，此处用安全数测分支）
    video: {
      playAddr: [null, { noSrc: true }, { src: 'https://ok/a.mp4' }], // 坏项过滤，好项保留
    },
    authorInfo: { uid: 42 }, // uid 数字 → String；无 secUid/nickname
    textExtra: [
      null, // null 项不抛
      { hashtagId: 1587111396494349 }, // 数字 hashtagId → String；start/end/type 缺 → null
    ],
    mixInfo: { desc: '只有简介' }, // 无 mixId → mix_id:null（spike 形态键为 desc）
    music: { title: null }, // 无 id/idStr → id_str:null
  });
  assert.equal(d.aweme_id, '7668187099');
  assert.deepEqual(d.video.play_addr.url_list, ['https://ok/a.mp4']);
  assert.equal(d.author.uid, '42');
  assert.equal(d.author.sec_uid, null, '缺 secUid → null（key 恒在，值缺省）');
  assert.deepEqual(d.text_extra[1], { hashtag_id: '1587111396494349', hashtag_name: null, start: null, end: null, type: null });
  assert.equal(d.mix_info.mix_id, null);
  assert.equal(d.mix_info.mix_desc, '只有简介');
  assert.equal(d.music.id_str, null);
  assert.equal(d.music.title, null);
});

test('normalizeDouyinCaption：脏 utterance（null 项/非字符串 text/非数时间）容忍不抛', () => {
  const r = normalizeDouyinCaption({
    utterances: [
      null, // null 项
      { text: 123, start_time: 0, end_time: 1 }, // text 非字符串 → 过滤
      { text: 'ok', start_time: 'abc', end_time: 2000 }, // 非数时间 → from:null
    ],
  });
  assert.deepEqual(r, { body: [{ from: null, to: 2, content: 'ok' }] });
});

test('normalizeDouyinCaption：body 形态 cue 缺 from/to → null（不发明时间）', () => {
  const r = normalizeDouyinCaption({ body: [{ content: 'x' }, { from: 0, to: 1 }] });
  assert.deepEqual(r, { body: [{ from: null, to: null, content: 'x' }] }, '无 content 的 cue 过滤');
});

// ---- 字幕 JSON 归一 ----
test('normalizeDouyinCaption：utterances（毫秒）→ body cues（秒）', () => {
  // 抖音智能字幕 JSON 的通用形态（未实测，按生态推断）：{utterances:[{text,start_time,end_time}]}
  const r = normalizeDouyinCaption({
    utterances: [
      { text: '大家好', start_time: 0, end_time: 1500 },
      { text: '今天讲', start_time: 1500, end_time: 3200 },
      { text: '', start_time: 3200, end_time: 4000 }, // 空 text 过滤
    ],
  });
  assert.deepEqual(r, {
    body: [
      { from: 0, to: 1.5, content: '大家好' },
      { from: 1.5, to: 3.2, content: '今天讲' },
    ],
  });
});

test('normalizeDouyinCaption：body 形态（B 站/已归一同构）原样透传', () => {
  const r = normalizeDouyinCaption({ body: [{ from: 0, to: 1.5, content: 'hello' }] });
  assert.deepEqual(r, { body: [{ from: 0, to: 1.5, content: 'hello' }] });
});

test('normalizeDouyinCaption：captions 变体同 utterances 口径（防御形态）', () => {
  const r = normalizeDouyinCaption({ captions: [{ text: 'a', start_time: 1000, end_time: 2000 }] });
  assert.deepEqual(r, { body: [{ from: 1, to: 2, content: 'a' }] });
});

test('normalizeDouyinCaption：不可识别 / 空 cues → null（该轨不上报）', () => {
  assert.equal(normalizeDouyinCaption(null), null);
  assert.equal(normalizeDouyinCaption({ foo: 1 }), null);
  assert.equal(normalizeDouyinCaption({ utterances: [] }), null);
  assert.equal(normalizeDouyinCaption({ body: [] }), null);
  assert.equal(normalizeDouyinCaption({ body: [{ from: 0, to: 1 }] }), null, '无 content 的 cue 过滤后为空');
});

// ---- post 列表 200 空体识别（S1 实测 gating 形态）----
test('isDouyinEmptyPostBody：空串/空白/null → true；非空文本与对象 → false', () => {
  assert.equal(isDouyinEmptyPostBody(''), true);
  assert.equal(isDouyinEmptyPostBody('   '), true);
  assert.equal(isDouyinEmptyPostBody(null), true);
  assert.equal(isDouyinEmptyPostBody(undefined), true);
  assert.equal(isDouyinEmptyPostBody('{"aweme_list":[]}'), false, '空列表 JSON 不是空体（翻完≠gating）');
  assert.equal(isDouyinEmptyPostBody({ aweme_list: [] }), false);
});

// ---- cla_info 字幕轨抽取（结构未实测，多形态容错）----
test('extractDouyinCaptionTracks：cla_info 缺失/null → []（匿名态主路径，S1 实测）', () => {
  assert.deepEqual(extractDouyinCaptionTracks({ is_subtitled: 0, cla_info: null }), []);
  assert.deepEqual(extractDouyinCaptionTracks({}), []);
  assert.deepEqual(extractDouyinCaptionTracks(null), []);
});

test('extractDouyinCaptionTracks：cla_infos[] 形态（R1 定案形态，未实测）', () => {
  // R1 定案按 cla_info.cla_infos[] 实现；键名 language/language_desc/url 为同源生态常见形态
  const r = extractDouyinCaptionTracks({
    is_subtitled: 1,
    cla_info: { cla_infos: [
      { language: 'zh', language_desc: '中文（自动生成）', url: 'https://creator.douyin.com/caption/zh.json' },
      { language: 'en', language_desc: '英文', url: 'https://creator.douyin.com/caption/en.json' },
    ] },
  });
  assert.deepEqual(r, [
    { lan: 'zh', lan_doc: '中文（自动生成）', url: 'https://creator.douyin.com/caption/zh.json', is_auto: true },
    { lan: 'en', lan_doc: '英文', url: 'https://creator.douyin.com/caption/en.json', is_auto: true },
  ]);
});

test('extractDouyinCaptionTracks：caption_formats[]（TikTok 同源键）兼容 + 无 url 项过滤', () => {
  const r = extractDouyinCaptionTracks({
    cla_info: { caption_formats: [
      { language_code: 'zh-Hans', caption_format: 'webvtt', url: 'https://x/zh.vtt' },
      { language_code: 'en', caption_format: 'webvtt' }, // 无 url → 过滤
    ] },
  });
  assert.deepEqual(r, [
    { lan: 'zh-Hans', lan_doc: 'zh-Hans', url: 'https://x/zh.vtt', is_auto: true },
  ]);
});

test('extractDouyinCaptionTracks：人工标记（is_manual/caption_format=manual）→ is_auto=false', () => {
  const r = extractDouyinCaptionTracks({
    cla_info: { cla_infos: [
      { language: 'zh', url: 'https://x/zh.json', is_manual: true },
      { language: 'en', url: 'https://x/en.json', caption_format: 'creator_caption' },
    ] },
  });
  assert.equal(r[0].is_auto, false);
  assert.equal(r[1].is_auto, false, 'creator_caption 视为人工轨');
});

test('extractDouyinCaptionTracks：cla_info 存在但内层非数组 → []（不抛错）', () => {
  assert.deepEqual(extractDouyinCaptionTracks({ cla_info: {} }), []);
  assert.deepEqual(extractDouyinCaptionTracks({ cla_info: { cla_infos: 'bad' } }), []);
});

test('extractDouyinCaptionTracks：caption_infos[]（中间兼容键）+ 脏项过滤 + 无语言键回落 unknown', () => {
  const r = extractDouyinCaptionTracks({
    cla_info: { caption_infos: [
      null, // null 项过滤
      { url: 'https://x/zh.json', cla_language: 'zh', lang_desc: '中文' }, // cla_language/lang_desc 兼容键
      { url: 'https://x/no-lang.json' }, // 无任何语言键 → lan=unknown，lan_doc 回落 lan
    ] },
  });
  assert.deepEqual(r, [
    { lan: 'zh', lan_doc: '中文', url: 'https://x/zh.json', is_auto: true },
    { lan: 'unknown', lan_doc: 'unknown', url: 'https://x/no-lang.json', is_auto: true },
  ]);
});

test('extractDouyinCaptionTracks：cla_info 非对象（字符串脏值）→ []', () => {
  assert.deepEqual(extractDouyinCaptionTracks({ cla_info: 'bad' }), []);
});

// ---- 博主页 URL 识别（popup useUpperEntry 用，判据对齐 server parseDouyinSecUid）----
test('extractDouyinUpperKey：博主页 /user/<sec_uid> → sec_uid（带 query/子页路径同样取 ID 段）', () => {
  assert.equal(extractDouyinUpperKey('https://www.douyin.com/user/MS4wLjABAAAAabcdef123456'), 'MS4wLjABAAAAabcdef123456');
  assert.equal(extractDouyinUpperKey('https://www.douyin.com/user/MS4wLjABAAAAabcdef123456?from=web'), 'MS4wLjABAAAAabcdef123456');
  assert.equal(extractDouyinUpperKey('https://www.douyin.com/user/MS4wLjABAAAAabcdef123456/more'), 'MS4wLjABAAAAabcdef123456');
  assert.equal(extractDouyinUpperKey('https://m.douyin.com/user/MS4wLjABAAAAabcdef123456'), 'MS4wLjABAAAAabcdef123456', 'm. 移动域归一后同识别');
});

test('extractDouyinUpperKey：非博主页/其它域/形态不符 → null（视频页/短链域/非 user 路径/坏 ID）', () => {
  assert.equal(extractDouyinUpperKey(null), null);
  assert.equal(extractDouyinUpperKey(undefined), null);
  assert.equal(extractDouyinUpperKey(''), null);
  assert.equal(extractDouyinUpperKey('not a url'), null, '非 URL 解析失败');
  assert.equal(extractDouyinUpperKey('https://www.douyin.com/video/7123456789012345678'), null, '视频页非博主页');
  assert.equal(extractDouyinUpperKey('https://v.douyin.com/AbCdEf/'), null, '短链域不做博主页识别（透传展开归 server）');
  assert.equal(extractDouyinUpperKey('https://space.bilibili.com/296399504'), null, '其它平台域');
  assert.equal(extractDouyinUpperKey('https://www.douyin.com/user/not-a-uid'), null, '非 MS4wLjA 形态 ID');
  // 前缀 8 字符为界（2026-08-30 审查 M3 三处统一，对齐 server DOUYIN_SEC_UID_RE）：第 8 位非 B 拒
  assert.equal(extractDouyinUpperKey('https://www.douyin.com/user/MS4wLjACAAAAabcdef123456'), null, 'MS4wLjA 后第 8 位非 B 不收');
  assert.equal(extractDouyinUpperKey('https://www.douyin.com/user/%zz'), null, '坏 % 序列 decode 失败不抛');
  assert.equal(extractDouyinUpperKey('https://www.douyin.com/user/'), null, '缺 ID 段');
});
