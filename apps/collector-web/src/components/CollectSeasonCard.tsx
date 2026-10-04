// ── 合集卡（CLI collect season 的只读展开 + 采集勾选的 web 形态；视频详情页用）──
// extra.ugc_season 存在才渲染（否则 null，调用侧零分支）；展开 → season/preview 拉全集 →
// 已采/入库行只展示（无勾选框），未采行默认勾选 → 批量建 bilibili 采集任务。
// 503=扩展离线统一文案，其余错误原文透出（与搜索采集卡一致）。
import { useState } from 'react';
import { seasonPreview } from '../api-extra';
import type { SeasonPreviewItem } from '../api-extra';
import { createCollectTasksBatch } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { collectErrorText } from '../lib/collectErrors';
import type { VideoExtra } from '../types';

export function CollectSeasonCard({ extra }: { extra: VideoExtra | undefined }) {
  const season = extra?.ugc_season;
  if (!season?.id) return null;
  return <SeasonCardBody seasonId={String(season.id)} title={season.title ?? '合集'} />;
}

function SeasonCardBody({ seasonId, title }: { seasonId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<SeasonPreviewItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 首次展开拉全集；已入库行（exists）不进默认勾选（重采走视频详情/批量卡的强制重采路径）
  const load = async () => {
    if (loading) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await seasonPreview({ arg: seasonId });
      setItems(r.items);
      setSelected(new Set(r.items.filter((it) => !it.exists).map((it) => it.bvid)));
    } catch (e: unknown) {
      setErr(collectErrorText(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleHeader = () => {
    const next = !open;
    setOpen(next);
    if (next && !items && !err) void load();
  };

  const toggle = (bvid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bvid)) next.delete(bvid); else next.add(bvid);
      return next;
    });
  };

  const submitBatch = async () => {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    setMsg(null);
    try {
      const r = await createCollectTasksBatch([...selected], 'bilibili');
      const parts = [`已创建 ${r.created} 个任务`];
      if (r.skipped) parts.push(`跳过 ${r.skipped} 个（已在队列）`);
      if (r.skippedCollected) parts.push(`已采跳过 ${r.skippedCollected} 个`);
      setMsg({ ok: true, text: parts.join('，') });
      setSelected(new Set());
    } catch (e: unknown) {
      setMsg({ ok: false, text: collectErrorText(e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <button type="button" onClick={toggleHeader} className="flex w-full cursor-pointer items-center gap-1.5 text-left text-sm font-medium">
          {open ? <ChevronDown className="size-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0" aria-hidden="true" />}
          合集：{title}
          {!open && <span className="font-normal text-muted-foreground">（展开查看全集并勾选采集）</span>}
        </button>
        {open && (
          <div className="space-y-2">
            {loading && (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> 拉取合集中…
              </div>
            )}
            {err && <div className="text-sm text-destructive">{err}</div>}
            {items && (
              <>
                <div className="space-y-0.5">
                  {items.map((it) => (
                    <SeasonRow key={it.bvid} it={it} checked={selected.has(it.bvid)} onToggle={() => toggle(it.bvid)} />
                  ))}
                </div>
                {msg && <div role="status" className={cn('text-sm', msg.ok ? 'text-emerald-700' : 'text-destructive')}>{msg.text}</div>}
                <div className="flex items-center justify-end">
                  <Button size="sm" disabled={selected.size === 0 || submitting} onClick={() => void submitBatch()}>
                    {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                    采集勾选 ({selected.size})
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// 全集行：已入库（exists）无勾选框只展示徽章；未采行可勾选（默认已勾由父层预置）
function SeasonRow({ it, checked, onToggle }: { it: SeasonPreviewItem; checked: boolean; onToggle: () => void }) {
  const meta = [
    it.play != null ? `${it.play.toLocaleString('zh-CN')} 播放` : '',
    it.length ? `时长 ${it.length}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <div className={cn('flex items-center gap-2 rounded px-1.5 py-1 text-sm', checked && 'bg-primary/10')}>
      {it.exists ? (
        <span className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`选择 ${it.title ?? it.bvid}`} className="size-3.5 shrink-0 accent-primary" />
      )}
      <span className="min-w-0 flex-1 truncate" title={it.title}>{it.title ?? it.bvid}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{[it.bvid, meta].filter(Boolean).join(' · ')}</span>
      {it.has_subtitle ? (
        <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">已采</span>
      ) : it.exists ? (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">已入库·无字幕</span>
      ) : null}
    </div>
  );
}
