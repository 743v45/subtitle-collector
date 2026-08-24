// 从 /x/web-interface/nav 响应抽 B 站登录态（isLogin/mid/uname/vipStatus）。
// 未登录：code=0 + data.isLogin=false（wbi_img 仍有，wbi 签名不受影响）；
// 已登录：data.isLogin=true + mid(number)/uname/vipStatus。
// 背景（2026-08-24）：充电视频的 AI 字幕接口 /x/v2/subtitle/web/view 未登录返回空
// （content-length 2），批量采集派到未登录浏览器时 1190 个充电视频整批 no_subtitle——
// 登录态必须上报 server 可观察（hello / login-state / fetch-subtitle 回执）。
export function extractLoginFromNav(navData) {
  const d = navData?.data ?? {};
  const isLogin = d.isLogin === true;
  return {
    is_login: isLogin,
    ...(isLogin ? {
      mid: typeof d.mid === 'number' ? String(d.mid) : undefined,
      uname: typeof d.uname === 'string' && d.uname ? d.uname : undefined,
      vip: d.vipStatus === 1,
    } : {}),
  };
}

// 采集回执的 login 字段装配：已知登录态 → { login: boolean }；未知（从未探测成功）→ {}（省略字段）。
export function loginInfoOf(cur) {
  return cur ? { login: cur.is_login } : {};
}

// 未登录告警（fetch-subtitle 开头，§9 可观察性）：把判定与文案集中于此，background 只传日志函数。
export function warnLoggedOut(cur, bvid, log) {
  if (cur && !cur.is_login) {
    log(`[fetch-subtitle] B 站未登录 bvid=${bvid}：充电视频 AI 字幕列表将拿不到（/x/v2/subtitle/web/view 未登录返回空）`, 'warn');
  }
}

// 登录态缓存状态机（自 background.js 抽出，2026-08-25 偿还复杂度台账）：
// TTL 缓存 + 变化即回调（background 拿回调发 login-state 推送）。探测失败保留旧值
// （探测失败 ≠ 未登录）；TTL 内重复调用零请求。fetchNav 注入（返回 biliFetch 形态），便于测试。
export function createLoginTracker({ fetchNav, onChange, ttlMs = 10 * 60 * 1000 }) {
  let login = null;
  let checkedAt = 0;
  return {
    get current() { return login; },
    async maybeRefresh(force = false) {
      if (!force && login && Date.now() - checkedAt <= ttlMs) return login;
      try {
        const parsed = await fetchNav();
        if (parsed?.ok) {
          const next = extractLoginFromNav(parsed);
          const changed = JSON.stringify(login) !== JSON.stringify(next);
          login = next; checkedAt = Date.now();
          if (changed && onChange) onChange(next);
        }
      } catch { /* nav 异常静默：探测失败 ≠ 未登录 */ }
      return login;
    },
  };
}
