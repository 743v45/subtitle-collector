// apps/subtitle-collector/upper-cache.mjs
// UP 全量视频缓存（upperAllVideos:{mid}）的命中判定（纯函数，不依赖 chrome.*，便于 node:test）。
//
// 背景：同一 B 站 UP 列表曾有四条独立的全量分页拉取路径（popup 全量任务、WS list-upper-videos
// 单页逐页、server expandUpperVideos、CLI collectUpperVideosAll）。popup 全量任务已把完整结果
// 落在 storage（1h TTL）；WS 路径（server/web「按 UP 批量」、CLI）每次点开都逐页全量重拉——
// 分钟级、页间节流防风控，纯浪费。命中判定复用该缓存：一次回执返回全部 items，
// server/CLI 的翻页循环第一页拿到 items.length >= total 即自然终止，循环体无需改动。

/**
 * 判定 upperAllVideos:{mid} 缓存是否可复用，命中返回 WS 回执 data 形状。
 *
 * 命中条件：items 为数组 && done === true && 无 error && fetchedAt 距今 < TTL
 * （与 background.js fetchAllUpperVideos 的缓存短路同款条件）。
 * total 取 items.length 而非缓存存的 total：分页停滞提前终止（noNewStreak）时存量 total
 * 可能大于 items.length，用 items.length 才能保证翻页调用方第一页即 break。
 *
 * @param cached storage 里 `upperAllVideos:${mid}` 的值（可能不存在/形状不符）
 * @param ttlMs 缓存 TTL（毫秒，与 fetchAllUpperVideos 共用 UPPER_ALL_TTL_MS）
 * @param now 当前时间戳（默认 Date.now()，测试注入固定值）
 * @returns {{ total: number, items: unknown[] } | null} 命中返回回执 data；未命中返回 null（调用方走原拉取逻辑）
 */
export function upperAllCacheHit(cached, ttlMs, now = Date.now()) {
  if (cached == null || typeof cached !== 'object') return null;
  if (!Array.isArray(cached.items)) return null;
  if (cached.done !== true || cached.error != null) return null;
  if (typeof cached.fetchedAt !== 'number' || now - cached.fetchedAt >= ttlMs) return null;
  return { total: cached.items.length, items: cached.items };
}
