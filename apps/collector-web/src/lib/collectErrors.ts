// 采集编排错误文案统一（Phase 3：搜索卡/合集卡/资料刷新共用）：
// 503（扩展未连接）→ 固定指引文案；其余（502 风控/需登录、版本过旧等）原文透出。
export function collectErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('HTTP 503') ? '扩展离线：请在浏览器扩展 popup 侧确认' : msg;
}
