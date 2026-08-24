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
