// apps/subtitle-collector/fetch-resume.mjs
// MV3 长任务中断恢复的选取逻辑（纯函数，不依赖 chrome.*，storage 快照经参数传入便于 node:test）。
//
// 背景：全量拉取的任务态（inflight 集合）在 SW 内存、数据态在 storage。SW 中途被杀后
// storage 残留 {done:false, error:null} 的永久中间态——popup 触发的任务重开 popup 会续拉，
// CLI 经 WS 触发的（如 list-yt-channel-videos）无人再重触发，部分结果没有消费者。

/** 中断宽限：done:false 超过该时限才判定为 SW 死亡残留（正常慢拉取不误判；inflight 互斥双保险） */
export const RESUME_GRACE_MS = 5 * 60 * 1000;

/**
 * 从 storage 全量快照中选出需重触发的全量拉取键。
 *
 * 选取条件：前缀匹配 && done === false && error == null && fetchedAt 为数字且距今超过宽限期。
 * （写入侧每页 persist 固定 error:null、收尾才置 done:true，done:false 即从未走到收尾。）
 *
 * @param all storage.get(null) 的快照
 * @param prefixes 关注的键前缀（如 ['ytChannelVideos:', 'upperAllVideos:']）
 * @param now 当前时间戳（默认 Date.now()）
 * @param graceMs 中断宽限（默认 RESUME_GRACE_MS）
 * @returns {{ key: string, prefix: string, id: string }[]} id 为键去掉前缀后的任务标识
 */
export function selectStaleFetches(all, prefixes, now = Date.now(), graceMs = RESUME_GRACE_MS) {
  const out = [];
  for (const key of Object.keys(all)) {
    const prefix = prefixes.find((p) => key.startsWith(p));
    if (!prefix) continue;
    const v = all[key];
    if (v == null || typeof v !== 'object') continue;
    if (v.done !== false || v.error != null) continue;
    if (typeof v.fetchedAt !== 'number' || now - v.fetchedAt <= graceMs) continue;
    out.push({ key, prefix, id: key.slice(prefix.length) });
  }
  return out;
}
