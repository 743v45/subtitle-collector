// apps/subtitle-collector/navigate-guard.mjs
// navigate 命令的目标 URL/host 白名单兜底校验 + 命令处理入口（C6）。
// server 端同款校验在 apps/collector-server/src/http/clients.ts（validateNavigateUrl /
// NAVIGATE_HOST_SUFFIXES）：depcruise 禁跨 app import，两端各自实现，但保持同一份清单字面量
// （本文件 NAVIGATE_HOST_SUFFIXES ↔ clients.ts NAVIGATE_HOST_SUFFIXES，注释互指），改动须两端同步。
// 分工：server 在 HTTP 入口已拦（400），扩展端是兜底——防旁路通道/直连 WS 的越权导航；
// 扩展端无 HTTP 状态可回，校验失败只打日志（带目标 URL）并静默丢弃该消息。
// 结构（2026-10-04 偿还：校验+开 tab+回执整体下沉，background.js 的 navigate case 只剩一行委托，
// 避免 WS 消息主处理圈复杂度越过静态台账锁定线）：resolveNavigateTarget / isAllowedNavigateHost /
// isAllowedNavigateUrl 为纯逻辑（不依赖 chrome.*，node:test 直测）；handleNavigateCommand 是
// background 的命令委托入口（依赖全局 chrome.tabs 与传入的 ws；node:test 经 globalThis.chrome 注入）。

// 导航白名单族（域本身 + 任意子域）：bilibili.com / youtube.com / douyin.com 三平台。
// 与 server 端 clients.ts 的 NAVIGATE_HOST_SUFFIXES 为同一份字面量。
export const NAVIGATE_HOST_SUFFIXES = ['bilibili.com', 'youtube.com', 'douyin.com'];

/** host 是否在导航白名单族：等于白名单域或以其为子域后缀（www./m./search./space. 等放行；大小写不敏感） */
export function isAllowedNavigateHost(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  return NAVIGATE_HOST_SUFFIXES.some((d) => h === d || h.endsWith(`.${d}`));
}

/** navigate 目标 URL 解析+校验：合法返回原 URL（原样透传给 chrome.tabs.create），非法（不可解析 / 非 http(s) / host 不在白名单族）返回 null */
export function resolveNavigateTarget(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!isAllowedNavigateHost(u.hostname)) return null;
  return url;
}

/** navigate 目标 URL 校验（布尔便捷封装）：必须可解析、http(s) 协议、host 在白名单族 */
export function isAllowedNavigateUrl(url) {
  return resolveNavigateTarget(url) !== null;
}

/** background.js navigate case 的整体委托：校验 → chrome.tabs.create → 回执 ok:true；被拒打日志（带目标 URL）并静默丢弃（不回 result，server 侧按超时收尾） */
export async function handleNavigateCommand(ws, msg) {
  const target = resolveNavigateTarget(msg.url);
  if (!target) {
    console.warn(`[background] navigate 目标被拒（非法 URL / 非 http(s) / host 不在白名单族），忽略消息 url=${msg.url}`);
    return;
  }
  await chrome.tabs.create({ url: target });
  ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { opened: true } }));
}
