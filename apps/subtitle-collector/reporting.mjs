// apps/subtitle-collector/reporting.mjs
// 上报开关 + 客户端身份的纯逻辑（不依赖 chrome.*，便于 node:test）。
// storage key 用 camelCase 对齐现有 pendingIngests；WS 协议字段用 snake_case，由 background 转换。

export const CLIENT_ID_KEY = "clientId";
export const REPORTING_KEY = "reportingEnabled";

/** 决定是否上报；flag 非 false 一律放行（fail-open，默认开） */
export function shouldReport(flag) {
  return flag !== false;
}

/** 生成客户端唯一 id（优先 crypto.randomUUID，回退兜底） */
export function genClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "ext-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
