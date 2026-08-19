// 扩展上下文失效（Extension context invalidated）回归测试。
// 场景：扩展 reload/更新后，旧标签页里驻留的 content script 其 chrome 绑定失效，
// 任何 chrome.* 调用同步抛 "Extension context invalidated."。历史上 FETCH_SUBTITLE /
// INGEST 的 sendMessage 已包 try/catch（content.js 内注释），但 PLAYER_META 分支的
// chrome.storage.local.get 漏包 → 用户实际报过 Uncaught Error（2026-08-19）。
// 本测试用 vm 沙箱载入 content.js 源码，注入「storage 同步抛」的 chrome 桩，
// 派发 PLAYER_META（无 CC 轨，走到 storage 读取），断言异常不穿透 message 监听器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'content.js'), 'utf8');

// 载入 content.js 到受控 sandbox，返回派发 window message 的工具。
// chromeStub 注入 chrome 行为（正常 / 上下文失效同步抛）。
function loadContent({ chromeStub }) {
  const listeners = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, // 兜底防重试定时器悬挂（本路径不应触发）
    clearTimeout() {},
    document: { querySelector: () => null },
    location: { pathname: '/' },
    chrome: chromeStub,
    window: null,
  };
  sandbox.window = {
    addEventListener: (_type, fn) => listeners.push(fn),
    dispatch: (event) => { for (const fn of listeners) fn(event); },
  };
  vm.runInNewContext(src, sandbox);
  return { dispatch: (data) => sandbox.window.dispatch({ source: sandbox.window, data }) };
}

// 模拟失效上下文：storage.local.get / runtime.sendMessage 一律同步抛
function invalidatedChrome() {
  const boom = () => { throw new Error('Extension context invalidated.'); };
  return {
    storage: { local: { get: boom } },
    runtime: { sendMessage: boom, onMessage: { addListener() {} } },
  };
}

test('PLAYER_META（无 CC 轨）在扩展上下文失效时不产生未捕获异常', () => {
  const { dispatch } = loadContent({ chromeStub: invalidatedChrome() });
  // 旧行为：chrome.storage.local.get（content.js PLAYER_META 分支）未包 try/catch，
  // 异常穿透 message 监听器成为页面 Uncaught Error。
  assert.doesNotThrow(() => {
    dispatch({ type: 'PLAYER_META', data: { bvid: 'BV1xx411c7mD', subs: [] } });
  });
});

test('PLAYER_META（有 CC 轨）在扩展上下文失效时不产生未捕获异常', () => {
  // 有字幕轨路径：fetchSubtitleBodiesViaBg 的 sendMessage 已有 try/catch（回归确认不被本次改动破坏）
  const { dispatch } = loadContent({ chromeStub: invalidatedChrome() });
  assert.doesNotThrow(() => {
    dispatch({
      type: 'PLAYER_META',
      data: {
        bvid: 'BV1xx411c7mD',
        subs: [{ lan: 'zh-Hans', lan_doc: '简中', subtitle_url: 'https://example.com/s.json' }],
      },
    });
  });
});
