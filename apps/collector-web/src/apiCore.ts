// fetch 基础设施（2026-10-05 自 api.ts 抽出，偿还 api.ts maxLines 台账；沿 db 层 changes-log.ts
// 先例做单向拆分）：BASE 与 ensureOk。api.ts 仍是对外唯一入口（'@/api'），本文件只服务 api 区段模块，
// 禁止反向 import api.ts（防依赖环）。

export const BASE = '';

// 非 2xx / {ok:false} 统一抛错；parse 负责从 json 取业务字段。
export async function ensureOk<T>(r: Response, parse: (json: any) => T): Promise<T> {
  if (!r.ok) {
    // 尽量带出 server 错误文案（如「扩展离线：…」），带不出回落裸状态码
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error) detail += `：${j.error}`; } catch { /* 非 JSON 忽略 */ }
    throw new Error(detail);
  }
  const json = await r.json();
  if (json.ok === false) throw new Error(json.error ?? 'API error');
  return parse(json);
}
