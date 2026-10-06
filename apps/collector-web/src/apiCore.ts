// fetch 基础设施（2026-10-05 自 api.ts 抽出，偿还 api.ts maxLines 台账；沿 db 层 changes-log.ts
// 先例做单向拆分）：BASE、apiFetch（统一注入访问 token）与 ensureOk。api.ts 仍是对外唯一入口
// （'@/api'），本文件只服务 api 区段模块，禁止反向 import api.ts（防依赖环）。
import { getToken, notifyAuthRequired } from './authToken';

export const BASE = '';

// api 层统一 fetch 入口（2026-10-07）：localStorage 有访问 token 时全请求注入
// `Authorization: Bearer <t>`——暴露部署下老 WebView 等不发 Sec-Fetch-Site 的客户端
// 靠它过 /api/* 的 Bearer 校验（同源豁免对这类客户端不生效，2026-10-07 生产 401 实测）。
// 无 token 时不加头，行为与注入前完全一致（loopback / 现代浏览器同源豁免形态）。
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  if (!token) return fetch(url, init);
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

// 非 2xx / {ok:false} 统一抛错；parse 负责从 json 取业务字段。
// 401 额外派发全局信号（authToken.AUTH_REQUIRED_EVENT）——App 顶部 token 横幅监听显示输入框，
// 与具体页面解耦（任何 tab 的任何请求 401 都走同一条横幅）。
export async function ensureOk<T>(r: Response, parse: (json: any) => T): Promise<T> {
  if (!r.ok) {
    if (r.status === 401) notifyAuthRequired();
    // 尽量带出 server 错误文案（如「扩展离线：…」），带不出回落裸状态码
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error) detail += `：${j.error}`; } catch { /* 非 JSON 忽略 */ }
    throw new Error(detail);
  }
  const json = await r.json();
  if (json.ok === false) throw new Error(json.error ?? 'API error');
  return parse(json);
}
