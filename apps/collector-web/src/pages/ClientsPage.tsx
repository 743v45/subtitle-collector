import { useEffect, useRef, useState } from 'react';
import { listClients, setReporting } from '../api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
    <div className="space-y-3 p-4">
      <div className="text-sm text-muted-foreground">在线客户端 {clients.length} 个 · 每 {REFRESH_MS / 1000}s 刷新</div>
      {err && <div className="text-sm text-destructive">操作失败：{err}</div>}
      <div className="space-y-2">
        {clients.map((c) => (
          <Card key={c.client_id}>
            <div className="p-4 flex flex-row items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-base font-medium truncate font-mono">{c.client_id}</div>
                <div className="text-xs text-muted-foreground">
                  版本 {c.ext_version ?? '-'} · 上报：{c.reporting_enabled ? '开' : '关'}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded ${c.reporting_enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 text-zinc-600'}`}>
                  {c.reporting_enabled ? '上报中' : '已暂停'}
                </span>
                <Button
                  variant={c.reporting_enabled ? 'outline' : 'default'}
                  size="sm"
                  disabled={busyId === c.client_id}
                  onClick={() => toggle(c)}
                >
                  {c.reporting_enabled ? '暂停上报' : '恢复上报'}
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
