// 客户端卡平台登录态徽章（自 ClientsPage.tsx 抽出，2026-08-25 偿还复杂度台账）。
// B 站背景：未登录时充电视频 AI 字幕接口返回空——派给该客户端的批量采集整批 no_subtitle
// （2026-08-24 批次 1190 例根因）。YouTube 镜像（2026-08-25）：未登录时年龄限制视频播不了、
// 字幕 pot 受限加重（no_subtitle/pot_limited 判因）——快照同形（B 站多账号字段）。
import type { BiliLoginInfo } from '../types';

const PLATFORM_META = {
  bilibili: {
    loggedText: 'B 站已登录',
    loggedOutText: 'B 站未登录',
    loggedTitle: '该浏览器的 B 站登录态（充电视频 AI 字幕需要登录态才拿得到）',
    loggedOutTitle: '充电视频的 AI 字幕接口未登录时返回空——派给该客户端的批量采集会整批 no_subtitle。在该浏览器登录 B 站后自动恢复。',
  },
  youtube: {
    loggedText: 'YouTube 已登录',
    loggedOutText: 'YouTube 未登录',
    loggedTitle: '该浏览器的 YouTube 登录态（年龄限制视频需要登录态才播得了、字幕 pot 受限加重）',
    loggedOutTitle: '未登录时年龄限制视频播不了、字幕 pot 受限加重——批量 no_subtitle/pot_limited 的判因依据。在该浏览器登录 YouTube 后自动恢复。',
  },
} as const;

export function ClientLoginBadge({ login, platform }: { login: BiliLoginInfo | null; platform: keyof typeof PLATFORM_META }) {
  const meta = PLATFORM_META[platform];
  // null = 旧版扩展未上报过，不渲染（无信息不是错误）
  if (!login) return null;
  if (!login.is_login) {
    return (
      <div className="mt-1">
        <span
          className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300"
          title={meta.loggedOutTitle}
        >
          {meta.loggedOutText}
        </span>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs">
      <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" title={meta.loggedTitle}>
        {meta.loggedText}
      </span>
      {/* YouTube 快照无账号字段（探测标记只有 is_login），只显绿标 */}
      {platform === 'bilibili' && (
        <span className="text-muted-foreground">
          {login.uname ?? '（未取到昵称）'}
          {login.mid ? `（${login.mid}）` : ''}
          {login.vip && <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">大会员</span>}
        </span>
      )}
    </div>
  );
}
