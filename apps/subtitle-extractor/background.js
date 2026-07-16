// service worker:协调 popup ↔ offscreen,管理 offscreen document 生命周期 + 持久化配置。
// 推理本身在 offscreen document 跑(SW 无 WASM/Worker/长生命周期环境)。
// 配置四段链路(抄 subtitle-collector):.mjs 定义 → loadPersistedState/apply* → SET_* 消息 → offscreen 消费。

import { EXTRACT_KEY, resolveExtractEnabled } from './extract-mode.mjs';
import {
  WHISPER_CONFIG_KEY,
  resolveWhisperConfig,
  DEFAULT_CONFIG,
} from './whisper-config.mjs';

const OFFSCREEN_URL = 'offscreen.html';

/** 内存权威态(SW 冷启时从 storage 重载) */
const state = {
  extractEnabled: false,
  whisperConfig: { ...DEFAULT_CONFIG },
};

async function loadPersistedState() {
  const got = await chrome.storage.local.get([EXTRACT_KEY, WHISPER_CONFIG_KEY]);
  state.extractEnabled = resolveExtractEnabled(got[EXTRACT_KEY]);
  state.whisperConfig = resolveWhisperConfig(got[WHISPER_CONFIG_KEY]);
}
async function applyExtract(v) {
  state.extractEnabled = resolveExtractEnabled(v);
  await chrome.storage.local.set({ [EXTRACT_KEY]: v === true });
}
async function applyWhisperConfig(v) {
  state.whisperConfig = resolveWhisperConfig(v);
  await chrome.storage.local.set({ [WHISPER_CONFIG_KEY]: state.whisperConfig });
}

// SW 冷启动 / 安装 / 浏览器启动 都重载持久态
loadPersistedState();
chrome.runtime.onInstalled?.addListener(loadPersistedState);
chrome.runtime.onStartup?.addListener(loadPersistedState);

/** offscreen document 是否已存在(MV3 优先 hasDocument,兜底 getContexts)。 */
async function hasOffscreen() {
  try {
    if (typeof chrome.offscreen?.hasDocument === 'function') {
      return await chrome.offscreen.hasDocument();
    }
  } catch {
    /* hasDocument 某些版本抛错,走兜底 */
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

/** 确保 offscreen document 存在(幂等)。 */
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification:
      '运行 transformers.js Whisper 推理,需 WASM/Worker 环境(SW 跑不了)',
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'TRANSCRIBE_FILE') {
      try {
        await ensureOffscreen();
        // 转发给 offscreen,带 bg 权威配置;结果由 offscreen 广播 PROGRESS/RESULT/ERROR
        await chrome.runtime.sendMessage({
          type: 'TRANSCRIBE',
          id: msg.id,
          filename: msg.filename,
          mime: msg.mime,
          dataUrl: msg.dataUrl,
          config: state.whisperConfig,
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return;
    }
    if (msg?.type === 'SET_EXTRACT') {
      await applyExtract(msg.enabled);
      sendResponse({ ok: true, extractEnabled: state.extractEnabled });
      return;
    }
    if (msg?.type === 'SET_WHISPER_CONFIG') {
      await applyWhisperConfig(msg.config);
      sendResponse({ ok: true, whisperConfig: state.whisperConfig });
      return;
    }
  })();
  return true; // async sendResponse
});
