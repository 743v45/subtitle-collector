// B 站登录态快照解析（自 ws/server.ts 抽出，2026-08-25 偿还复杂度台账）。
// 背景：未登录时充电视频 AI 字幕接口 /x/v2/subtitle/web/view 返回空（2026-08-24 批量
// 1190 no_subtitle 根因），扩展经 hello / login-state 上报登录态，server 侧解析与展示。
export interface BiliLogin {
  is_login: boolean;
  mid?: string;
  uname?: string;
  vip?: boolean;
}

/** DB 列（JSON 字符串）→ BiliLogin；NULL/坏 JSON/畸形结构容错为 null。 */
export function parseLogin(raw: string | null | undefined): BiliLogin | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && typeof v.is_login === 'boolean' ? v as BiliLogin : null;
  } catch {
    return null;
  }
}

/** hello / login-state 消息体里的 login 字段 → BiliLogin；非对象或 is_login 非布尔按 null（未上报）。 */
export function parseLoginMsg(v: unknown): BiliLogin | null {
  return v && typeof v === 'object' && typeof (v as BiliLogin).is_login === 'boolean' ? v as BiliLogin : null;
}
