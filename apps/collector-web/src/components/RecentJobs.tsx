// ── 最近 jobs 列表（轻量台账）：listJobs({limit:10}) 折叠列表，行点击展开内联 JobCard ──
// 默认折叠零请求（不拖累所在页加载）；首次展开才拉取，「刷新」手动重拉。不过滤 type——
// asr-backfill / collect-find（及后续新 job 类型）都进这张台账，状态与进度看行内展开的 JobCard。
// 放置：TranslatePage 清单分支（补翻页卡下方）——ASR 转写是分钟级长任务，「回来查进度」场景最强；
// CollectPage 已有 2s 轮询的采集任务列表，两套台账混一页会混淆概念。
import { useCallback, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { listJobs } from '../api-jobs';
import type { JobRow } from '../api-jobs';
import { formatJobTime, jobTypeLabel } from '../lib/jobMeta';
import { JobCard, StatusBadge } from '@/components/JobCard';

export function RecentJobs() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<JobRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      setItems(await listJobs({ limit: 10 }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleOpen = (): void => {
    const next = !open;
    setOpen(next);
    if (next && items == null) void load(); // 首次展开才拉取
  };

  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium"
            aria-expanded={open}
            aria-label="最近任务折叠开关"
            onClick={toggleOpen}
          >
            {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
            最近任务
            {items != null && items.length > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">（{items.length}）</span>
            )}
          </button>
          {open && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" disabled={loading} onClick={() => { void load(); }}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              刷新
            </Button>
          )}
        </div>

        {open && (
          <>
            {err && <div role="alert" className="text-sm text-destructive">加载失败：{err}</div>}
            {!err && items == null && loading && (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                加载中…
              </div>
            )}
            {items != null && items.length === 0 && (
              <div className="py-2 text-center text-sm text-muted-foreground">暂无任务</div>
            )}
            {items != null && items.length > 0 && (
              <div className="space-y-1">
                {items.map((j) => (
                  <div key={j.id} className="rounded-md bg-muted/30">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
                      aria-expanded={expandedId === j.id}
                      aria-label={`展开任务 #${j.id}`}
                      onClick={() => setExpandedId((cur) => (cur === j.id ? null : j.id))}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {jobTypeLabel(j.type)} <span className="text-xs tabular-nums text-muted-foreground">#{j.id}</span>
                      </span>
                      <StatusBadge status={j.status} />
                      <span className="shrink-0 text-xs text-muted-foreground">{formatJobTime(j.created_at)}</span>
                    </button>
                    {expandedId === j.id && (
                      <div className="px-2 pb-2">
                        <JobCard jobId={j.id} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
