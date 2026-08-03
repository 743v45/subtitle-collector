import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildYoutubePayload, kindToTrackType } from '../youtube-payload.js';

// 测试轮次记录（对齐全局 8.2 / 项目 CLAUDE.md §3）
// | 轮次 | 日期       | 范围                         | 结果 | 备注                                    |
// |------|------------|------------------------------|------|-----------------------------------------|
// | T1   | 2026-07-19 | Y3 payload 组装（纯函数）    | PASS | 7 用例全绿；track_type 按 R6 映射 asr→1/null→2 |

// 共享 fixture：两轨（人工 en + asr en），bodies 仅人工轨有内容
const enManual = {
  baseUrl: 'https://www.youtube.com/api/timedtext?v=VID&lang=en&fmt=json3&sig=a',
  languageCode: 'en', kind: null, name: 'English', vssId: '.en', isTranslatable: true,
};
const enAsr = {
  baseUrl: 'https://www.youtube.com/api/timedtext?v=VID&lang=en&kind=asr&fmt=json3&sig=b',
  languageCode: 'en', kind: 'asr', name: 'English (auto-generated)', vssId: 'a.en', isTranslatable: true,
};
const bodies = {
  [enManual.baseUrl]: { body: [{ from: 0, to: 1.5, content: 'hello' }] },
};

test('kindToTrackType：asr→1（自动生成/B站 AI），null/其它→2（人工/B站 CC）', () => {
  // R6：server track_type 是 INTEGER，语义 1=AI/asr、2=CC/manual
  assert.equal(kindToTrackType('asr'), 1);
  assert.equal(kindToTrackType(null), 2);
  assert.equal(kindToTrackType(undefined), 2);
});

test('buildYoutubePayload 单轨人工字幕：形状与 buildIngestPayload 同构', () => {
  const payload = buildYoutubePayload({
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
    channelName: 'Rick Astley',
    avatar: 'https://yt.ggpht/avatar.jpg',
    duration: 213,
    publishedAt: 1211987833000,
    captionTracks: [enManual],
    bodies,
  });
  assert.equal(payload.source, 'youtube');
  assert.deepEqual(payload.video, {
    source_vid: 'dQw4w9WgXcQ',
    creator: {
      source_uid: 'UCuAXFkgsw1L7xaCfnd5JJOw',
      name: 'Rick Astley',
      avatar: 'https://yt.ggpht/avatar.jpg',
    },
    title: 'Never Gonna Give You Up',
    extra: {},
    duration: 213,
    published_at: 1211987833000,
  });
  assert.equal(payload.tracks.length, 1);
  const tr = payload.tracks[0];
  assert.equal(tr.lan, 'en');
  assert.equal(tr.lan_doc, 'English');
  assert.equal(tr.track_type, 2, '人工轨 → 2（CC/manual）');
  assert.equal(tr.versions[0].origin, 'external');
  assert.equal(tr.versions[0].source_url, enManual.baseUrl);
  // §5.4：payload = bodies[baseUrl]（保留 {body:} 外层，与 B 站 buildIngestPayload 的 subtitleBodies 一致）
  assert.deepEqual(tr.versions[0].payload, { body: [{ from: 0, to: 1.5, content: 'hello' }] });
});

test('buildYoutubePayload 多轨（人工 en + asr en）：track_type 映射分别为 2 / 1', () => {
  const payload = buildYoutubePayload({
    videoId: 'VID00000001',
    title: 't',
    channelId: 'UC_xxx',
    channelName: 'ch',
    duration: 60,
    publishedAt: 1700000000000,
    captionTracks: [enManual, enAsr],
    bodies,
  });
  assert.equal(payload.tracks.length, 2);
  // 两轨 lan 相同、track_type 不同 → server UNIQUE(video_id, lan, track_type) 不冲突
  assert.equal(payload.tracks[0].track_type, 2, '人工 → 2');
  assert.equal(payload.tracks[1].track_type, 1, 'asr → 1');
  assert.equal(payload.tracks[1].lan_doc, 'English (auto-generated)');
});

test('buildYoutubePayload bodies 部分缺失：该轨 payload=null（不上报脏数据，由 server 侧跳过）', () => {
  const payload = buildYoutubePayload({
    videoId: 'VID00000002',
    title: 't',
    channelId: 'UC_xxx',
    duration: 60,
    publishedAt: 1,
    captionTracks: [enManual, enAsr],
    bodies, // enAsr.baseUrl 未在 bodies 里（如 pot 命中返空 → 未归一化入库）
  });
  assert.deepEqual(payload.tracks[0].versions[0].payload, { body: [{ from: 0, to: 1.5, content: 'hello' }] });
  assert.equal(payload.tracks[1].versions[0].payload, null, 'asr 轨无 body → null');
});

test('buildYoutubePayload captionTracks 为空数组：tracks=[]（无字幕/纯音乐/直播）', () => {
  const payload = buildYoutubePayload({
    videoId: 'VID00000003',
    title: 'no subs',
    channelId: 'UC_x',
    duration: null,
    publishedAt: null,
    captionTracks: [],
    bodies: {},
  });
  assert.deepEqual(payload.tracks, []);
  assert.equal(payload.video.source_vid, 'VID00000003', 'video 仍组装');
});

test('buildYoutubePayload channelId 缺失：creator.source_uid="unknown"（对齐 B 站 ?? "unknown" 语义）', () => {
  const payload = buildYoutubePayload({
    videoId: 'VID00000004',
    title: 't',
    channelId: null,
    channelName: null,
    avatar: null,
    duration: null,
    publishedAt: null,
    captionTracks: [],
    bodies: {},
  });
  assert.equal(payload.video.creator.source_uid, 'unknown');
  assert.equal(payload.video.creator.name, null);
  assert.equal(payload.video.creator.avatar, null);
});

test('buildYoutubePayload publishedAt / duration 缺失：落 null', () => {
  const payload = buildYoutubePayload({
    videoId: 'VID00000005',
    title: 't',
    channelId: 'UC_x',
    captionTracks: [],
    bodies: {},
  });
  assert.equal(payload.video.duration, null);
  assert.equal(payload.video.published_at, null);
});
