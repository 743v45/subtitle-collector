// apps/subtitle-collector/connection-mode.mjs
// 连接模式（server / 纯扩展）的纯逻辑（不依赖 chrome.*，便于 node:test）。
// storage key 用 camelCase 对齐现有 reportingEnabled / clientId；
// 模式值用小写字符串，background 读 storage 后用 resolveConnectionMode 归一。

export const CONNECTION_MODE_KEY = "connectionMode";

/** 连本地 collector-server（默认，向后兼容） */
export const MODE_SERVER = "server";
/** 纯扩展：不连 server、不上报，只保留本地字幕捕获/复制 */
export const MODE_STANDALONE = "standalone";

/**
 * 归一化存储值 → 模式。非 'standalone' 一律视作 'server'
 * （fail-回 server：undefined / 旧值 / 误写均回落到「连 server」，保持向后兼容）。
 */
export function resolveConnectionMode(v) {
  return v === MODE_STANDALONE ? MODE_STANDALONE : MODE_SERVER;
}

/** 是否纯扩展模式（不连 server、不上报）。归一后判定，容忍脏读。 */
export function isStandalone(mode) {
  return resolveConnectionMode(mode) === MODE_STANDALONE;
}

/**
 * 把连接状态归约为 UI 展示决策。
 * loading 优先返回 'loading'——避免首帧用默认值（mode='server'、connected=false）渲染
 * toggle 与状态点、真实值异步到达后翻转闪烁（useConnectionStatus 首帧 loading=true）。
 * @param {{loading?:boolean, mode?:string, connected?:boolean, error?:string|null}} conn
 * @returns {{phase:'loading'} | {phase:'standalone'} | {phase:'server', connected:boolean, error:string|null}}
 */
export function resolveConnDisplay(conn) {
  if (conn?.loading) return { phase: 'loading' };
  if (isStandalone(conn?.mode)) return { phase: 'standalone' };
  const connected = !!conn?.connected;
  // server：已连接 → error 强制 null（连上了旧错误无意义）；未连接 → 透传 error（hello-nack bad token / 不可达等）
  return { phase: MODE_SERVER, connected, error: connected ? null : (conn?.error ?? null) };
}
