import { useEffect, useRef, useState } from 'react';
import { listClients, setReporting, setTaskDispatch } from '../api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pause, Play } from 'lucide-react';
import type { ClientInfo } from '../types';

const REFRESH_MS = 3000;

export function ClientsPage() {
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const refresh = () => {
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

  return (
    <div className="space-y-3">
      <div className="text-sm tabular-nums text-muted-foreground">在线客户端 {clients.length} 个 · 每 {REFRESH_MS / 1000}s 刷新</div>
      {err && <div className="text-sm text-destructive">操作失败：{err}</div>}
      <div className="space-y-2">
        {clients.map((c) => (
          <Card key={c.client_id}>
            <div className="flex flex-row items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <div className="truncate font-mono text-base font-medium">{c.client_id}</div>
                  {!c.task_dispatch_enabled && (
                    <span
                      className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                      title="server 调度器不再给该客户端派采集任务（保持连接上报）"
                    >
                      仅上报状态
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  版本 {c.ext_version ?? '-'}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant={c.task_dispatch_enabled ? 'outline' : 'default'}
                  size="sm"
                  disabled={busyId === c.client_id}
                  onClick={() => toggleDispatch(c)}
                  title={c.task_dispatch_enabled ? '停派后调度器不再给该客户端派采集任务（仅保持连接上报）' : '恢复后调度器可正常派发采集任务'}
                >
                  {c.task_dispatch_enabled ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
                  {c.task_dispatch_enabled ? '停派任务' : '恢复接任务'}
                </Button>
                <Button
                  variant={c.reporting_enabled ? 'default' : 'outline'}
                  size="sm"
                  disabled={busyId === c.client_id}
                  onClick={() => toggle(c)}
                  className={c.reporting_enabled ? 'bg-emerald-700 hover:bg-emerald-700/90' : ''}
                >
                  {c.reporting_enabled ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
                  {c.reporting_enabled ? '暂停自动上报' : '恢复自动上报'}
                </Button>
              </div>
            </div>
          </Card>
        ))}
        {clients.length === 0 && (
          <Card>
            <div className="p-6 text-center text-sm text-muted-foreground">
              暂无在线客户端——打开桌面浏览器里的采集扩展并确认其已连接本服务后，会出现在这里
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
