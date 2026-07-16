// apps/subtitle-extractor/extract-mode.mjs
// 提取转写总开关的纯逻辑(不依赖 chrome.*,便于 node:test)。
// 抄 subtitle-collector/connection-mode.mjs / reporting.mjs 结构。
//
// 语义:控制 Phase 2 的「自动提取」(B站视频页自动提音轨转写)。
// 默认关(fail-closed):显式 true 才开启自动提取;手动 popup 转写不受此开关影响。

export const EXTRACT_KEY = "extractEnabled";

/** 决定是否启用自动提取;仅显式 true 开启(默认关,容忍脏读/旧值)。 */
export function resolveExtractEnabled(v) {
  return v === true;
}
