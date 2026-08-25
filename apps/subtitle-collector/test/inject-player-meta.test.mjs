// inject.js buildPlayerMeta 必要字段兜底回归测试（2026-08-25）。
// 背景：被动拦截路径 duration/published_at/title 只信 player/wbi/v2 响应，而该响应不返回
// pubdate、video_info.duration/title 也常缺 → 生产 15 条 duration+published_at 双 NULL、
// title 降级 document.title（带 _哔哩哔哩_bilibili 后缀）。修复后语义：
//   title/duration/published_at 三级兜底 player 响应 → __INITIAL_STATE__.videoData → 降级值；
//   published_at 在 pubdate 缺时用 videoData.ctime 兜底（extra 同存 ctime 可追溯）；
//   必要字段仍缺时 console.warn 留证（CLAUDE.md §9 上报不完整必须可观察）。
// 沙箱模式对齐 content-no-subtitle-report.test.mjs 的 loadContent：vm 加载 IIFE 源码。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'inject.js'), 'utf8');

// videoData：B 站 SSR __INITIAL_STATE__.videoData 的必要字段子集（readVideoExtra 同源）
const VD = {
  bvid: 'BV1vd0000', title: 'videoData 纯标题', duration: 269, pubdate: 1787556638, ctime: 1787556630,
  owner: { mid: 42, name: 'UP主' }, pic: 'https://vd-pic',
};

// player 响应缺必要字段的典型形态（生产 15 条事故的输入：无 pubdate / 无 video_info / 无 title）
const PLAYER_BARE = { code: 0, data: { bvid: 'BV1vd0000', aid: 1, cid: 2, subtitle: { subtitles: [] } } };

function loadInject({ videoData, playerJson }) {
  const messages = [];
  const warns = [];
  const response = { ok: true, clone: () => ({ json: async () => playerJson }) };
  const sandbox = {
    console: { log() {}, warn: (...a) => warns.push(a.join(' ')), error() {} },
    location: { pathname: '/video/BV1vd0000', search: '' },
    document: { title: '页面标题_哔哩哔哩_bilibili' },
    setTimeout: () => 0, clearTimeout() {},
    XMLHttpRequest: class { open() {} send() {} },
    window: null,
  };
  sandbox.window = {
    __INITIAL_STATE__: videoData != null ? { videoData } : {},
    fetch: async () => response,
    postMessage: (m) => messages.push(m),
  };
  vm.runInNewContext(src, sandbox);
  return {
    messages, warns,
    // inject.js 已把 window.fetch 换成 hook；调它走完整拦截链（原 fetch → clone().json() → post PLAYER_META）
    trigger: async () => {
      await sandbox.window.fetch('https://api.bilibili.com/x/player/wbi/v2?aid=1');
      await new Promise((r) => setImmediate(r)); // 等 clone().json() 的 promise 链发完消息
    },
  };
}

const metaOf = (h) => h.messages.find((m) => m?.type === 'PLAYER_META')?.data;

test('player 响应缺必要字段：从 __INITIAL_STATE__.videoData 兜底 duration/published_at/title', async () => {
  const h = loadInject({ videoData: VD, playerJson: PLAYER_BARE });
  await h.trigger();
  const meta = metaOf(h);
  assert.ok(meta, '应发出 PLAYER_META');
  assert.equal(meta.duration, 269, 'duration 应从 videoData.duration 兜底');
  assert.equal(meta.published_at, 1787556638000, 'published_at 应从 videoData.pubdate×1000 兜底');
  assert.equal(meta.title, 'videoData 纯标题', 'title 应从 videoData.title 兜底（不带页面后缀）');
  assert.equal(meta.pic, 'https://vd-pic', 'pic 应从 videoData.pic 兜底');
  assert.ok(!h.warns.some((w) => w.includes('必要字段缺失')), '必要字段补齐后不应告警');
});

test('player 响应带值时优先于 videoData（player 是一手源）', async () => {
  const playerFull = { code: 0, data: { bvid: 'BV1vd0000', aid: 1, cid: 2, title: 'player 标题', pic: 'https://p', video_info: { duration: 300 }, pubdate: 1787000000, subtitle: { subtitles: [] } } };
  const h = loadInject({ videoData: VD, playerJson: playerFull });
  await h.trigger();
  const meta = metaOf(h);
  assert.equal(meta.duration, 300);
  assert.equal(meta.published_at, 1787000000000);
  assert.equal(meta.title, 'player 标题');
});

test('videoData 无 pubdate 时用 ctime 兜底 published_at', async () => {
  const vdNoPub = { ...VD, pubdate: undefined, ctime: 1787556630 };
  const h = loadInject({ videoData: vdNoPub, playerJson: PLAYER_BARE });
  await h.trigger();
  const meta = metaOf(h);
  assert.equal(meta.published_at, 1787556630000, 'ctime×1000 兜底（投稿时间≈发布时间）');
});

test('两源全缺：duration/published_at 落 null + title 降级页面标题，且 warn 留证', async () => {
  const h = loadInject({ videoData: null, playerJson: PLAYER_BARE });
  await h.trigger();
  const meta = metaOf(h);
  assert.ok(meta, '数据源残缺不阻塞 PLAYER_META（字幕采集优先）');
  assert.equal(meta.duration, null);
  assert.equal(meta.published_at, null);
  assert.equal(meta.title, '页面标题_哔哩哔哩_bilibili', 'title 降级 document.title');
  const warn = h.warns.find((w) => w.includes('必要字段缺失'));
  assert.ok(warn, '必要字段缺失必须 console.warn 留证');
  assert.ok(warn.includes('duration') && warn.includes('published_at'), '清单应含两字段');
  assert.ok(warn.includes('BV1vd0000'), '告警应带 bvid 供定位');
});
