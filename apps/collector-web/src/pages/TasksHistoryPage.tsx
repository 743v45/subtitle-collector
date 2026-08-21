// ── 采集历史页（2026-08-22）：collect_tasks 全量分页查询 + 状态筛选 ──
// 采集页只保留最近 30 条速览;持久化的任务历史在本页查全量。复用 TaskCards 渲染
// （含批次聚合、删除、失败/受限重试,与采集页行为一致）。URL query 是唯一真相
// （#/history?page=3&status=failed,limited——刷新/分享还原视图）。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createCollectTasksBatch, deleteCollectTask, listCollectTasksPage } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { useRoute, navigate } from '../router';
import { BatchTaskCard, TaskRow, retryable } from '@/components/TaskCards';
import type { CollectTask, CollectTaskStatus } from '../types';

const PAGE_SIZE = 50;

// 状态筛选档位:全部 / 进行中 / 已完成 / 受限 / 失败(进行中含排队,与列表语义一致)
const FILTERS: ReadonlyArray<{ key: string; label: string; statuses: readonly CollectTaskStatus[] | null }> = [
  { key: '', label: '全部', statuses: null },
  { key: 'pending,dispatched', label: '进行中', statuses: ['pending', 'dispatched'] },
  { key: 'succeeded', label: '已完成', statuses: ['succeeded'] },
  { key: 'limited', label: '受限', statuses: ['limited'] },
  { key: 'failed', label: '失败', statuses: ['failed'] },
];

export function TasksHistoryPage() {
  const route = useRoute();
  const page = Math.max(1, Number(route.query.get('page') ?? '1') || 1);
  const filterKey = route.query.get('status') ?? '';
  const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0];

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CollectTask[]>([]);
  const [total, setTotal] = useState(0);
  const aliveRef = useRef(true);
  // 在途待删(删除乐观移除期间防刷新写回,同采集页语义;历史页无轮询,仅删除往返窗口)
  const deletingRef = useRef(new Set<number>());

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    setErr(null);
    listCollectTasksPage(page, PAGE_SIZE, filter.statuses)
      .then(({ total: t, items }) => {
        if (!aliveRef.current) return;
        setTotal(t);
        setTasks(items.filter((x) => !deletingRef.current.has(x.id)));
      })
      .catch((e: any) => { if (aliveRef.current) setErr(String(e?.message ?? e)); })
      .finally(() => { if (aliveRef.current) setLoading(false); });
    return () => { aliveRef.current = false; };
  }, [page, filter.key]);

  const go = (p: number, statusKey: string) => {
    const q = new URLSearchParams();
    if (p > 1) q.set('page', String(p));
    if (statusKey) q.set('status', statusKey);
    const qs = q.toString();
    navigate(`/history${qs ? `?${qs}` : ''}`);
  };

  const remove = async (id: number) => {
    deletingRef.current.add(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try {
      await deleteCollectTask(id);
      setTotal((t) => Math.max(0, t - 1));
    } catch { /* 失败:重新拉真值 */ void reload(); }
    finally { deletingRef.current.delete(id); }
  };

  const removeBatch = async (batchId: string) => {
    const ids = tasks.filter((t) => t.batch_id === batchId).map((t) => t.id);
    for (const id of ids) deletingRef.current.add(id);
    setTasks((prev) => prev.filter((t) => t.batch_id !== batchId));
    for (const id of ids) {
      try { await deleteCollectTask(id); setTotal((t) => Math.max(0, t - 1)); } catch { /* 继续删 */ }
    }
    for (const id of ids) deletingRef.current.delete(id);
    void reload();
  };

  const retry = async (list: CollectTask[]) => {
    const bySource = new Map<'bilibili' | 'youtube', string[]>();
    for (const t of list) {
      if (!retryable(t)) continue;
      const arr = bySource.get(t.source) ?? [];
      arr.push(t.source_vid);
      bySource.set(t.source, arr);
    }
    if (bySource.size === 0) return;
    try {
      for (const [source, vids] of bySource) await createCollectTasksBatch(vids, source);
    } finally { void reload(); }
  };

  const reload = () => {
    // 原位重拉当前页(不改 URL)
    listCollectTasksPage(page, PAGE_SIZE, filter.statuses)
      .then(({ total: t, items }) => {
        if (!aliveRef.current) return;
        setTotal(t);
        setTasks(items.filter((x) => !deletingRef.current.has(x.id)));
      })
      .catch(() => { /* 静默 */ });
  };

  // 分组渲染(同采集页:batch_id 聚卡,单成员批次走单任务行)
  const listNodes: Array<ReactNode> = [];
  const batched = new Set<string>();
  for (const t of tasks) {
    if (t.batch_id) {
      if (batched.has(t.batch_id)) continue;
      batched.add(t.batch_id);
      const members = tasks.filter((x) => x.batch_id === t.batch_id);
      if (members.length === 1) {
        listNodes.push(<TaskRow key={t.id} task={t} onDelete={(id) => { void remove(id); }} onRetry={(task) => { void retry([task]); }} />);
      } else {
        listNodes.push(
          <BatchTaskCard
            key={`batch:${t.batch_id}`}
            items={members}
            onDelete={(id) => { void remove(id); }}
            onDeleteBatch={(bid) => { void removeBatch(bid); }}
            onRetry={(ts) => { void retry(ts); }}
            onRetryTask={(task) => { void retry([task]); }}
          />,
        );
      }
    } else {
      listNodes.push(<TaskRow key={t.id} task={t} onDelete={(id) => { void remove(id); }} onRetry={(task) => { void retry([task]); }} />);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canRetryAll = tasks.some(retryable);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">采集历史</h2>
        <span className="text-sm text-muted-foreground">{total.toLocaleString('zh-CN')} 条记录</span>
      </div>

      {/* 状态筛选(切档回第 1 页) + 当前页全部未成功重试 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => go(1, f.key)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
              filter.key === f.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
            )}
          >
            {f.label}
          </button>
        ))}
        {canRetryAll && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 px-2.5 text-xs"
            onClick={() => void retry(tasks.filter(retryable))}
          >
            <RotateCcw className="size-3.5" />
            重试本页未成功
          </Button>
        )}
      </div>

      {/* 列表(批次聚合卡 + 单任务卡,同采集页) */}
      <div className="space-y-2">
        {loading && tasks.length === 0 && (
          <Card><CardContent className="p-6"><Skeleton className="h-16 w-full" /></CardContent></Card>
        )}
        {err && <Card><CardContent className="p-6 text-center text-sm text-destructive">加载失败:{err}</CardContent></Card>}
        {!loading && !err && tasks.length === 0 && (
          <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">无匹配记录</CardContent></Card>
        )}
        {listNodes}
      </div>

      {/* 分页 */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">第 {page} / {totalPages} 页 · 每页 {PAGE_SIZE} 条</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => go(page - 1, filter.key)}>
            <ChevronLeft className="size-4" /> 上一页
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => go(page + 1, filter.key)}>
            下一页 <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
