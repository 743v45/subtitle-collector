// api 封装层共享基建：BASE 前缀 + ensureOk 统一解包/报错。
// 2026-10 自 api.ts 拆出（Phase 1 新端点入列后 api.ts 撞 maxLines ≤400 台账线），
// api.ts 与 api-extra.ts 共用；不对外承诺稳定性，页面一律经由 api.ts / api-extra.ts 的端点函数访问。
export const BASE = '';

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
