// 无字幕上报视频信息回归测试（B 站 content.js）。
// 背景：YouTube 链路 2026-08-22 起支持 0 轨上报元信息（content-yt.js flushIfReady，
// 「元信息不是脏数据」决策），B 站 content.js 的 flushIfReady 在 subs 为空时
// `ready.length === 0 → return` 整体跳过——无字幕视频连视频信息都不入库。
// 本测试锁定：无字幕（PLAYER_META subs 空）也上报 0 轨视频信息 payload；
// 与「确认无字幕」打 no-subtitle 系统标的批量采集链路语义不同（浏览路径 0 轨≠确认无字幕，
// 可能只是 AI 字幕未到/未登录），不打标，仅入 video 行。
// 沙箱模式对齐 content-context-invalidated.test.mjs 的 loadContent。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'content.js'), 'utf8');

// 载入 content.js 到受控 sandbox：chrome 桩记录 INGEST 上报消息、收集 onMessage listener（RE_AGG 用）。
// storage.local.get 同步回调（真实为异步，同步不改变 content.js 时序正确性——expectAi 置位早于后续事件即可）。
function loadContent({ reportingEnabled = true } = {}) {
  const sent = []; // chrome.runtime.sendMessage 抓到的消息（INGEST 上报）
  const runtimeListeners = [];
  const listeners = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, // triggerAiSubtitle 的延迟点击不真跑（页面 UI 行为，与上报逻辑无关）
    clearTimeout() {},
    document: { querySelector: () => null },
    location: { pathname: '/' },
    chrome: {
      storage: { local: { get: (_keys, cb) => cb({ reportingEnabled }) } },
      runtime: {
        sendMessage: (msg) => { sent.push(msg); },
        onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
      },
    },
    window: null,
  };
  sandbox.window = {
    addEventListener: (_type, fn) => listeners.push(fn),
    dispatch: (event) => { for (const fn of listeners) fn(event); },
  };
  vm.runInNewContext(src, sandbox);
  return {
    sent,
    ingests: () => sent.filter((m) => m?.type === 'INGEST'),
    dispatch: (data) => sandbox.window.dispatch({ source: sandbox.window, data }),
    runtimeMsg: (msg) => { for (const fn of runtimeListeners) fn(msg, {}, () => {}); },
  };
}

// 基础无字幕 meta（player API wbi/v2 无 CC 轨的典型形态：AI 字幕视频/真无字幕）
const NO_SUB_META = {
  bvid: 'BV1noSub00x',
  subs: [],
  title: '无字幕视频标题',
  up_mid: 42,
  up_name: '某UP',
  aid: 111,
  cid: 222,
  duration: 300,
  published_at: 1700000000000,
  extra: { aid: 111, cid: 222, tid: 17, stat: { view: 1000 } },
};

test('无字幕视频（PLAYER_META subs 空）上报 0 轨视频信息', () => {
  const t = loadContent();
  t.dispatch({ type: 'PLAYER_META', data: NO_SUB_META });
  const ingests = t.ingests();
  // 旧行为：subs 空时 flushIfReady 直接 return，不发 INGEST（本断言失败）
  assert.equal(ingests.length, 1, '无字幕应上报一条 0 轨视频信息');
  const rec = ingests[0].payload;
  assert.equal(rec.source, 'bilibili');
  assert.equal(rec.video.source_vid, 'BV1noSub00x');
  assert.equal(rec.video.title, '无字幕视频标题');
  assert.equal(rec.video.creator.source_uid, '42');
  assert.equal(rec.video.creator.name, '某UP');
  assert.deepEqual(rec.video.extra.stat, { view: 1000 });
  assert.equal(rec.tracks.length, 0, '无字幕上报 tracks 应为空（仅视频信息）');
});

test('重复 PLAYER_META（仍无字幕）不重复自动上报（防重）', () => {
  const t = loadContent();
  t.dispatch({ type: 'PLAYER_META', data: NO_SUB_META });
  t.dispatch({ type: 'PLAYER_META', data: NO_SUB_META }); // 清晰度切换/切 P 会重发 player API
  assert.equal(t.ingests().length, 1, '0 轨自动上报每 bvid 只发一次');
});

test('RE_AGG（手动上报 force）无字幕也重发 0 轨视频信息', () => {
  const t = loadContent();
  t.dispatch({ type: 'PLAYER_META', data: NO_SUB_META });
  t.runtimeMsg({ type: 'RE_AGG', force: true });
  const ingests = t.ingests();
  assert.equal(ingests.length, 2, '自动 1 次 + 手动 force 重发 1 次');
  assert.equal(ingests[1].force, true, '手动上报应带 force 绕过上报开关');
  assert.equal(ingests[1].payload.tracks.length, 0);
});

test('无字幕上报后 AI 字幕到达 → 幂等补轨上报 1 轨', () => {
  const t = loadContent();
  t.dispatch({ type: 'PLAYER_META', data: NO_SUB_META });
  // AI 字幕体到达（expectAi 已由 PLAYER_META 时 storage 回调置位）→ 构造 ai-zh 轨入库
  t.dispatch({
    type: 'SUBTITLE_BODY',
    data: { url: 'https://aisubtitle.bilibili.com/x?req=1', body: { body: '[]' }, bvid: 'BV1noSub00x' },
  });
  const ingests = t.ingests();
  assert.equal(ingests.length, 2, '0 轨视频信息 + AI 补轨各一条');
  const aiRec = ingests[1].payload;
  assert.equal(aiRec.tracks.length, 1);
  assert.equal(aiRec.tracks[0].lan, 'ai-zh');
});

test('有字幕路径不受本次改动影响（回归确认）', () => {
  const t = loadContent();
  const url = 'https://api.bilibili.com/x/subtitle?s=zh';
  t.dispatch({
    type: 'PLAYER_META',
    data: { ...NO_SUB_META, bvid: 'BV1hasSub0x', subs: [{ lan: 'zh-CN', lan_doc: '中文', track_type: 1, subtitle_url: url }] },
  });
  t.dispatch({ type: 'SUBTITLE_BODY', data: { url, body: { body: '[]' } } });
  const ingests = t.ingests();
  assert.equal(ingests.length, 1, '有字幕时不发 0 轨，字幕体到达后发 1 轨');
  assert.equal(ingests[0].payload.tracks.length, 1);
  assert.equal(ingests[0].payload.video.source_vid, 'BV1hasSub0x');
});
