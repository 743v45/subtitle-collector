// web 访问 token 的本地存取（2026-10-07，账本 U-1 方向）：
// 暴露部署（COLLECTOR_HOST=0.0.0.0）下 /api/* 强制 Bearer，同源豁免依赖浏览器 Sec-Fetch-Site
// 元数据头——老 WebView/特定环境不发该头，整批接口 401（2026-10-07 生产实测）。前端保存 token
// 后 api 层统一注入 Authorization，对一切客户端形态免疫，不削弱 server 安全模型（Bearer 通道原样）。
// token 只存本机 localStorage，不进 URL 不进日志；清空 = 移除（回退同源豁免形态）。
const KEY = 'collector-token';

export function getToken(): string {
  try { return window.localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}

export function setToken(t: string): void {
  try {
    const trimmed = t.trim();
    if (trimmed) window.localStorage.setItem(KEY, trimmed);
    else window.localStorage.removeItem(KEY);
  } catch { /* localStorage 不可用（隐私模式）：静默退化为无 token 形态 */ }
}

// 401 全局信号：api 层收到 401 时派发，App 顶部的 token 横幅监听显示输入框。
// 用 CustomEvent 而非状态提升——api 层与 UI 解耦，任何页面任何请求触发都走同一条横幅。
export const AUTH_REQUIRED_EVENT = 'collector-auth-required';

export function notifyAuthRequired(): void {
  try { window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT)); } catch { /* 非浏览器环境忽略 */ }
}
