// 客户端列表页（2026-10-05 卡片渲染抽至 ClientCard.tsx 偿还行数台账并承载 Q8c 离线提示）：
// 轮询 /api/clients 每 3s；上报开关 / 任务派发开关两远程操作（POST 后刷新）。
import { useEffect, useRef, useState } from 'react';
import { listClients, setReporting, setTaskDispatch } from '../api';
import { Card } from '@/components/ui/card';
import { ClientCard } from './ClientCard';
import type { ClientInfo } from '../types';

const REFRESH_MS = 3000;

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
