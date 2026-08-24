import { useEffect, useRef, useState } from 'react';
import { listClients, setReporting, setTaskDispatch } from '../api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pause, Play } from 'lucide-react';
import type { ClientInfo } from '../types';

const REFRESH_MS = 3000;

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

// 单张客户端卡（2026-08-24 自 ClientsPage 抽出，偿还复杂度台账）：
// 名字优先展示（popup 改名，id 不变）；在线/离线状态与时长；离线不渲染远程操作按钮（须在线 404）。
function ClientCard({ c, now, busy, onToggleReporting, onToggleDispatch }: {
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
          {/* B 站登录态（2026-08-24 充电视频 no_subtitle 根因可观察化）：null=旧版扩展未上报，不显示 */}
          {c.bili_login && (
            c.bili_login.is_login ? (
              <div className="mt-1 flex items-center gap-1.5 text-xs">
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" title="该浏览器的 B 站登录态（充电视频 AI 字幕需要登录态才拿得到）">
                  B 站已登录
                </span>
                <span className="text-muted-foreground">
                  {c.bili_login.uname ?? '（未取到昵称）'}
                  {c.bili_login.mid ? `（${c.bili_login.mid}）` : ''}
                  {c.bili_login.vip && <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">大会员</span>}
                </span>
              </div>
            ) : (
              <div className="mt-1">
                <span
                  className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300"
                  title="充电视频的 AI 字幕接口未登录时返回空——派给该客户端的批量采集会整批 no_subtitle。在该浏览器登录 B 站后自动恢复。"
                >
                  B 站未登录
                </span>
              </div>
            )
          )}
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

export function ClientsPage() {
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const aliveRef = useRef(true);
  // 时长显示的基准时钟：随每轮刷新推进（refresh 是闭包外的 setNow，安全）
  const [now, setNow] = useState(Date.now());

  const refresh = () => {
    setNow(Date.now());
    listClients()
      .then((cs) => { if (aliveRef.current) { setClients(cs); setErr(null); } })
      .catch((e: any) => { if (aliveRef.current) setErr(String(e?.message ?? e)); });
  };

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => { aliveRef.current = false; clearInterval(t); };
  }, []);

  const toggle = async (c: ClientInfo) => {
    setBusyId(c.client_id);
    try {
      await setReporting(c.client_id, !c.reporting_enabled);
      refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusyId(null);
    }
  };

  // 任务派发开关（2026-08-23 仅上报状态）：off 后调度器不再给该客户端派采集任务（保持连接上报）
  const toggleDispatch = async (c: ClientInfo) => {
    setBusyId(c.client_id);
    try {
      await setTaskDispatch(c.client_id, !c.task_dispatch_enabled);
      refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusyId(null);
    }
  };

  const online = clients.filter((c) => c.connected).length;

  return (
    <div className="space-y-3">
      <div className="text-sm tabular-nums text-muted-foreground">
        客户端 {clients.length} 个 · 在线 {online} · 每 {REFRESH_MS / 1000}s 刷新
      </div>
      {err && <div className="text-sm text-destructive">操作失败：{err}</div>}
      <div className="space-y-2">
        {clients.map((c) => (
          <ClientCard
            key={c.client_id}
            c={c}
            now={now}
            busy={busyId === c.client_id}
            onToggleReporting={toggle}
            onToggleDispatch={toggleDispatch}
          />
        ))}
        {clients.length === 0 && (
          <Card>
            <div className="p-6 text-center text-sm text-muted-foreground">
              暂无已知客户端——打开桌面浏览器里的采集扩展并确认其已连接本服务后，会出现在这里
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
