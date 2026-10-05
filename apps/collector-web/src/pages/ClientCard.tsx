// 客户端卡（2026-10-05 自 ClientsPage 抽出，偿还行数台账；Q8c 离线提示同批落地）：
// 名字优先展示（popup 改名，id 不变）；在线/离线状态与时长；离线不渲染远程操作按钮（须在线 404），
// 并加灰字「离线中——远程操作按钮仅在线时可用」说明（Q8c）。
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ClientLoginBadge } from '../components/ClientLoginBadge';
import { Pause, Play } from 'lucide-react';
import type { ClientInfo } from '../types';

// 在线/离线时长（ms → 中文短句；轮询每 3s 随刷新重算）
function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return '不到 1 分钟';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} 天${h % 24 ? ` ${h % 24} 小时` : ''}`;
}

export function ClientCard({ c, now, busy, onToggleReporting, onToggleDispatch }: {
  c: ClientInfo;
  now: number;
  busy: boolean;
  onToggleReporting: (c: ClientInfo) => void;
  onToggleDispatch: (c: ClientInfo) => void;
}) {
  // 两开关按钮的文案/图标/变体预计算（各以 1 个三元替代 4 个，降 ClientCard 复杂度）
  const dispatchOn = c.task_dispatch_enabled === true;
  const dispatchBtn = dispatchOn
    ? { variant: 'outline' as const, icon: <Pause className="size-4" aria-hidden="true" />, label: '停派任务', title: '停派后调度器不再给该客户端派采集任务（仅保持连接上报）' }
    : { variant: 'default' as const, icon: <Play className="size-4" aria-hidden="true" />, label: '恢复接任务', title: '恢复后调度器可正常派发采集任务' };
  const reportingOn = c.reporting_enabled === true;
  const reportingBtn = reportingOn
    ? { variant: 'default' as const, icon: <Pause className="size-4" aria-hidden="true" />, label: '暂停自动上报', cls: 'bg-emerald-700 hover:bg-emerald-700/90' }
    : { variant: 'outline' as const, icon: <Play className="size-4" aria-hidden="true" />, label: '恢复自动上报', cls: '' };
  return (
    <Card>
      <div className="flex flex-row items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="truncate text-base font-medium">{c.client_name ?? c.client_id}</div>
            {c.client_name && (
              <code className="shrink-0 font-mono text-xs text-muted-foreground">{c.client_id}</code>
            )}
            {dispatchOn === false && c.connected && (
              <span
                className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                title="server 调度器不再给该客户端派采集任务（保持连接上报）"
              >
                仅上报状态
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={c.connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/60'}>
              {c.connected ? '●' : '○'}
            </span>
            {/* connected_at null 即离线（server 保证与 connected 一致）：在线时长从连接建立起算，离线从断开时刻起算 */}
            {c.connected_at != null
              ? <span>在线 {fmtDuration(now - c.connected_at)}</span>
              : <span>离线 {fmtDuration(now - c.last_seen_at)} · 最后在线 {new Date(c.last_seen_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
            }
            <span>· 版本 {c.ext_version ?? '-'}</span>
          </div>
          {/* Q8c 离线提示：解释为何远程操作按钮消失（离线卡不渲染按钮，避免误以为坏了） */}
          {!c.connected && (
            <div className="text-xs text-muted-foreground/70">离线中——远程操作按钮仅在线时可用</div>
          )}
          {/* 平台登录态（B 站：2026-08-24 充电视频 no_subtitle 判因；YouTube：2026-08-25 镜像——年龄限制/pot 受限判因） */}
          <ClientLoginBadge login={c.bili_login} platform="bilibili" />
          <ClientLoginBadge login={c.yt_login} platform="youtube" />
        </div>
        {c.connected && (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant={dispatchBtn.variant} size="sm" disabled={busy} onClick={() => onToggleDispatch(c)} title={dispatchBtn.title}>
              {dispatchBtn.icon}{dispatchBtn.label}
            </Button>
            <Button variant={reportingBtn.variant} size="sm" disabled={busy} onClick={() => onToggleReporting(c)} className={reportingBtn.cls}>
              {reportingBtn.icon}{reportingBtn.label}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
