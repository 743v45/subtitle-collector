import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useServerConfig, useReporting, useConnectionStatus, useClientId } from '../popup/hooks';
import { parseServerUrl } from '../../servers.mjs';

// 配置页：左右结构。左 nav 分类，右对应面板。
// popup 右上角齿轮按钮 → chrome.runtime.openOptionsPage() 打开本页（open_in_tab:true）。
type SectionId = 'server' | 'reporting' | 'subtitle' | 'about';
const NAV: { id: SectionId; label: string }[] = [
  { id: 'server', label: '采集连接' },
  { id: 'reporting', label: '上报设置' },
  { id: 'subtitle', label: '字幕格式' },
  { id: 'about', label: '关于' },
];

export function Options() {
  const [section, setSection] = useState<SectionId>('server');
  const current = NAV.find((n) => n.id === section)!;
  return (
    <div className="flex min-h-screen">
      <nav className="w-52 shrink-0 border-r bg-muted/30 p-3">
        <div className="mb-3 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">配置</div>
        <div className="space-y-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setSection(n.id)}
              className={cn(
                'block w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                section === n.id ? 'bg-brand text-brand-foreground' : 'hover:bg-accent hover:text-accent-foreground'
              )}
            >
              {n.label}
            </button>
          ))}
        </div>
      </nav>
      <main className="flex-1 overflow-auto p-8">
        <h1 className="text-xl font-semibold">{current.label}</h1>
        <div className="mt-6">
          {section === 'server' && <ServerPanel />}
          {section === 'reporting' && <ReportingPanel />}
          {section === 'subtitle' && <SubtitlePanel />}
          {section === 'about' && <AboutPanel />}
        </div>
      </main>
    </div>
  );
}

// 测试 server 可达性：fetch pingUrl（3s 超时）。返回 {ok, ms, err}。
// 仅测 HTTP /ping（server 探活端点），不验 WS/token——能 ping 通即 server 在线。
async function testServerUrl(url: string): Promise<{ ok: boolean; ms?: number; err?: string }> {
  const parsed = parseServerUrl(url);
  if (!parsed) return { ok: false, err: 'URL 非法（需 ws:// 或 wss://）' };
  const t0 = Date.now();
  try {
    const res = await fetch(parsed.pingUrl, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, err: String((e as Error)?.message ?? e).slice(0, 80) };
  }
}

// —— 采集连接（连接模式 + server 列表，合并面板）——
// 顶部连接模式 toggle（server / 纯扩展）+ 状态点；下方 server 列表（激活/删除/测试）+ 新增表单（测试）。
function ServerPanel() {
  const config = useServerConfig();
  const conn = useConnectionStatus();
  const standalone = conn.mode === 'standalone';
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; ms?: number; err?: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [newResult, setNewResult] = useState<{ ok: boolean; ms?: number; err?: string } | null>(null);
  const [testingNew, setTestingNew] = useState(false);

  const test = async (id: string, url: string) => {
    setTestingId(id);
    const r = await testServerUrl(url);
    setResults((prev) => ({ ...prev, [id]: r }));
    setTestingId(null);
  };
  const onAdd = () => {
    if (config.addServer(newName, newUrl)) {
      setNewName('');
      setNewUrl('');
      setErr(null);
      setNewResult(null);
    } else {
      setErr('URL 非法（需 ws:// 或 wss:// 开头）');
    }
  };

  const dot = standalone ? 'bg-slate-400' : conn.connected ? 'bg-emerald-500' : 'bg-red-500';
  const statusText = standalone ? '纯扩展（不连接）' : conn.connected ? '已连接' : '未连接';

  return (
    <div className="max-w-2xl space-y-4">
      {/* 连接模式 toggle + 实时状态点（useConnectionStatus 每 2s 轮询） */}
      <div className="flex items-center gap-3 rounded-md border p-3">
        <Switch
          checked={!standalone}
          onCheckedChange={(v) => conn.setMode(v ? 'server' : 'standalone')}
          checkedLabel="server"
          uncheckedLabel="纯扩展"
          className="data-[state=checked]:bg-brand"
        />
        <span className={cn('h-2 w-2 rounded-full', dot)} />
        <span className="text-sm">{statusText}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {standalone ? '不连 server、不上报' : '连 server，可上报'}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        collector server 地址，支持多个、热切换（点选立即用新地址重连）。token 由 server 端生成、嵌在 URL 的 <code>?token=</code>；server 也可不要 token。点「测试」ping /ping 确认可达。
      </p>

      {/* server 列表 */}
      <div className="space-y-2">
        {config.servers.map((s) => {
          const active = s.id === config.activeServerId;
          const r = results[s.id];
          return (
            <div
              key={s.id}
              className={cn('flex flex-wrap items-center gap-2 rounded-md border p-3', active ? 'border-brand bg-brand/5' : 'border-input')}
            >
              <button type="button" onClick={() => config.setActive(s.id)} className="min-w-0 flex-1 text-left" title={s.url}>
                <div className="flex items-center gap-2">
                  <span className={cn('h-2 w-2 rounded-full', active ? 'bg-brand' : 'bg-muted-foreground/30')} />
                  <span className="font-medium">{s.name}</span>
                  {active && <Badge variant="secondary" className="text-[10px]">当前</Badge>}
                </div>
                <div className="truncate text-xs text-muted-foreground">{s.url}</div>
              </button>
              {r && (
                <span className={cn('shrink-0 text-xs', r.ok ? 'text-emerald-600' : 'text-destructive')} title={r.err}>
                  {r.ok ? `在线 ${r.ms}ms` : '离线'}
                </span>
              )}
              <Button variant="outline" size="sm" disabled={testingId === s.id} onClick={() => test(s.id, s.url)}>
                {testingId === s.id ? '测试中…' : '测试'}
              </Button>
              {config.servers.length > 1 && (
                <Button variant="outline" size="sm" onClick={() => config.removeServer(s.id)}>删除</Button>
              )}
            </div>
          );
        })}
        {config.servers.length === 0 && !config.loading && (
          <div className="text-sm text-muted-foreground">尚未配置 server。</div>
        )}
      </div>

      {/* 新增表单：先测试确认可达，再加 */}
      <div className="space-y-2 rounded-md border p-3">
        <div className="text-sm font-medium">添加 server</div>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="名称（可选，空则用 URL）"
          className="w-full rounded border border-input bg-background px-3 py-1.5 text-sm outline-none focus:border-brand"
        />
        <input
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          placeholder="ws://host:port/ext[?token=]"
          className="w-full rounded border border-input bg-background px-3 py-1.5 text-sm outline-none focus:border-brand"
        />
        {err && <div className="text-xs text-destructive">{err}</div>}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={testingNew || !newUrl}
            onClick={async () => { setTestingNew(true); setNewResult(await testServerUrl(newUrl)); setTestingNew(false); }}
          >
            {testingNew ? '测试中…' : '测试'}
          </Button>
          <Button size="sm" onClick={onAdd}>+ 添加</Button>
          {newResult && (
            <span className={cn('text-xs', newResult.ok ? 'text-emerald-600' : 'text-destructive')} title={newResult.err}>
              {newResult.ok ? `在线 ${newResult.ms}ms` : '离线'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// —— 上报开关：自动 / 手动 ——
function ReportingPanel() {
  const { enabled, setEnabled } = useReporting();
  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-sm text-muted-foreground">字幕采集后是否自动上报到 server。关 = 手动（在 popup 点「上报」按钮才上报）。</p>
      <div className="flex items-center gap-3">
        {enabled === null ? (
          <span className="text-sm text-muted-foreground">读取中…</span>
        ) : (
          <>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              checkedLabel="自动"
              uncheckedLabel="手动"
              className="data-[state=checked]:bg-brand"
            />
            <span className="text-sm">{enabled ? '自动上报中' : '手动上报'}</span>
          </>
        )}
      </div>
    </div>
  );
}

// —— 字幕复制默认格式（popup 复制按钮用）。内联读写 storage，与 popup useSubtitleFormat 同 key。 ——
const FMT_OPTS = [
  { value: 'text', label: '纯文本' },
  { value: 'timestamp', label: '带时间戳' },
  { value: 'srt', label: 'SRT' },
] as const;
type FmtVal = (typeof FMT_OPTS)[number]['value'];
function SubtitlePanel() {
  // null=未读到 storage：避免首帧默认 'text' 高亮 → 读到真实值（如 'srt'）后的翻转闪烁。
  const [fmt, setFmt] = useState<FmtVal | null>(null);
  useEffect(() => {
    chrome.storage.local.get(['subtitleFormat'], (items) => {
      const v = items.subtitleFormat;
      setFmt(v === 'text' || v === 'timestamp' || v === 'srt' ? v : 'text');
    });
  }, []);
  const choose = (f: FmtVal) => {
    setFmt(f);
    chrome.storage.local.set({ subtitleFormat: f });
  };
  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-sm text-muted-foreground">popup「复制」按钮的默认字幕格式。切换实时生效（popup 重开即用新格式）。</p>
      <div className="flex gap-2">
        {FMT_OPTS.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => choose(o.value)}
            className={cn(
              'rounded-md border px-4 py-1.5 text-sm transition-colors',
              fmt === o.value ? 'border-brand bg-brand text-brand-foreground' : 'border-input hover:bg-accent hover:text-accent-foreground'
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// —— 关于：版本 + 客户端 ID + 简介 ——
function AboutPanel() {
  const clientId = useClientId();
  const version = chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '';
  return (
    <div className="max-w-2xl space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold">SubCatch 字幕捕手</span>
        <Badge variant="secondary">v{version}</Badge>
      </div>
      <p className="text-muted-foreground">多平台视频字幕采集扩展（B 站 / YouTube 等），采集到本地 collector-server。</p>
      <div>
        客户端 ID：
        <code className="ml-1 rounded bg-muted px-1.5 py-0.5 tabular-nums">{clientId ?? '…'}</code>
        <span className="ml-2 text-xs text-muted-foreground">（CLI 用此 id 寻址本机）</span>
      </div>
    </div>
  );
}
