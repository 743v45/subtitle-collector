// apps/subtitle-collector/storage-prune.mjs
// 全量任务缓存键的过期清理（不依赖 chrome.*，storage 经参数注入便于 node:test）。
//
// 背景：ytChannelVideos:* / upperAllVideos:* / seasonVideos:* 只写不删（TTL 常量只用于
// 缓存命中判断），配额耗尽后 chrome.storage.local.set 静默失败，「每页落盘 + SW 回收兜底」
// 的长任务恢复机制随之失效。各全量任务完成后按自身 TTL 主动淘汰过期键。

/**
 * 删除 storage 中前缀匹配、done 且 fetchedAt 超过 TTL 的缓存键。
 *
 * 只删 done===true 的：done:false 是 SW 中断的中间态残留（恢复扫描要看它）；
 * 值非对象（如 upperInfoAt 的时间戳）或 fetchedAt 缺失/非数字的一律保守保留。
 *
 * @param storage chrome.storage.local（或同接口 mock）
 * @param prefix 缓存键前缀（如 'ytChannelVideos:'）
 * @param ttlMs 缓存 TTL（毫秒）
 * @param now 当前时间戳（默认 Date.now()，测试注入固定值）
 * @returns {Promise<number>} 删除的键数
 */
export async function pruneExpired(storage, prefix, ttlMs, now = Date.now()) {
  const all = await storage.get(null);
  const keys = Object.keys(all).filter((key) => {
    if (!key.startsWith(prefix)) return false;
    const v = all[key];
    if (v == null || typeof v !== 'object') return false;
    return v.done === true && typeof v.fetchedAt === 'number' && now - v.fetchedAt > ttlMs;
  });
  if (keys.length) await storage.remove(keys);
  return keys.length;
}
