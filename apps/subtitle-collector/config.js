// 扩展侧配置。
// 注：SERVER_URL / PING_URL / TOKEN 已迁至 servers.mjs（支持多 server 配置 + 热切换）：
//   - SERVER_URL / PING_URL 由 parseServerUrl(entry.url) 派生（ws→http、+ /ping）。
//   - TOKEN 由 url 的 ?token= 携带（server 端生成、可选；hello 握手 + url query 双发）。
//   - 多 server 列表存 storage[servers]、激活项存 storage[activeServerId]。
// API_BASE 暂留：popup hooks.ts 直连本地 API 用（阶段 2 改为从激活 server 派生 httpBase，本常量届时移除）。
export const API_BASE = "http://127.0.0.1:21527";
