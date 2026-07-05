import { useEffect, useRef, useState } from 'react';
import { listClients, setReporting } from '../api';
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

  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">在线客户端 {clients.length} 个 · 每 {REFRESH_MS / 1000}s 刷新</div>
      {err && <div className="text-sm text-destructive">操作失败：{err}</div>}
      <div className="space-y-2">
        {clients.map((c) => (
          <Card key={c.client_id}>
            <div className="p-4 flex flex-row items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-base font-medium truncate font-mono">{c.client_id}</div>
                <div className="text-xs text-muted-foreground">
                  版本 {c.ext_version ?? '-'}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant={c.reporting_enabled ? 'default' : 'outline'}
                  size="sm"
                  disabled={busyId === c.client_id}
                  onClick={() => toggle(c)}
                  className={c.reporting_enabled ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
                >
                  {c.reporting_enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                  {c.reporting_enabled ? '暂停自动上报' : '恢复自动上报'}
                </Button>
              </div>
            </div>
          </Card>
        ))}
        {clients.length === 0 && (
          <div className="text-sm text-muted-foreground">暂无在线客户端（扩展未连接，或开关全关）</div>
        )}
      </div>
    </div>
  );
}
