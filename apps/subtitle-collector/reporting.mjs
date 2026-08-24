// apps/subtitle-collector/reporting.mjs
// 上报开关 + 客户端身份的纯逻辑（不依赖 chrome.*，便于 node:test）。
// storage key 用 camelCase 对齐现有 pendingIngests；WS 协议字段用 snake_case，由 background 转换。

export const CLIENT_ID_KEY = "clientId";
export const CLIENT_NAME_KEY = "clientName"; // 客户端名字（popup 可改名，id 不变）
export const REPORTING_KEY = "reportingEnabled";

/** 决定是否上报；flag 非 false 一律放行（fail-open，默认开） */
export function shouldReport(flag) {
  return flag !== false;
}

// 8 位客户端 id 字符集：小写字母+数字，剔除歧义字符 0/o/1/i/l，便于人工识读与 CLI 输入。
const CLIENT_ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // 31 chars
const CLIENT_ID_LEN = 8;

// 客户端名字长度上限（按 code points 计，中文/emoji 友好；人工识读足够，防超长滥用）。
const CLIENT_NAME_MAX = 32;

/**
 * 归一客户端名字：非字符串 / 纯空白 → null（未命名）；trim 后超长截断到 32 code points。
 * null 语义 = 未命名/清除（hello 显式带 client_name: null 可抹掉 server 侧旧名）。
 */
export function normalizeClientName(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cps = Array.from(trimmed);
  return cps.length <= CLIENT_NAME_MAX ? trimmed : cps.slice(0, CLIENT_NAME_MAX).join("");
}

/**
 * 生成 8 位客户端唯一 id（getRandomValues 优先，Math.random 兜底）。
 * 取值空间 31^8 ≈ 8.5e11，单机本地身份足够；去歧义字符方便在 popup 展示
 * 和 CLI `clients <id>` 输入时人工识读。server 端仅要求非空字符串，无格式校验。
 */
export function genClientId() {
  const pick = (n) => CLIENT_ID_ALPHABET[n % CLIENT_ID_ALPHABET.length];
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buf = new Uint32Array(CLIENT_ID_LEN);
    crypto.getRandomValues(buf);
    let s = "";
    for (let i = 0; i < CLIENT_ID_LEN; i++) s += pick(buf[i]);
    return s;
  }
  let s = "";
  for (let i = 0; i < CLIENT_ID_LEN; i++) s += pick(Math.floor(Math.random() * CLIENT_ID_ALPHABET.length));
  return s;
}
