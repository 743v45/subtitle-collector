// offscreen document:承载 transformers.js Whisper 推理。
// 收 background 转发的 TRANSCRIBE(带 config),按 config.model/device/language 跑,广播 PROGRESS/RESULT/ERROR。

// transformers 的 onnxruntime 后端默认从 jsdelivr CDN 动态 import ort-wasm-*.mjs,
// 但 MV3 extension_pages CSP 硬性禁止远程脚本(script-src 只能 'self')。
// 改从扩展本地资源加载(copy-ort.mjs 已把 ort 文件拷到 dist/ort/);
// numThreads=1 规避扩展页缺 cross-origin isolation 导致 SharedArrayBuffer 不可用。
import { env } from '@huggingface/transformers';
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');
env.backends.onnx.wasm.numThreads = 1;

import { getModelStatus, downloadModel, createEngine, toSRT, toVTT } from '@voicetxt/core';

let lastProgressAt = 0;
function post(msg) {
  // PROGRESS 节流:core 的 onProgress 每 timestep 触发(高频),不节流会消息洪泛卡 popup。
  // RESULT/ERROR 不节流(必须送达)。最后一帧 PROGRESS 可能丢失,但 RESULT 紧随无碍。
  if (msg.type === 'PROGRESS') {
    const now = Date.now();
    if (now - lastProgressAt < 150) return;
    lastProgressAt = now;
  }
  // popup 可能已关,广播失败忽略
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'TRANSCRIBE') return;
  const { id, mime, dataUrl, config } = msg;
  run(id, mime, dataUrl, config || {}).catch((err) => {
    console.error('[offscreen] transcribe failed:', err);
    post({ type: 'ERROR', id, message: friendlyError(err) });
  });
});

async function run(id, mime, dataUrl, config) {
  const model = config.model || 'tiny';
  const device = config.device || 'wasm';
  const language = config.language || 'zh';
  const wordTimestamps = !!config.wordTimestamps;

  // base64 data URL → blob(chrome.runtime.sendMessage 跨 SW/offscreen 传 ArrayBuffer 不可靠)
  const blob = await (await fetch(dataUrl)).blob();
  post({
    type: 'PROGRESS',
    id,
    phase: 'transcribe',
    ratio: 0,
    message: `解码音频 ${blob.size}B…`,
  });

  // 1. 模型:首次从 HF CDN 下载并缓存 IndexedDB(core createEngine 要求 cached)
  const status = await getModelStatus(model);
  if (status !== 'cached') {
    post({
      type: 'PROGRESS',
      id,
      phase: 'download',
      ratio: 0,
      message: `下载模型 ${model}(首次较慢,缓存后秒回)…`,
    });
    await downloadModel(model, {
      onProgress: (p) =>
        post({
          type: 'PROGRESS',
          id,
          phase: 'download',
          ratio: typeof p?.ratio === 'number' ? p.ratio : 0,
          message: `下载模型 ${model}…`,
        }),
    });
  }

  // 2. 转写(core 内部:Blob → decodeAudio → resampleTo16kMono → Whisper)
  post({ type: 'PROGRESS', id, phase: 'transcribe', ratio: 0, message: '识别中…' });
  const engine = await createEngine({
    model,
    device,
    onProgress: (p) =>
      post({
        type: 'PROGRESS',
        id,
        phase: 'transcribe',
        ratio: typeof p?.ratio === 'number' ? p.ratio : 0,
        message: '识别中…',
      }),
  });
  try {
    const result = await engine.transcribe(blob, { language, wordTimestamps });
    // Phase 3:用 core formats 纯函数一次性格式化,popup 按 format 切换/下载
    post({
      type: 'RESULT',
      id,
      text: result.text || '(未识别到内容)',
      srt: toSRT(result),
      vtt: toVTT(result),
      language: result.language,
    });
  } finally {
    engine.dispose();
  }
}

/** 把底层报错翻成可读提示(对齐 voicetxt transcribe.worker 的 OOM 提示)。 */
function friendlyError(err) {
  const raw = String(err?.message || err);
  if (/allocate|create a session|out of memory|heap/i.test(raw)) {
    return '内存不足(浏览器 WASM 限制):请换更小档位(tiny/base)后重试。';
  }
  return raw;
}
