import { useEffect, useRef, useState } from 'react';
import { listClients, setReporting } from '../api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { ClientInfo } from '../types';

const REFRESH_MS = 3000;
const COLLECT_OK_AUTO_CLEAR_MS = 3000;

export function ClientsPage() {
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [collectBusyId, setCollectBusyId] = useState<string | null>(null);
  const [collectMsg, setCollectMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
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

  const collectNow = async (c: ClientInfo) => {
    setCollectBusyId(c.client_id);
    let ok = false;
    let text = '';
    try {
      const r = await fetch(`/api/clients/${c.client_id}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'collect-now' }),
      });
      const json: any = await r.json().catch(() => ({}));
      if (r.ok && json.ok) {
        ok = true;
        text = '已触发';
      } else {
        text = String(json.msg ?? json.error ?? json.code ?? `HTTP ${r.status}`);
      }
    } catch (e: any) {
      text = String(e?.message ?? e);
    } finally {
      setCollectBusyId(null);
    }
    setCollectMsg((m) => ({ ...m, [c.client_id]: { ok, text } }));
    if (ok) {
      setTimeout(() => {
        if (aliveRef.current) {
          setCollectMsg((m) => {
            const next = { ...m };
            delete next[c.client_id];
            return next;
          });
        }
      }, COLLECT_OK_AUTO_CLEAR_MS);
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
                  版本 {c.ext_version ?? '-'} · 上报：{c.reporting_enabled ? '开' : '关'}
                </div>
                {collectMsg[c.client_id] && (
                  <div className={`text-xs mt-1 break-words ${collectMsg[c.client_id].ok ? 'text-emerald-600' : 'text-destructive'}`}>
                    {collectMsg[c.client_id].ok ? '已触发' : `失败：${collectMsg[c.client_id].text}`}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded ${c.reporting_enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 text-zinc-600'}`}>
                  {c.reporting_enabled ? '上报中' : '已暂停'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={collectBusyId === c.client_id}
                  onClick={() => collectNow(c)}
                >
                  {collectBusyId === c.client_id ? '触发中…' : '触发单次上报'}
                </Button>
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
