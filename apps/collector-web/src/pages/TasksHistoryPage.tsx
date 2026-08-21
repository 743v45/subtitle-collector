// ── 采集历史页（2026-08-22）：collect_tasks 全量分页 + 多维查询 ──
// 采集页只保留最近 30 条速览;持久化的任务历史在本页查全量。复用 TaskCards 渲染
// （含批次聚合、删除、失败/受限重试,与采集页行为一致）。URL query 是唯一真相
// （#/history?creator=某UP&range=7d&status=failed&page=3——刷新/分享还原视图）。
// UP 筛选双来源：任务行 creator_uid 冗余列（批量提交/重采/ingest 回填,未入库任务也命中）+
// 入库后视频归属;q 的标题段仅覆盖已入库任务,vid 段（搜 BV 号）覆盖全部任务。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createCollectTasksBatch, deleteCollectTask, listCollectTasksPage, type TaskHistoryFilter } from '../api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ChevronLeft, ChevronRight, RotateCcw, X } from 'lucide-react';
import { useRoute, useQueryUpdater, navigate } from '../router';
import { BatchTaskCard, TaskRow, retryable } from '@/components/TaskCards';
import { taskHistoryFromQuery, isMidLike } from '../taskHistoryFilterUrl';
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

// 今日本地 00:00（时间快捷档按「现在」重算:分享 URL 次日打开=新的一天,正是期望语义）
function todayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const DAY_MS = 86_400_000;

export function TasksHistoryPage() {
  const route = useRoute();
  const updateQuery = useQueryUpdater();
  const f = taskHistoryFromQuery(route.query);

  // 筛选变更（resetPage：任一筛选变化回第 1 页）
  const setFilter = (patch: Record<string, string | null | undefined>) => updateQuery(patch, { resetPage: true });

  // 搜索框:本地回显 + 防抖写 URL（打字不打爆历史栈、不打断输入,对齐 VideoList 范式）
  const [creatorInput, setCreatorInput] = useState(f.creator);
  const [qInput, setQInput] = useState(f.q);
  useEffect(() => { setCreatorInput(f.creator); }, [f.creator]);
  useEffect(() => { setQInput(f.q); }, [f.q]);
  useEffect(() => {
    const t = setTimeout(() => { if (creatorInput !== f.creator) setFilter({ creator: creatorInput || null }); }, 300);
    return () => clearTimeout(t);
  }, [creatorInput]);
  useEffect(() => {
    const t = setTimeout(() => { if (qInput !== f.q) setFilter({ q: qInput || null }); }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // 时间档 → since/until 毫秒（preset 渲染时重算;custom 按日期串整天边界）
  let since: number | undefined;
  let until: number | undefined;
  if (f.range === 'today') since = todayStart();
  else if (f.range === '7d') since = todayStart() - 6 * DAY_MS;
  else if (f.range === '30d') since = todayStart() - 29 * DAY_MS;
  else if (f.range === 'custom') {
    since = f.sinceDate ? new Date(f.sinceDate + 'T00:00:00').getTime() : undefined;
    until = f.untilDate ? new Date(f.untilDate + 'T23:59:59.999').getTime() : undefined;
  }

  const filter = FILTERS.find((x) => x.key === f.status) ?? FILTERS[0];
  const reqFilter: TaskHistoryFilter = {
    status: filter.statuses,
    source: f.source === 'bilibili' || f.source === 'youtube' ? f.source : undefined,
    batchId: f.batchId || undefined,
    creator: f.creator && !isMidLike(f.creator) ? f.creator : undefined,
    creatorUid: f.creator && isMidLike(f.creator) ? f.creator : undefined,
    q: f.q || undefined,
    since,
    until,
  };

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CollectTask[]>([]);
  const [total, setTotal] = useState(0);
  const aliveRef = useRef(true);
  // 在途待删(删除乐观移除期间防刷新写回,同采集页语义;历史页无轮询,仅删除往返窗口)
  const deletingRef = useRef(new Set<number>());

  const queryKey = route.query.toString();
  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    setErr(null);
    listCollectTasksPage(f.page, PAGE_SIZE, reqFilter)
      .then(({ total: t, items }) => {
        if (!aliveRef.current) return;
        setTotal(t);
        setTasks(items.filter((x) => !deletingRef.current.has(x.id)));
      })
      .catch((e: any) => { if (aliveRef.current) setErr(String(e?.message ?? e)); })
      .finally(() => { if (aliveRef.current) setLoading(false); });
    return () => { aliveRef.current = false; };
  }, [queryKey]); // eslint-disable-line react-hooks/exhaustive-deps -- 筛选全部经 URL 派生,query 变化即重拉

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
    listCollectTasksPage(f.page, PAGE_SIZE, reqFilter)
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
  const anySecondary = !!(f.creator || f.q || f.range || f.source || f.batchId);

  function resetAll() {
    setCreatorInput('');
    setQInput('');
    navigate('/history');
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">采集历史</h2>
        <span className="text-sm text-muted-foreground">{total.toLocaleString('zh-CN')} 条记录</span>
      </div>

      {/* 主筛选行：UP / 标题关键词（防抖）+ 平台 + 时间档（custom 展开日期）+ 重置 */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[160px] flex-1"
          placeholder="UP 主名字 / B站 mid（纯数字按 mid 精确）"
          value={creatorInput}
          onChange={(e) => setCreatorInput(e.target.value)}
        />
        <Select
          value={f.source || '__all'}
          onValueChange={(v) => setFilter({ source: v === '__all' ? null : v })}
        >
          <SelectTrigger className="w-[120px]">
            <SelectValue placeholder="平台" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">全部平台</SelectItem>
            <SelectItem value="bilibili">哔哩哔哩</SelectItem>
            <SelectItem value="youtube">YouTube</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="min-w-[160px] flex-1"
          placeholder="标题关键词"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <Select
          value={f.range || '__all'}
          onValueChange={(v) => setFilter({ range: v === '__all' ? null : v, ...(v !== 'custom' ? { since_date: null, until_date: null } : {}) })}
        >
          <SelectTrigger className="w-[110px]">
            <SelectValue placeholder="时间" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">全部时间</SelectItem>
            <SelectItem value="today">今天</SelectItem>
            <SelectItem value="7d">近 7 天</SelectItem>
            <SelectItem value="30d">近 30 天</SelectItem>
            <SelectItem value="custom">自定义</SelectItem>
          </SelectContent>
        </Select>
        {f.range === 'custom' && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Input
              type="date"
              className="w-36"
              value={f.sinceDate}
              onChange={(e) => setFilter({ since_date: e.target.value || null })}
            />
            <span>~</span>
            <Input
              type="date"
              className="w-36"
              value={f.untilDate}
              onChange={(e) => setFilter({ until_date: e.target.value || null })}
            />
          </div>
        )}
        <Button variant="outline" size="sm" disabled={!anySecondary} onClick={resetAll}>
          <RotateCcw className="h-4 w-4" />
          重置
        </Button>
      </div>

      {/* 批次聚焦 chip + 入库维度说明 */}
      {(f.batchId || (f.creator || f.q)) && (
        <div className="flex flex-wrap items-center gap-2">
          {f.batchId && (
            <Badge variant="secondary" className="gap-1 font-normal">
              批次聚焦 {f.batchId.slice(0, 8)}…
              <button
                type="button"
                aria-label="清除批次聚焦"
                className="ml-0.5 rounded-full hover:bg-muted-foreground/20"
                onClick={() => setFilter({ batch_id: null })}
              >
                <X className="size-3" />
              </button>
            </Badge>
          )}
          {(f.creator || f.q) && (
            <span className="text-xs text-muted-foreground">
              标题筛选仅覆盖已入库视频的任务（搜 BV 号可覆盖全部）；UP 筛选覆盖已带归属的任务
            </span>
          )}
        </div>
      )}

      {/* 状态筛选(切档回第 1 页) + 当前页全部未成功重试 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((x) => (
          <button
            key={x.key}
            type="button"
            onClick={() => setFilter({ status: x.key || null })}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
              filter.key === x.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
            )}
          >
            {x.label}
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
        <span className="text-xs text-muted-foreground">第 {f.page} / {totalPages} 页 · 每页 {PAGE_SIZE} 条</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={f.page <= 1} onClick={() => updateQuery({ page: f.page - 1 > 1 ? String(f.page - 1) : null })}>
            <ChevronLeft className="size-4" /> 上一页
          </Button>
          <Button variant="outline" size="sm" disabled={f.page >= totalPages} onClick={() => updateQuery({ page: String(f.page + 1) })}>
            下一页 <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
