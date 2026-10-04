// apps/subtitle-collector/navigate-guard.mjs
// navigate 命令的目标 URL/host 白名单兜底校验（C6，纯逻辑，不依赖 chrome.*，便于 node:test）。
// server 端同款校验在 apps/collector-server/src/http/clients.ts（validateNavigateUrl /
// NAVIGATE_HOST_SUFFIXES）：depcruise 禁跨 app import，两端各自实现，但保持同一份清单字面量
// （本文件 NAVIGATE_HOST_SUFFIXES ↔ clients.ts NAVIGATE_HOST_SUFFIXES，注释互指），改动须两端同步。
// 分工：server 在 HTTP 入口已拦（400），扩展端是兜底——防旁路通道/直连 WS 的越权导航；
// 扩展端无 HTTP 状态可回，校验失败只打日志（带目标 URL）并静默丢弃该消息。

// 导航白名单族（域本身 + 任意子域）：bilibili.com / youtube.com / douyin.com 三平台。
// 与 server 端 clients.ts 的 NAVIGATE_HOST_SUFFIXES 为同一份字面量。
export const NAVIGATE_HOST_SUFFIXES = ['bilibili.com', 'youtube.com', 'douyin.com'];

/** host 是否在导航白名单族：等于白名单域或以其为子域后缀（www./m./search./space. 等放行；大小写不敏感） */
export function isAllowedNavigateHost(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  return NAVIGATE_HOST_SUFFIXES.some((d) => h === d || h.endsWith(`.${d}`));
}

/** navigate 目标 URL 校验：必须可解析、http(s) 协议、host 在白名单族 */
export function isAllowedNavigateUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return isAllowedNavigateHost(u.hostname);
}
