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
    // Phase 2:content 从 B站 player API 拿到音轨 URL,background 免 CORS fetch m4s → offscreen 转写
    if (msg?.type === 'FETCH_AUDIO') {
      try {
        const dataUrl = await fetchAudioToDataUrl(
          msg.audioUrl,
          msg.backupUrls ?? [],
        );
        await ensureOffscreen();
        await chrome.runtime.sendMessage({
          type: 'TRANSCRIBE',
          id: Date.now(),
          filename: `${msg.title || msg.bvid || 'audio'}.m4s`,
          mime: 'audio/mp4',
          dataUrl,
          config: state.whisperConfig,
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return;
    }
  })();
  return true; // async sendResponse
});

/**
 * 抓 B站音轨 m4s:host_permissions 免 CORS,Referer 绕防盗链;失败试 backupUrl。
 * arrayBuffer → base64 data URL(offscreen 用 base64 传输,ArrayBuffer 跨 messaging 损坏)。
 */
async function fetchAudioToDataUrl(primaryUrl, backupUrls) {
  const headers = { Referer: 'https://www.bilibili.com/' };
  const urls = [primaryUrl, ...backupUrls].filter(Boolean);
  let lastErr;
  for (const u of urls) {
    try {
      const resp = await fetch(u, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ab = await resp.arrayBuffer();
      return arrayBufferToBase64DataUrl(ab, 'audio/mp4');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('无可用音轨 URL');
}

/** arrayBuffer → base64 data URL(分块避免 btoa 栈溢出)。 */
function arrayBufferToBase64DataUrl(ab, mime) {
  const bytes = new Uint8Array(ab);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
