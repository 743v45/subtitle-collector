// 登录态快照解析（自 ws/server.ts 抽出，2026-08-25 偿还复杂度台账）。
// B 站背景：未登录时充电视频 AI 字幕接口 /x/v2/subtitle/web/view 返回空（2026-08-24 批量
// 1190 no_subtitle 根因），扩展经 hello / login-state 上报登录态，server 侧解析与展示。
// YouTube 同构（2026-08-25 镜像）：未登录时年龄限制视频播不了、pot 受限加重——快照同形
//（is_login 必带；B 站多 mid/uname/vip，YouTube 只 is_login），解析与容错形状无关、共用。
export interface LoginSnapshot {
  is_login: boolean;
  mid?: string;
  uname?: string;
  vip?: boolean;
}

/** B 站登录态（带账号字段）；既有引用兼容别名。 */
export type BiliLogin = LoginSnapshot;

/** YouTube 登录态（无账号字段——探测标记只有 is_login 布尔）。 */
export type YtLogin = LoginSnapshot;

/** DB 列（JSON 字符串）→ 登录态快照；NULL/坏 JSON/畸形结构容错为 null。 */
export function parseLogin(raw: string | null | undefined): LoginSnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && typeof v.is_login === 'boolean' ? v as LoginSnapshot : null;
  } catch {
    return null;
  }
}

/** hello / login-state 消息体里的 login / yt_login 字段 → 快照；非对象或 is_login 非布尔按 null（未上报）。 */
export function parseLoginMsg(v: unknown): LoginSnapshot | null {
  return v && typeof v === 'object' && typeof (v as LoginSnapshot).is_login === 'boolean' ? v as LoginSnapshot : null;
}
