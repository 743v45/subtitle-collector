// 客户端卡 B 站登录态徽章（自 ClientsPage.tsx 抽出，2026-08-25 偿还复杂度台账）。
// 背景：未登录时充电视频 AI 字幕接口返回空——派给该客户端的批量采集整批 no_subtitle
// （2026-08-24 批次 1190 例根因），徽章让该状态在客户端页一眼可见。
import type { BiliLoginInfo } from '../types';

export function ClientLoginBadge({ login }: { login: BiliLoginInfo | null }) {
  // null = 旧版扩展未上报过，不渲染（无信息不是错误）
  if (!login) return null;
  if (!login.is_login) {
    return (
      <div className="mt-1">
        <span
          className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300"
          title="充电视频的 AI 字幕接口未登录时返回空——派给该客户端的批量采集会整批 no_subtitle。在该浏览器登录 B 站后自动恢复。"
        >
          B 站未登录
        </span>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs">
      <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" title="该浏览器的 B 站登录态（充电视频 AI 字幕需要登录态才拿得到）">
        B 站已登录
      </span>
      <span className="text-muted-foreground">
        {login.uname ?? '（未取到昵称）'}
        {login.mid ? `（${login.mid}）` : ''}
        {login.vip && <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">大会员</span>}
      </span>
    </div>
  );
}
