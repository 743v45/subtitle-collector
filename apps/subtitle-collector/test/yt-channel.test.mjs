import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYoutubeChannelKey,
  parseCountText,
  parseRelativeTime,
  parseLockup,
  parseYtBrowseResponse,
  parseYtChannelHtml,
  channelVideosUrl,
} from '../yt-channel.mjs';

// —— extractYoutubeChannelKey：URL 识别 ——
test('extractYoutubeChannelKey：@handle 及任意子页命中', () => {
  assert.deepEqual(extractYoutubeChannelKey('https://www.youtube.com/@mattpocockuk'), { kind: 'handle', key: '@mattpocockuk' });
  assert.deepEqual(extractYoutubeChannelKey('https://www.youtube.com/@mattpocockuk/videos'), { kind: 'handle', key: '@mattpocockuk' });
  assert.deepEqual(extractYoutubeChannelKey('https://www.youtube.com/@mattpocockuk/shorts?si=xyz'), { kind: 'handle', key: '@mattpocockuk' });
  assert.deepEqual(extractYoutubeChannelKey('https://www.youtube.com/@mattpocockuk/featured'), { kind: 'handle', key: '@mattpocockuk' });
  assert.deepEqual(extractYoutubeChannelKey('https://m.youtube.com/@handle.name-1/community'), { kind: 'handle', key: '@handle.name-1' });
});

test('extractYoutubeChannelKey：/channel/UCxxx、/c/、/user/ 命中', () => {
  assert.deepEqual(
    extractYoutubeChannelKey('https://www.youtube.com/channel/UCswG6FSbgZjbWtdf_hMLaow/videos'),
    { kind: 'channel', key: 'UCswG6FSbgZjbWtdf_hMLaow' },
  );
  assert.deepEqual(extractYoutubeChannelKey('https://www.youtube.com/c/mattcpocock'), { kind: 'custom', key: 'mattcpocock' });
  assert.deepEqual(extractYoutubeChannelKey('https://www.youtube.com/user/mattpocockuk/videos'), { kind: 'custom', key: 'mattpocockuk' });
});

test('extractYoutubeChannelKey：非频道页排除', () => {
  assert.equal(extractYoutubeChannelKey('https://www.youtube.com/'), null);
  assert.equal(extractYoutubeChannelKey('https://www.youtube.com/watch?v=gaDdrDdczO4'), null);
  // 顶层 /shorts/{vid} 是短视频播放页（非频道 shorts 子页）
  assert.equal(extractYoutubeChannelKey('https://www.youtube.com/shorts/gaDdrDdczO4'), null);
  assert.equal(extractYoutubeChannelKey('https://www.youtube.com/results?search_query=ts'), null);
  assert.equal(extractYoutubeChannelKey('https://www.youtube.com/playlist?list=PLxxx'), null);
  assert.equal(extractYoutubeChannelKey('https://www.youtube.com/feed/subscriptions'), null);
  // UC 长度不对（21 位）不识别
  assert.equal(extractYoutubeChannelKey('https://www.youtube.com/channel/UCswG6FSbgZjbWtdf_hMLa'), null);
  // 非 youtube 域
  assert.equal(extractYoutubeChannelKey('https://space.bilibili.com/123'), null);
  assert.equal(extractYoutubeChannelKey('not a url'), null);
});

// —— parseCountText / parseRelativeTime ——
test('parseCountText：K/M/逗号/纯数字', () => {
  assert.equal(parseCountText('127K views'), 127000);
  assert.equal(parseCountText('1.2M views'), 1200000);
  assert.equal(parseCountText('1,234,567 views'), 1234567);
  assert.equal(parseCountText('299'), 299);
  assert.equal(parseCountText('No views'), null);
  assert.equal(parseCountText(null), null);
});

test('parseRelativeTime：单位换算 + Streamed 前缀 + 无 ago 返回 null', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseRelativeTime('2 weeks ago', now), Math.floor(now / 1000) - 2 * 604800);
  assert.equal(parseRelativeTime('9 months ago', now), Math.floor(now / 1000) - 9 * 2592000);
  assert.equal(parseRelativeTime('Streamed 1 year ago', now), Math.floor(now / 1000) - 31536000);
  assert.equal(parseRelativeTime('3 hours ago', now), Math.floor(now / 1000) - 3 * 3600);
  assert.equal(parseRelativeTime('today'), null);
});

// —— parseLockup：2026-08 实测 lockupViewModel 结构（fixture 摘自 @mattpocockuk/videos）——
const LOCKUP = {
  contentId: 'gaDdrDdczO4',
  contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
  metadata: {
    lockupMetadataViewModel: {
      title: { content: 'New Skills! v1.2' },
      metadata: {
        contentMetadataViewModel: {
          metadataRows: [
            { metadataParts: [{ text: { content: '127K views' } }, { text: { content: '2 weeks ago' } }] },
          ],
        },
      },
    },
  },
  contentImage: {
    thumbnailViewModel: {
      overlays: [
        {
          thumbnailBottomOverlayViewModel: {
            badges: [{ thumbnailBadgeViewModel: { text: '11:38', badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT' } }],
          },
        },
      ],
    },
  },
};

test('parseLockup：视频条目全字段', () => {
  const it = parseLockup(LOCKUP);
  assert.equal(it.vid, 'gaDdrDdczO4');
  assert.equal(it.title, 'New Skills! v1.2');
  assert.equal(it.play, 127000);
  assert.ok(it.created < Math.floor(Date.now() / 1000));
  assert.equal(it.length, '11:38');
  assert.equal(it.pic, 'https://i.ytimg.com/vi/gaDdrDdczO4/mqdefault.jpg');
});

test('parseLockup：playlist lockup / 坏 contentId → null（宽容降级）', () => {
  assert.equal(parseLockup({ ...LOCKUP, contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' }), null);
  assert.equal(parseLockup({ ...LOCKUP, contentId: 'short' }), null);
  assert.equal(parseLockup(null), null);
  // 缺时长/计数（结构不全）仍返回条目，缺字段为 null
  const partial = parseLockup({ contentId: 'gaDdrDdczO4', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: {} });
  assert.equal(partial.vid, 'gaDdrDdczO4');
  assert.equal(partial.length, null);
  assert.equal(partial.title, null);
});

// —— parseYtBrowseResponse：richItemRenderer 树 + continuation ——
test('parseYtBrowseResponse：收集 lockups + 透传 continuation token', () => {
  const json = {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            { richItemRenderer: { content: { lockupViewModel: LOCKUP } } },
            { richItemRenderer: { content: { lockupViewModel: { ...LOCKUP, contentId: 'F3lL98Pj90o' } } } },
            { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN123' } } } },
          ],
        },
      },
    ],
  };
  const { items, continuation } = parseYtBrowseResponse(json);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.vid), ['gaDdrDdczO4', 'F3lL98Pj90o']);
  assert.equal(continuation, 'TOKEN123');
  // 无 continuation（尾页）→ null
  assert.equal(parseYtBrowseResponse({ some: 'data' }).continuation, null);
});

// —— parseYtChannelHtml：SSR HTML 全量解析 ——
test('parseYtChannelHtml：channelId/名称/InnerTube/总数/条目', () => {
  const inner = JSON.stringify({
    metadata: { channelMetadataRenderer: { externalId: 'UCswG6FSbgZjbWtdf_hMLaow', title: 'Matt Pocock' } },
    contents: { a: { richItemRenderer: { content: { lockupViewModel: LOCKUP } } } },
  });
  const html = `<html><script>var ytInitialData = ${inner};</script>` +
    `<script>yt.setConfig({"INNERTUBE_API_KEY":"AIzaSyTEST","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20260820.01.00"});</script>` +
    `<span>"299 videos"</span></html>`;
  const out = parseYtChannelHtml(html);
  assert.equal(out.channelId, 'UCswG6FSbgZjbWtdf_hMLaow');
  assert.equal(out.channelName, 'Matt Pocock');
  assert.equal(out.inntertubeKey, 'AIzaSyTEST');
  assert.equal(out.clientVersion, '2.20260820.01.00');
  assert.equal(out.total, 299);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].vid, 'gaDdrDdczO4');
});

test('parseYtChannelHtml：无 ytInitialData / 坏 JSON → 全空不炸', () => {
  assert.deepEqual(parseYtChannelHtml('<html>empty</html>'),
    { channelId: null, channelName: null, inntertubeKey: null, clientVersion: null, total: null, items: [], continuation: null });
  assert.equal(parseYtChannelHtml(null).items.length, 0);
  const broken = '<script>var ytInitialData = {broken json...};</script>';
  assert.equal(parseYtChannelHtml(broken).items.length, 0);
});

// —— channelVideosUrl ——
test('channelVideosUrl：三类标识 → /videos URL', () => {
  assert.equal(channelVideosUrl({ handle: '@mattpocockuk' }), 'https://www.youtube.com/@mattpocockuk/videos');
  assert.equal(channelVideosUrl({ channelId: 'UCswG6FSbgZjbWtdf_hMLaow' }), 'https://www.youtube.com/channel/UCswG6FSbgZjbWtdf_hMLaow/videos');
  assert.equal(channelVideosUrl({ custom: 'mattcpocock' }), 'https://www.youtube.com/c/mattcpocock/videos');
  assert.equal(channelVideosUrl({}), null);
});
