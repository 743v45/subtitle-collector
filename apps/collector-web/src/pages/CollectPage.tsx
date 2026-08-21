import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createCollectTask, createCollectTasksBatch, deleteCollectTask, expandUpperVideos, listCollectTasks, getStatsOverview } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useAsync } from '@/lib/useAsync';
import { navigate } from '../router';
import { Loader2, Search, Send } from 'lucide-react';
import type { CollectTask, UpperVideoItem } from '../types';
import { BatchTaskCard, TaskRow, retryable } from '@/components/TaskCards';

const REFRESH_MS = 2000;

// ── 库摘要行：总量 + 今日采集（点击进看板）──
function LibrarySummary({ refreshKey }: { refreshKey: number }) {
  const { data } = useAsync(() => getStatsOverview(), [refreshKey]);
  if (!data) {
    return <Skeleton className="h-9 w-full" />;
  }
  return (
    <button
      onClick={() => navigate('/stats')}
      className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60"
    >
      <span>
        库内 <span className="font-medium tabular-nums text-foreground">{data.videos.toLocaleString('zh-CN')}</span> 视频
        · <span className="font-medium tabular-nums text-foreground">{data.tracks.toLocaleString('zh-CN')}</span> 字幕轨
      </span>
      <span>
        今日 +<span className="font-medium tabular-nums text-foreground">{data.today_videos.toLocaleString('zh-CN')}</span>
      </span>
    </button>
  );
}

// ── 按 UP 批量（2026-08-19）：输入 UID/空间链接 → server 经扩展拉全量 → 过滤+勾选 → 批量建任务 ──
// 输入解析：裸数字 UID 或 space.bilibili.com/{mid} 链接（含 /upload/video 子路径）。
function parseUpperMid(text: string): string | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) return t;
  try {
    const u = new URL(t);
    if (u.hostname === 'space.bilibili.com') {
      const seg = u.pathname.split('/').filter(Boolean)[0];
      if (seg && /^\d+$/.test(seg)) return seg;
    }
  } catch { /* 非 URL 忽略 */ }
  return null;
}

function fmtUpperDate(sec: number | null): string {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleDateString('zh-CN', { year: '2-digit', month: 'numeric', day: 'numeric' });
}

function UpperBatchSection({ onTasksChanged }: { onTasksChanged: () => void }) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<{ total: number; items: UpperVideoItem[] } | null>(null);
  // 过滤（档位化对齐 popup）+ 勾选
  const [statusFilter, setStatusFilter] = useState<'all' | 'uncollected' | 'collected'>('all');
  const [timeDays, setTimeDays] = useState(0);
  const [viewMin, setViewMin] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const collectedCount = data ? data.items.filter((it) => it.collected).length : null;

  // missingCount：时间/播放档位开启时因数据缺失（created/play null）被排除的条数 ——
  // 解析失败对用户可见，不再表现为「条目无声消失」。
  const { filtered, missingCount } = useMemo(() => {
    if (!data) return { filtered: [] as UpperVideoItem[], missingCount: 0 };
    const sinceMs = timeDays > 0 ? Date.now() - timeDays * 86400_000 : 0;
    const out: UpperVideoItem[] = [];
    let missing = 0;
    for (const it of data.items) {
      if (statusFilter === 'collected' && !it.collected) continue;
      if (statusFilter === 'uncollected' && it.collected) continue;
      let pass = true;
      let missingData = false;
      if (sinceMs > 0) {
        if (it.created == null) { pass = false; missingData = true; }
        else if (it.created * 1000 < sinceMs) pass = false;
      }
      if (viewMin > 0) {
        if (it.play == null) { pass = false; missingData = true; }
        else if (it.play < viewMin) pass = false;
      }
      if (pass) out.push(it);
      else if (missingData) missing++;
    }
    return { filtered: out, missingCount: missing };
  }, [data, statusFilter, timeDays, viewMin]);

  const load = async () => {
    if (loading) return;
    const mid = parseUpperMid(input);
    if (!mid) { setErr('输入 UP 的数字 UID 或空间页链接（如 https://space.bilibili.com/296399504）'); return; }
    setLoading(true);
    setErr(null);
    setSubmitMsg(null);
    try {
      const r = await expandUpperVideos(mid);
      setData(r);
      setSelected(new Set());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setData(null);
    } finally {
      setLoading(false);
    }
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
    if (selected.size > 50 && !window.confirm(`将创建 ${selected.size} 个采集任务（串行执行，约需 ${Math.ceil((selected.size * 8) / 60)} 分钟），确认？`)) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      // mid 随批落任务行（2026-08-22）：当前拉取的 UP 归属——未入库/失败任务也能在历史页按 UP 筛
      const r = await createCollectTasksBatch([...selected], 'bilibili', parseUpperMid(input) ?? undefined);
      setSubmitMsg({ ok: true, text: `已创建 ${r.created} 个任务${r.skipped ? `，跳过 ${r.skipped} 个（已在队列）` : ''}` });
      setSelected(new Set());
      onTasksChanged();
    } catch (e: any) {
      setSubmitMsg({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="text-sm font-medium">按 UP 批量</div>
        <div className="flex gap-2">
          <Input
            className="h-10 flex-1"
            placeholder="UP UID 或空间页链接（需桌面扩展在线）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
          />
          <Button className="h-10 px-4" disabled={loading} onClick={() => void load()}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            拉取
          </Button>
        </div>
        {err && <div className="text-sm text-destructive">{err}</div>}

        {data && (
          <>
            {/* 摘要 + 过滤条 */}
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              <span>共 <span className="tabular-nums text-foreground">{data.total}</span> 条</span>
              <span>· <span className="tabular-nums text-foreground">{collectedCount}</span> 已采</span>
              {(
                [
                  ['all', `全部 ${data.items.length}`],
                  ['uncollected', `未采 ${data.items.length - (collectedCount ?? 0)}`],
                  ['collected', `已采 ${collectedCount ?? 0}`],
                ] as const
              ).map(([value, label]) => (
                <FilterPill key={value} active={statusFilter === value} onClick={() => setStatusFilter(value)}>{label}</FilterPill>
              ))}
              <FilterPill active={timeDays === 182} onClick={() => setTimeDays(timeDays === 182 ? 0 : 182)}>近半年</FilterPill>
              <FilterPill active={timeDays === 365} onClick={() => setTimeDays(timeDays === 365 ? 0 : 365)}>近一年</FilterPill>
              {([[1000, '1千+'], [10000, '1万+'], [100000, '10万+']] as const).map(([value, label]) => (
                <FilterPill key={value} active={viewMin === value} onClick={() => setViewMin(viewMin === value ? 0 : value)}>{label}</FilterPill>
              ))}
            </div>

            {/* 勾选列表 */}
            <div className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
              {filtered.map((it) => {
                const isSel = selected.has(it.bvid);
                return (
                  <label
                    key={it.bvid}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm transition-colors',
                      isSel ? 'bg-primary/10' : 'hover:bg-muted/60'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggle(it.bvid)}
                      className="size-3.5 shrink-0 accent-primary"
                    />
                    {/* 封面缩略图（16:9，缺失占位灰块；no-referrer 防 CDN 防盗链） */}
                    {it.pic ? (
                      <img
                        src={it.pic}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-11 w-20 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="h-11 w-20 shrink-0 rounded bg-muted" />
                    )}
                    <span
                      title={it.collected ? '字幕已采集' : '未采集'}
                      className={cn('size-1.5 shrink-0 rounded-full', it.collected ? 'bg-emerald-500' : 'bg-muted-foreground/30')}
                    />
                    <span className="min-w-0 flex-1 truncate" title={it.title}>{it.title}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {it.length ?? ''}{it.play != null ? ` · ${it.play.toLocaleString('zh-CN')}` : ''}{it.created ? ` · ${fmtUpperDate(it.created)}` : ''}
                    </span>
                  </label>
                );
              })}
              {filtered.length === 0 && (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  无匹配视频（调整过滤条件{missingCount > 0 ? `；另有 ${missingCount} 条缺播放量/日期未纳入` : ''}）
                </div>
              )}
              {filtered.length > 0 && missingCount > 0 && (
                <div className="py-1 text-center text-xs text-muted-foreground/70">
                  另有 {missingCount} 条缺播放量/日期未纳入过滤
                </div>
              )}
            </div>

            {/* 底部操作 */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelected(new Set(filtered.filter((it) => !it.collected).map((it) => it.bvid)))}
              >
                全选未采
              </Button>
              {selected.size > 0 && (
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setSelected(new Set())}>
                  清空
                </Button>
              )}
              <Button
                size="sm"
                className="ml-auto"
                disabled={selected.size === 0 || submitting}
                onClick={() => void submitBatch()}
              >
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                批量采集 ({selected.size})
              </Button>
            </div>
            {submitMsg && (
              <div className={cn('text-sm', submitMsg.ok ? 'text-emerald-600' : 'text-destructive')}>
                {submitMsg.text}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// 过滤条件小 pill（选中=主色；web 侧样式对齐 popup）
function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
        active ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}

export function CollectPage() {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CollectTask[]>([]);
  const aliveRef = useRef(true);
  // 在途待删任务 id:乐观移除后、DELETE 往返期间,轮询响应带回的这些 id 不写回列表
  // (否则批次卡以半删状态随轮询复活闪烁);删完或失败收尾时移除登记并 refresh 对齐真值。
  const deletingRef = useRef(new Set<number>());

  // 摘要行刷新信号：挂载 1 次 + succeeded 数变化（新任务完成）时 +1
  const [statsTick, setStatsTick] = useState(0);
  const succCount = tasks.filter((t) => t.status === 'succeeded').length;
  const prevSuccRef = useRef(succCount);
  useEffect(() => {
    if (succCount !== prevSuccRef.current) {
      prevSuccRef.current = succCount;
      setStatsTick((n) => n + 1);
    }
  }, [succCount]);

  const refresh = () => {
    listCollectTasks(30)
      .then(({ items }) => {
        if (!aliveRef.current) return;
        setTasks(items.filter((t) => !deletingRef.current.has(t.id)));
      })
      .catch(() => { /* 轮询失败静默,下次再试 */ });
  };

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => { aliveRef.current = false; clearInterval(t); };
  }, []);

  const submit = async () => {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      await createCollectTask(text.trim());
      setText('');
      refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  // 删除任务:成功后本地立即移除(不等 2s 轮询);失败时登记已撤销,refresh 拉回真值(行恢复可见)
  const remove = async (id: number) => {
    deletingRef.current.add(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try {
      await deleteCollectTask(id);
    } catch {
      refresh();
    } finally {
      deletingRef.current.delete(id);
    }
  };

  // 删除整个批次:级联删全部成员(含在途——与单删「任意状态可删」语义一致)。
  // 逐条容错:404=成员已被别处删视为已达成,其他失败也不中止,尽量删完;
  // 收尾移除登记并统一 refresh,失败成员经此恢复可见(不做错误弹窗)。
  const removeBatch = async (batchId: string) => {
    const ids = tasks.filter((t) => t.batch_id === batchId).map((t) => t.id);
    for (const id of ids) deletingRef.current.add(id);
    setTasks((prev) => prev.filter((t) => t.batch_id !== batchId));
    for (const id of ids) {
      try {
        await deleteCollectTask(id);
      } catch {
        /* 单条失败继续下一个;真值以收尾 refresh 为准 */
      }
    }
    for (const id of ids) deletingRef.current.delete(id);
    refresh();
  };

  // 重试:failed/limited 任务重建——复用批量端点(终态允许重采;同视频已有在途任务由 server 去重
  // skipped)。按 source 分组各发一次;新任务(新批次)随 refresh 出现。无错误弹窗:结果以列表为准。
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
    } finally {
      refresh();
    }
  };

  const hasActive = tasks.some((t) => t.status === 'pending' || t.status === 'dispatched');

  // 展示侧聚合（2026-08-21）：同 batch_id 聚成 BatchTaskCard,单任务独立 TaskRow;
  // 顺序跟随 server 返回序（id desc）,批次卡位置 = 组内最新成员位置。
  // 批次只剩 1 个成员（建批即 1 个或级联删剩 1 个）时子行信息量与单任务卡无异,直接渲染 TaskRow。
  const listNodes: Array<ReactNode> = [];
  const batched = new Set<string>();
  for (const t of tasks) {
    if (t.batch_id) {
      if (batched.has(t.batch_id)) continue; // 同批只渲染一次（该批全部成员）
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">采集</h2>
        <span className="text-sm text-muted-foreground">{tasks.length} 条任务</span>
      </div>

      {/* 库摘要行：采集完成后数字随之变化,点击进看板看全量统计 */}
      <LibrarySummary refreshKey={statsTick} />

      {/* 提交区：大输入框（手机粘贴分享文本）+ 提交按钮 */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input
            className="h-12 flex-1 text-base"
            placeholder="粘贴视频链接或分享文本（B站 / YouTube）"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          <Button className="h-12 px-5" disabled={submitting || !text.trim()} onClick={() => void submit()}>
            {submitting ? <Loader2 className="size-5 animate-spin" /> : <Send className="size-5" />}
            采集
          </Button>
        </div>
        {err && <div className="text-sm text-destructive">{err}</div>}
      </div>

      {/* 按 UP 批量：输入 UID/空间链接 → 全量列表 → 过滤+勾选 → 批量建任务 */}
      <UpperBatchSection onTasksChanged={refresh} />

      {/* 任务列表（2s 轮询,有进行中任务时提示）；批次聚合为一卡,单任务独立一卡 */}
      <div className="space-y-2">
        {hasActive && (
          <div className="text-xs text-muted-foreground animate-pulse">
            有任务进行中,每 {REFRESH_MS / 1000}s 自动刷新…
          </div>
        )}
        {listNodes}
        {tasks.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              还没有采集任务。粘贴一个视频链接试试。
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
