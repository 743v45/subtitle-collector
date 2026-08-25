// 从 YouTube 首页 HTML 抽登录态（页面内嵌 ytcfg.set 的 LOGGED_IN 布尔）。
// 已登录：cookie 随 host_permissions 自动带 → SSR 输出 "LOGGED_IN":true；
// 未登录："LOGGED_IN":false；无标记（consent 墙/风控页/改版）→ null（探测失败 ≠ 未登录）。
// 背景（2026-08-25）：镜像 bili-login.mjs 先例（4b952b8）——未登录是 YouTube 批量 no_subtitle
// （年龄限制视频播不了）与 pot_limited（pot 受限加重）的直接判因维度，登录态必须上报可观察。
export function extractLoginFromYoutube(page) {
  const html = typeof page?.data === 'string' ? page.data : '';
  const m = html.match(/"LOGGED_IN":\s*(true|false)/);
  return m ? { is_login: m[1] === 'true' } : null;
}

// 采集回执的 yt_login 字段装配：已知登录态 → { yt_login: boolean }；未知（从未探测成功）→ {}（省略字段）。
export function ytLoginInfoOf(cur) {
  return cur ? { yt_login: cur.is_login } : {};
}

// 未登录告警（fetch-youtube-subtitle 开头，§9 可观察性）：判定与文案集中于此，background 只传日志函数。
export function warnYtLoggedOut(cur, videoId, log) {
  if (cur && !cur.is_login) {
    log(`[fetch-youtube-subtitle] YouTube 未登录 videoId=${videoId}：年龄限制视频无法播放、pot 受限加重 → no_subtitle/pot_limited 判因依据`, 'warn');
  }
}
