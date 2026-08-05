// apps/subtitle-collector/servers.mjs
// 多 collector-server 配置的纯逻辑（不依赖 chrome.*，便于 node:test）。
// 与 connection-mode.mjs / reporting.mjs 同构：键名常量 + 归一/派生纯函数。
//
// 数据形态（首个「数组 + 选中 id」配置）：
//   storage[SERVERS_KEY]       = ServerEntry[]     // [{id,name,url}, ...]
//   storage[ACTIVE_SERVER_KEY] = string | null      // 选中的 entry.id
//   ServerEntry.url = 完整 WS 地址，含可选 ?token=xxx
//     （token 由 server 端生成、嵌在 URL 里；server 也可不要 token——url 无 query 即可）

export const SERVERS_KEY = "servers";
export const ACTIVE_SERVER_KEY = "activeServerId";

/** 内置默认 server（迁移旧版/首装用；对齐旧 config.js 的 SERVER_URL=ws://127.0.0.1:21527/ext） */
export const DEFAULT_SERVER_URL = "ws://127.0.0.1:21527/ext";
export const DEFAULT_SERVER_NAME = "本地 collector";

/**
 * 从完整 server url 派生连接所需的各地址 + token。纯函数。
 * url 形如 ws://host:port/ext[?token=xxx] 或 wss://host:port/ext[?token=xxx]。
 * @returns {{wsUrl:string, httpBase:string, pingUrl:string, token:string|null} | null}
 *   - wsUrl：原样（含 query）——WS 连接用；server 端可从握手 URL query 取 token。
 *   - httpBase：ws→http / wss→https，取 host:port（去 path/query）——popup 直连 HTTP API 用。
 *   - pingUrl：httpBase + '/ping'——background 探活用。
 *   - token：从 query 'token' 提取（无则 null）——hello 握手发，兼容 server 从 hello body 取 token。
 * 非法 url（非 ws/wss、空、解析失败）→ null。
 */
export function parseServerUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let u;
  try { u = new URL(rawUrl.trim()); } catch { return null; }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  const httpScheme = u.protocol === 'wss:' ? 'https' : 'http';
  const httpBase = `${httpScheme}://${u.host}`; // u.host 含 port
  const token = u.searchParams.get('token') || null;
  return { wsUrl: rawUrl.trim(), httpBase, pingUrl: `${httpBase}/ping`, token };
}

/**
 * 选当前激活 server entry。activeId 匹配则取它，否则取首个，空列表/非数组 → null。
 * 容忍 activeId 脏读（旧值/误删）——回退首个，保证总有 server 可连（除非列表空）。
 */
export function resolveActiveServer(servers, activeId) {
  if (!Array.isArray(servers) || servers.length === 0) return null;
  return servers.find((s) => s && typeof s === 'object' && s.id === activeId) ?? servers[0];
}

/**
 * 归一化 server 列表：过滤无 id/url 或 url 非法（parseServerUrl null）的脏项 + 去 id 重 + name 缺失回退 url。
 * 供从 storage 读出后清洗（防手改/旧值致 connect 抛错）。
 */
export function normalizeServers(servers) {
  if (!Array.isArray(servers)) return [];
  const seen = new Set();
  const out = [];
  for (const s of servers) {
    if (!s || typeof s.id !== 'string' || typeof s.url !== 'string') continue;
    if (!parseServerUrl(s.url)) continue; // url 非法 → 丢弃
    if (seen.has(s.id)) continue;         // id 重 → 去重（保留首个）
    seen.add(s.id);
    out.push({ id: s.id, name: typeof s.name === 'string' && s.name ? s.name : s.url, url: s.url });
  }
  return out;
}

/** 生成 server id（popup 新增 server 用）：8 位 [a-z0-9]。 */
export function genServerId() {
  const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += CHARS[Math.floor(Math.random() * CHARS.length)];
  return id;
}

/**
 * 把 url 里的 ?token=xxx 替换为 ?token=***（UI 展示用，防远程凭据明文泄露）。
 * 无 token / 非法 / 非字符串 → 原样返回（不抛错，UI 容错）。
 */
export function maskServerUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return rawUrl;
  return rawUrl.replace(/([?&])token=[^&]*/g, '$1token=***');
}

/**
 * 判断 url 是否本地 server（host ∈ {127.0.0.1, localhost, ::1}）。
 * 本地 URL 的 token 可在 UI 点开看明文；远程始终 mask。非法 / 空 → false。
 */
export function isLocalServer(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const h = new URL(rawUrl.trim()).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch { return false; }
}
