// content.js 上报必要字段缺失告警回归测试（2026-08-25）。
// 背景：sendIngestRecord 原日志只打 bvid+轨数，PLAYER_META 数据源不完整导致
// duration/published_at 落 null 时上报静默——生产 15 条双 NULL 无任何日志可查。
// 本测试锁定：必要字段缺失时 INGEST 照发（字幕资产优先，不拒收）+ console.warn 留证。
// 沙箱模式对齐 content-no-subtitle-report.test.mjs 的 loadContent。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'content.js'), 'utf8');

function loadContent() {
  const sent = [];
  const warns = [];
  const listeners = [];
  const sandbox = {
    console: { log() {}, warn: (...a) => warns.push(a.join(' ')), error() {} },
    setTimeout: () => 0, clearTimeout() {},
    document: { querySelector: () => null },
    location: { pathname: '/' },
    chrome: {
      storage: { local: { get: (_k, cb) => cb({ reportingEnabled: true }) } },
      runtime: { sendMessage: (msg) => sent.push(msg), onMessage: { addListener() {} } },
    },
    window: null,
  };
  sandbox.window = {
    addEventListener: (_t, fn) => listeners.push(fn),
    dispatch: (event) => { for (const fn of listeners) fn(event); },
  };
  vm.runInNewContext(src, sandbox);
  return {
    sent, warns,
    dispatch: (data) => sandbox.window.dispatch({ source: sandbox.window, data }),
  };
}

// player API 无 CC 轨且不带必要字段的 meta（上游 buildPlayerMeta 两源皆缺的形态）
const BARE_META = {
  bvid: 'BV1bare00x', subs: [], title: '页面标题_哔哩哔哩_bilibili',
  up_mid: 42, up_name: '某UP', aid: 111, cid: 222,
  duration: null, published_at: null,
};

test('必要字段缺失：INGEST 照发 + warn 留证（含字段清单与 bvid）', () => {
  const h = loadContent();
  h.dispatch({ type: 'PLAYER_META', data: BARE_META });
  const ingest = h.sent.find((m) => m?.type === 'INGEST');
  assert.ok(ingest, '必要字段缺失不阻塞上报（0 轨元信息仍入 video 行）');
  assert.equal(ingest.payload.video.duration, null);
  assert.equal(ingest.payload.video.published_at, null);
  const warn = h.warns.find((w) => w.includes('必要字段缺失'));
  assert.ok(warn, '必须 console.warn 留证');
  assert.ok(warn.includes('duration') && warn.includes('published_at'), '清单应含两字段');
  assert.ok(warn.includes('BV1bare00x'), '告警应带 bvid');
});

test('必要字段齐全：正常上报，无缺失告警', () => {
  const h = loadContent();
  h.dispatch({ type: 'PLAYER_META', data: { ...BARE_META, duration: 269, published_at: 1787556638000 } });
  assert.ok(h.sent.some((m) => m?.type === 'INGEST'));
  assert.ok(!h.warns.some((w) => w.includes('必要字段缺失')), '字段齐全不应告警');
});
