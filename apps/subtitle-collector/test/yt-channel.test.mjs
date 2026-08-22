import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYoutubeChannelKey,
  parseCountText,
  parseRelativeTime,
  relativeMonths,
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

test('parseCountText：中文万/亿（简繁，YouTube 中文界面）', () => {
  assert.equal(parseCountText('12万次观看'), 120000);
  assert.equal(parseCountText('26.3万次观看'), 263000);
  assert.equal(parseCountText('1.2亿次观看'), 120000000);
  assert.equal(parseCountText('12萬次觀看'), 120000); // 繁体
  assert.equal(parseCountText('1.5B views'), 1500000000); // billion（缺 B 会错值 2 而非 null）
  assert.equal(parseCountText('无观看次数'), null);
});

test('parseCountText：畸形数字段（多小数点/裸点）→ null（Number → NaN 防御）', () => {
  // [\d.]+ 会吃下 "1.2.3" / "."，Number() 得 NaN → 走 !Number.isFinite 防御返回 null
  assert.equal(parseCountText('1.2.3 views'), null);
  assert.equal(parseCountText('.'), null);
});

test('parseRelativeTime：单位换算 + Streamed 前缀 + 无 ago 返回 null', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseRelativeTime('2 weeks ago', now), Math.floor(now / 1000) - 2 * 604800);
  assert.equal(parseRelativeTime('9 months ago', now), Math.floor(now / 1000) - 9 * 2592000);
  assert.equal(parseRelativeTime('Streamed 1 year ago', now), Math.floor(now / 1000) - 31536000);
  assert.equal(parseRelativeTime('3 hours ago', now), Math.floor(now / 1000) - 3 * 3600);
  assert.equal(parseRelativeTime('today'), null);
});

// relativeMonths：相对文本 → 月数档位（时间过滤与页面显示同口径）。
// YouTube 满 12 个月后统一显示 "N years ago"，精确秒无法区分 12~24 月，
// 档位判断才能让 "1 year ago" 落入「近一年」。
test('relativeMonths：单位归一化月数档位', () => {
  assert.equal(relativeMonths('1 year ago'), 12); // 近一年含它（本次修复主案）
  assert.equal(relativeMonths('2 years ago'), 24);
  assert.equal(relativeMonths('Streamed 1 year ago'), 12); // 前缀容忍
  assert.equal(relativeMonths('11 months ago'), 11);
  assert.equal(relativeMonths('6 months ago'), 6);
  assert.equal(relativeMonths('7 months ago'), 7);
  assert.equal(relativeMonths('3 weeks ago'), 0);
  assert.equal(relativeMonths('5 days ago'), 0);
  assert.equal(relativeMonths('2 hours ago'), 0);
  assert.equal(relativeMonths('today'), null);
  assert.equal(relativeMonths(null), null);
  assert.equal(relativeMonths(42), null);
});

// 中文界面（SSR 受浏览器 cookie/语言影响，实际抓到 "12万次观看"/"2周前"）：
// 相对时间与计数的中英双语解析。
test('relativeMonths / parseRelativeTime：中文相对时间（简繁）', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseRelativeTime('8个月前', now), Math.floor(now / 1000) - 8 * 2592000);
  assert.equal(parseRelativeTime('2周前', now), Math.floor(now / 1000) - 2 * 604800);
  assert.equal(parseRelativeTime('1年前', now), Math.floor(now / 1000) - 31536000);
  assert.equal(parseRelativeTime('3天前', now), Math.floor(now / 1000) - 3 * 86400);
  assert.equal(relativeMonths('8个月前'), 8);
  assert.equal(relativeMonths('1年前'), 12);
  assert.equal(relativeMonths('2周前'), 0);
  assert.equal(relativeMonths('2週前'), 0); // 繁体周
  assert.equal(relativeMonths('1個月前'), 1); // 繁体个月
  assert.equal(relativeMonths('5 分鐘前'), 0); // 繁体分钟（缺它会 null → 新视频被时间过滤吞）
  assert.equal(relativeMonths('3 小時前'), 0); // 繁体小时
  assert.equal(relativeMonths('3 時間前'), 0); // 日文
  assert.equal(relativeMonths('2 か月前'), 2); // 日文
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
  assert.equal(it.agoText, '2 weeks ago'); // 原始相对文本随条目透传（档位过滤用）
  assert.equal(it.length, '11:38');
  assert.equal(it.pic, 'https://i.ytimg.com/vi/gaDdrDdczO4/mqdefault.jpg');
});

test('parseLockup：中文界面 metadata（次观看/前判别）', () => {
  // 实测中文 SSR：metadataParts 为 ["12万次观看","2周前"]
  const zh = parseLockup({
    ...LOCKUP,
    metadata: {
      lockupMetadataViewModel: {
        title: { content: 'New Skills! v1.2' },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              { metadataParts: [{ text: { content: '12万次观看' } }, { text: { content: '2周前' } }] },
            ],
          },
        },
      },
    },
  });
  assert.equal(zh.play, 120000);
  assert.equal(zh.agoText, '2周前');
  assert.ok(zh.created != null && zh.created < Math.floor(Date.now() / 1000));
});

test('parseLockup：playlist lockup / 坏 contentId → null（宽容降级）', () => {
  assert.equal(parseLockup({ ...LOCKUP, contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' }), null);
  assert.equal(parseLockup({ ...LOCKUP, contentId: 'short' }), null);
  assert.equal(parseLockup(null), null);
  // 缺时长/计数（结构不全）仍返回条目，缺字段为 null
  const partial = parseLockup({ contentId: 'gaDdrDdczO4', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: {} });  assert.equal(partial.vid, 'gaDdrDdczO4');
  assert.equal(partial.length, null);
  assert.equal(partial.title, null);
});

test('parseLockup：metadataRows 缺 metadataParts / part 缺 text → 容错跳过（?? 兜底）', () => {
  // YouTube 结构变体/降级：空 row、无 text 的 part、无 content 的 text 都不炸不误读
  const it = parseLockup({
    contentId: 'gaDdrDdczO4',
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: {
      lockupMetadataViewModel: {
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              {},                                  // 无 metadataParts → ?? [] 跳过
              { metadataParts: [{}] },             // part 无 text → ?? '' 跳过
              { metadataParts: [{ text: {} }] },   // text 无 content → ?? '' 跳过
            ],
          },
        },
      },
    },
  });
  assert.equal(it.vid, 'gaDdrDdczO4');
  assert.equal(it.play, null);
  assert.equal(it.agoText, null);
  assert.equal(it.created, null);
});

test('parseLockup：时长 badge 递归的防御分支（null 项 / 原始值 / 已找到后再遇 null）', () => {
  // overlays 混入 null（node == null 早退）与字符串原始值（typeof 非 object 早退）：
  // 递归不炸，且 badge 找到时长后再遇 null 走 length 已置的短路分支
  const it = parseLockup({
    contentId: 'gaDdrDdczO4',
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: {
      thumbnailViewModel: {
        overlays: [null, 'raw-string', { deep: ['x', { deeper: null }] }],
      },
    },
  });
  assert.equal(it.length, null, '无匹配时长 badge → null');

  const hit = parseLockup({
    contentId: 'gaDdrDdczO4',
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: {
      thumbnailViewModel: {
        overlays: [
          { thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: 'LIVE', badgeStyle: 'STYLE' } }] } },
          null, // LIVE 未置 length → 走 node == null 早退分支
        ],
      },
    },
  });
  assert.equal(hit.length, null, 'text 非 M:SS 形态（LIVE）不误读为时长，递归穿原始值分支');

  // badge 已找到时长后再遇 null → 走 length 已置的短路分支（|| 左侧命中）
  const found = parseLockup({
    contentId: 'gaDdrDdczO4',
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: {
      thumbnailViewModel: {
        overlays: [
          { thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '11:38' } }] } },
          null,
        ],
      },
    },
  });
  assert.equal(found.length, '11:38');
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
    `<span>"content":"299 videos"</span></html>`;
  const out = parseYtChannelHtml(html);
  assert.equal(out.channelId, 'UCswG6FSbgZjbWtdf_hMLaow');
  assert.equal(out.channelName, 'Matt Pocock');
  assert.equal(out.inntertubeKey, 'AIzaSyTEST');
  assert.equal(out.clientVersion, '2.20260820.01.00');
  assert.equal(out.total, 299);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].vid, 'gaDdrDdczO4');
});

test('parseYtChannelHtml：总数 header 多语言（英文/简繁中/日文）', () => {
  // 实测 header text.content："299 videos" / "299 个视频" / "1.2万 个视频" / "299 個影片" / "299 本の動画"
  const mk = (label) => `<html><script>var ytInitialData = {};</script><span>"content":"${label}"</span></html>`;
  assert.equal(parseYtChannelHtml(mk('299 videos')).total, 299);
  assert.equal(parseYtChannelHtml(mk('1.2K videos')).total, 1200);
  assert.equal(parseYtChannelHtml(mk('299 个视频')).total, 299);
  assert.equal(parseYtChannelHtml(mk('1.2万 个视频')).total, 12000);
  assert.equal(parseYtChannelHtml(mk('299 個影片')).total, 299);
  assert.equal(parseYtChannelHtml(mk('299 本の動画')).total, 299);
  // 负例：条目播放数（"127K views"，views≠videos 词条）不误当频道总数
  assert.equal(parseYtChannelHtml(mk('127K views')).total, null);
  // 负例：i18n 模板串（无 "content": 前缀）不误当频道总数
  const tpl = `<html><script>var ytInitialData = {};</script><span>"VIDEO_COUNT":{"case1":"1 个视频","other":"# 个视频"}</span></html>`;
  assert.equal(parseYtChannelHtml(tpl).total, null);
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
