import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useServerConfig, useReporting, useConnectionStatus, useClientId } from '../popup/hooks';
import { parseServerUrl, maskServerUrl, isLocalServer } from '../../servers.mjs';
import { resolveConnDisplay } from '../../connection-mode.mjs';

// 叹号圆圈图标（无 lucide-react 依赖，内联 SVG；lucide AlertCircle path）
function AlertCircle({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
// 眼睛图标（lucide Eye path）：本地 server 行点开看 token 明文
function Eye({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

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

// 测试 server 可达性 + token：连 wsUrl 发 hello{token}，hello-ack=通过、hello-nack=显示 error。
// 比 ping 更严格——验了 token 握手，bad token 会显式失败而非"在线"。
async function testServerUrl(url: string): Promise<{ ok: boolean; ms?: number; err?: string }> {
  const parsed = parseServerUrl(url);
  if (!parsed) return { ok: false, err: 'URL 非法（需 ws:// 或 wss://）' };
  const t0 = Date.now();
  let ws: WebSocket;
  try {
    ws = new WebSocket(parsed.wsUrl);
  } catch (e) {
    return { ok: false, err: String((e as Error)?.message ?? e).slice(0, 80) };
  }
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish({ ok: false, err: '超时（3s 无响应）' }), 3000);
    const finish = (r: { ok: boolean; ms?: number; err?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(r);
    };
    ws.onopen = () => {
      const hello: Record<string, unknown> = { type: 'hello' };
      if (parsed.token) hello.token = parsed.token;
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (e) => {
      let msg: { type?: string; error?: string };
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (msg.type === 'hello-ack') finish({ ok: true, ms: Date.now() - t0 });
      else if (msg.type === 'hello-nack') finish({ ok: false, err: msg.error || '握手被拒' });
    };
    ws.onerror = () => finish({ ok: false, err: '连接失败（server 不可达或非 WS 端点）' });
    ws.onclose = () => finish({ ok: false, err: '连接关闭（未完成握手）' });
  });
}

// —— 采集连接（连接模式 + server 列表，合并面板）——
// 顶部连接模式 toggle（server / 纯扩展）+ 状态点；下方 server 列表（激活/删除/测试）+ 新增表单（测试）。
function ServerPanel() {
  const config = useServerConfig();
  const conn = useConnectionStatus();
  const disp = resolveConnDisplay(conn); // loading 优先 → 首帧中性占位，防翻转闪烁
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; ms?: number; err?: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [newResult, setNewResult] = useState<{ ok: boolean; ms?: number; err?: string } | null>(null);
  const [testingNew, setTestingNew] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set()); // 本地 server 点开看 token 明文的 id 集合（远程始终 mask）

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

  // 仅在非 loading 分支使用（此时 disp.phase 为 standalone/server）
  const dot = disp.phase === 'standalone' ? 'bg-slate-400' : disp.connected ? 'bg-emerald-500' : 'bg-red-500';
  const statusText = disp.phase === 'standalone' ? '纯扩展（不连接）' : disp.connected ? '已连接' : '未连接';

  return (
    <div className="max-w-2xl space-y-4">
      {/* 连接模式 toggle + 实时状态点（useConnectionStatus 每 2s 轮询）。
          conn.loading 时渲染中性占位，避免首帧用默认值（server/未连接）渲染、真实值到达后翻转闪烁。 */}
      <div className="flex items-center gap-3 rounded-md border p-3">
        {disp.phase === 'loading' ? (
          <span className="text-sm text-muted-foreground">读取中…</span>
        ) : (
          <>
            <Switch
              checked={disp.phase === 'server'}
              onCheckedChange={(v) => conn.setMode(v ? 'server' : 'standalone')}
              checkedLabel="server"
              uncheckedLabel="纯扩展"
              className="data-[state=checked]:bg-brand"
            />
            {disp.phase === 'server' && !disp.connected && disp.error ? (
              <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
            ) : (
              <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
            )}
            <span className="text-sm">{statusText}</span>
            {disp.phase === 'server' && !disp.connected && disp.error && (
              <span className="truncate text-xs text-amber-600" title={disp.error}>{disp.error}</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {disp.phase === 'standalone' ? '不连 server、不上报' : '连 server，可上报'}
            </span>
            {disp.phase === 'server' && !disp.connected && (
              <Button size="sm" variant="outline" onClick={() => chrome.runtime.sendMessage({ type: 'RECONNECT' })}>重连</Button>
            )}
          </>
        )}
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
                <div className="flex items-center gap-1">
                  <span className="truncate text-xs text-muted-foreground">{revealed.has(s.id) ? s.url : maskServerUrl(s.url)}</span>
                  {isLocalServer(s.url) && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation(); // 避免触发外层 setActive
                        setRevealed((prev) => { const n = new Set(prev); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; });
                      }}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      title={revealed.has(s.id) ? '隐藏 token' : '显示 token'}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </button>
              {r && (
                <span className={cn('shrink-0 text-xs', r.ok ? 'text-emerald-600' : 'text-destructive')} title={r.err}>
                  {r.ok ? `在线 ${r.ms}ms` : r.err || '离线'}
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
              {newResult.ok ? `在线 ${newResult.ms}ms` : newResult.err || '离线'}
            </span>
          )}
        </div>
      </div>

      <ReconnectSettings />
    </div>
  );
}

// —— 重连设置：间隔 + 自动重连开关（存 storage，background storage.onChanged 自动重载）——
function ReconnectSettings() {
  const [base, setBase] = useState(2000);
  const [max, setMax] = useState(10000);
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    chrome.storage.local.get(['reconnect_base_ms', 'reconnect_max_ms', 'auto_reconnect'], (items) => {
      if (typeof items.reconnect_base_ms === 'number') setBase(items.reconnect_base_ms);
      if (typeof items.reconnect_max_ms === 'number') setMax(items.reconnect_max_ms);
      if (typeof items.auto_reconnect === 'boolean') setAuto(items.auto_reconnect);
    });
  }, []);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="text-sm font-medium">重连设置</div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1">
          间隔起步
          <input type="number" min={0} value={base} onChange={(e) => { const v = Number(e.target.value); setBase(v); chrome.storage.local.set({ reconnect_base_ms: v }); }} className="w-24 rounded border border-input bg-background px-2 py-1 text-sm outline-none focus:border-brand" />
          ms
        </label>
        <label className="flex items-center gap-1">
          上限
          <input type="number" min={0} value={max} onChange={(e) => { const v = Number(e.target.value); setMax(v); chrome.storage.local.set({ reconnect_max_ms: v }); }} className="w-24 rounded border border-input bg-background px-2 py-1 text-sm outline-none focus:border-brand" />
          ms
        </label>
        <label className="flex items-center gap-1">
          <Switch checked={auto} onCheckedChange={(v) => { setAuto(v); chrome.storage.local.set({ auto_reconnect: v }); }} checkedLabel="自动" uncheckedLabel="手动" className="data-[state=checked]:bg-brand" />
          自动重连
        </label>
      </div>
      <p className="text-xs text-muted-foreground">断线后退避重连（指数：起步→上限）。关自动重连后需手动点「重连」。改完即时生效（background 监听 storage）。</p>
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
