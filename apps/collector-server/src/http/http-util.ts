import type { IncomingMessage, ServerResponse } from 'node:http';

// HTTP 层共享工具：响应包络、JSON body 读取、handler 异常兜底。
// 单一实现收敛此前散在 8 个 handler 的拷贝（语义已分叉：tasks/clients 静默返回 {}，
// 其余裸 reject 且无人接 —— 一个非法 JSON 请求会以 unhandledRejection 崩掉整个 server）。

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// handler 可预期的失败（非法请求等）；由 runHandler 兜底 catch 转对应状态码
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// 读请求 JSON body：空 body → {}；非法 JSON → reject HttpError(400)
export function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c: string) => (buf += c));
    req.on('error', () => reject(new HttpError(400, 'request body read failed')));
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new HttpError(400, 'invalid JSON body')); }
    });
  });
}

// handler 异常兜底：单个请求的失败（含非法 JSON）只影响该请求，
// 不拖垮进程与其余 HTTP/WS 连接
export async function runHandler(res: ServerResponse, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof HttpError) {
      if (!res.headersSent) json(res, e.status, { ok: false, error: e.message });
      return;
    }
    console.error('[http] handler failed:', e);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
    else res.end();
  }
}

// HTTP /api/* 鉴权判定（此前 token 只护 WS hello，HTTP 控制面完全裸奔）。
// required：仅暴露部署（0.0.0.0 / 放行外部 Host）为 true —— loopback 部署保持免鉴权。
// 放行三条路（任一）：
//   1. Sec-Fetch-Site: same-origin / none —— 同源 fetch/导航与地址栏直达。
//      同源 GET fetch 浏览器不发 Origin 头，只靠 Origin 判同源会把 web 页面的全部 GET 打成 401；
//      Sec-Fetch-Site 由浏览器强制生成（JS 不可伪造），curl/CLI 不携带 → 仍走 Bearer。
//   2. Origin 与 Host 的 hostname 同源（覆盖 POST 等 带 Origin 的请求；反代终结 TLS/改写端口，
//      端口不可靠，比 hostname）。
//   3. 其余（无这些头的 curl/CLI、跨站 Origin）→ 必须 Bearer token。
export interface HttpAuthCheck {
  required: boolean;
  token: string;
  origin?: string;
  host?: string;
  authorization?: string;
  secFetchSite?: string;
}
export function httpAuthOk(c: HttpAuthCheck): boolean {
  if (!c.required) return true;
  if (c.secFetchSite === 'same-origin' || c.secFetchSite === 'none') return true;
  if (c.origin && c.host) {
    let originHostname: string | null = null;
    try { originHostname = new URL(c.origin).hostname; } catch { originHostname = null; }
    const hostHostname = c.host.split(':')[0];
    if (originHostname && originHostname === hostHostname) return true;
  }
  return c.authorization === `Bearer ${c.token}`;
}

// HTTP Origin/Host 准入校验（main.ts 对 /ping 外所有请求统一执行）。
// loopback HTTP 对浏览器是真实攻击面——DNS rebinding 可绕同源策略读 /api/* 与静态页，
// 故先校验 Host（非 loopback 且未显式放行的 hostname 直接拒），再校验 Origin
// （浏览器请求须来自扩展或同源；curl / 服务端同源 fetch 无 Origin，放行）。
export interface OriginCheck {
  /** 请求 Host 头 */
  host?: string;
  /** 请求 Origin 头（缺省视为非浏览器请求） */
  origin?: string;
  /** 显式放行的非 loopback 主机（COLLECTOR_ALLOWED_HOSTS，暴露部署用） */
  allowedHosts: string[];
}
export function httpOriginAllowed(c: OriginCheck): boolean {
  const host = String(c.host ?? '').split(':')[0];
  const isLoopback = host === 'localhost' || host === '127.0.0.1';
  const isAllowedExtra = c.allowedHosts.includes(host);
  if (!isLoopback && !isAllowedExtra) return false; // DNS rebinding：非 loopback 且未显式放行直接拒
  const origin = c.origin;
  if (!origin) return true;
  const o = String(origin);
  if (o.startsWith('chrome-extension://')) return true; // 扩展
  // Origin 解析出 hostname 精确匹配（端口任意）：与 allowedHosts 分支同款防前缀注入
  // （startsWith('http://localhost') 会放行 http://localhost.evil.com）。
  let hostname: string | null = null;
  let schemeOk = false;
  try {
    const u = new URL(o);
    hostname = u.hostname;
    schemeOk = u.protocol === 'http:' || u.protocol === 'https:';
  } catch { hostname = null; }
  if (!hostname || !schemeOk) return false; // 非法 Origin / 非 http(s) scheme 一律拒
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true; // 同源 collector-web（loopback，端口任意）
  return c.allowedHosts.some((h) => hostname === h); // 显式放行的主机（精确 hostname）
}
