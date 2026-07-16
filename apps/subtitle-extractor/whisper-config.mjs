// apps/subtitle-extractor/whisper-config.mjs
// 模型参数的纯逻辑(不依赖 chrome.*,便于 node:test)。
// 抄 subtitle-collector 开关四段链路:定义 → storage → apply* → popup hook → offscreen 消费。
//
// 仅支持 whisper 引擎档位(走 transformers.js);不含 sensevoice/paraformer(那是 core 的 sherpa 引擎分支,需 sherpa wasm,后续)。

export const WHISPER_CONFIG_KEY = "whisperConfig";

/** 可选模型档位(对齐 @voicetxt/core ModelId 的 whisper 子集) */
export const MODELS = ["tiny", "base", "small", "medium", "turbo"];
/** 推理后端;wasm 稳定(默认),webgpu 对部分模型乱码 */
export const DEVICES = ["wasm", "webgpu"];
/** 识别语言;auto 自动检测,其余指定 */
export const LANGUAGES = [
  "auto",
  "zh",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "ru",
  "it",
  "pt",
  "ar",
];

/** 默认配置:language=zh(对齐 beer.mp3 中文场景),model=tiny(最小先跑通) */
export const DEFAULT_CONFIG = {
  model: "tiny",
  device: "wasm",
  language: "zh",
  wordTimestamps: false,
};

/** 归一化存储值 → 合法配置(容忍脏读/旧值/缺字段,逐字段回落默认)。 */
export function resolveWhisperConfig(v) {
  const raw = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  return {
    model: MODELS.includes(raw.model) ? raw.model : DEFAULT_CONFIG.model,
    device: DEVICES.includes(raw.device) ? raw.device : DEFAULT_CONFIG.device,
    language: LANGUAGES.includes(raw.language)
      ? raw.language
      : DEFAULT_CONFIG.language,
    wordTimestamps: raw.wordTimestamps === true,
  };
}
