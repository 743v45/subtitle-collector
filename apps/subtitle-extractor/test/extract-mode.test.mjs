import test from "node:test";
import assert from "node:assert/strict";
import { EXTRACT_KEY, resolveExtractEnabled } from "../extract-mode.mjs";

test("EXTRACT_KEY 为固定 storage key", () => {
  assert.equal(EXTRACT_KEY, "extractEnabled");
});

test("resolveExtractEnabled: 仅显式 true 开启(fail-closed)", () => {
  assert.equal(resolveExtractEnabled(true), true);
  assert.equal(resolveExtractEnabled(false), false);
  assert.equal(resolveExtractEnabled(undefined), false);
  assert.equal(resolveExtractEnabled(null), false);
  assert.equal(resolveExtractEnabled("true"), false); // 非布尔 true 不放行
  assert.equal(resolveExtractEnabled(1), false);
});
