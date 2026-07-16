import test from "node:test";
import assert from "node:assert/strict";
import {
  WHISPER_CONFIG_KEY,
  resolveWhisperConfig,
  DEFAULT_CONFIG,
  MODELS,
  DEVICES,
  LANGUAGES,
} from "../whisper-config.mjs";

test("WHISPER_CONFIG_KEY 为固定 storage key", () => {
  assert.equal(WHISPER_CONFIG_KEY, "whisperConfig");
});

test("resolveWhisperConfig: 空值/非对象回落默认", () => {
  assert.deepEqual(resolveWhisperConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(resolveWhisperConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(resolveWhisperConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(resolveWhisperConfig([]), DEFAULT_CONFIG);
  assert.deepEqual(resolveWhisperConfig("tiny"), DEFAULT_CONFIG);
});

test("resolveWhisperConfig: 非法字段逐项回落默认", () => {
  assert.equal(resolveWhisperConfig({ model: "huge" }).model, "tiny");
  assert.equal(resolveWhisperConfig({ device: "cuda" }).device, "wasm");
  assert.equal(resolveWhisperConfig({ language: "xx" }).language, "zh");
  assert.equal(
    resolveWhisperConfig({ wordTimestamps: "yes" }).wordTimestamps,
    false,
  );
});

test("resolveWhisperConfig: 合法值全部保留", () => {
  const c = resolveWhisperConfig({
    model: "base",
    device: "wasm",
    language: "en",
    wordTimestamps: true,
  });
  assert.equal(c.model, "base");
  assert.equal(c.device, "wasm");
  assert.equal(c.language, "en");
  assert.equal(c.wordTimestamps, true);
});

test("resolveWhisperConfig: 部分合法部分非法,合法保留非法回落", () => {
  const c = resolveWhisperConfig({ model: "small", language: "bad" });
  assert.equal(c.model, "small");
  assert.equal(c.language, "zh"); // 非法回落
  assert.equal(c.device, "wasm"); // 缺省
});

test("档位/后端/语言枚举完整", () => {
  assert.ok(MODELS.includes("base"));
  assert.ok(DEVICES.includes("wasm"));
  assert.ok(LANGUAGES.includes("zh"));
  assert.ok(!MODELS.includes("sensevoice")); // sherpa 引擎不在 whisper 档位
});
