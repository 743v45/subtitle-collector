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
import { BatchTaskCard, TaskRow, resubmitTasks, retrySummary } from '@/components/TaskCards';
import { useToast } from '@/components/ui/toast';
import { isActiveStatus, requestTaskNotifyPermission, sendTaskDoneNotification, terminalTransitions } from '@/lib/taskNotify';

const REFRESH_MS = 2000;

// ── 库摘要行：总量 + 今日采集（点击进看板）──
function LibrarySummary({ refreshKey }: { refreshKey: number }) {
  // overview 返回 { total, by_source }（2026-08-24 分平台小节）；摘要行只看全库 total
  const { data } = useAsync(() => getStatsOverview(), [refreshKey]);
  const o = data?.total;
  if (!o) {
    return <Skeleton className="h-9 w-full" />;
  }
  return (
    <button
      onClick={() => navigate('/stats')}
      className="flex w-full cursor-pointer items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span>
        库内 <span className="font-medium tabular-nums text-foreground">{o.videos.toLocaleString('zh-CN')}</span> 视频
        · <span className="font-medium tabular-nums text-foreground">{o.tracks.toLocaleString('zh-CN')}</span> 字幕轨
      </span>
      <span>
        今日 +<span className="font-medium tabular-nums text-foreground">{o.today_videos.toLocaleString('zh-CN')}</span>
      </span>
    </button>
  );
}

// ── 按 UP/频道批量（2026-08-19；2026-08-24 双平台）：输入 UID/空间链接/频道标识 → server 经扩展拉全量 → 过滤+勾选 → 批量建任务 ──
// 输入解析（粗判路由，细解析在 server）：裸数字 UID / space.bilibili.com/{mid} → B 站；
// @handle / UC 开头 channelId / youtube.com|youtu.be 链接 → YouTube 频道。
type UpperTarget = { source: 'bilibili'; mid: string } | { source: 'youtube'; channel: string };

function parseUpperTarget(text: string): UpperTarget | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return { source: 'bilibili', mid: t };
  if (/^UC[\w-]{22}$/.test(t)) return { source: 'youtube', channel: t };
  if (/^@[\w.-]{3,30}$/.test(t)) return { source: 'youtube', channel: t };
  try {
    const u = new URL(t);
    if (u.hostname === 'space.bilibili.com') {
      const seg = u.pathname.split('/').filter(Boolean)[0];
      if (seg && /^\d+$/.test(seg)) return { source: 'bilibili', mid: seg };
    }
    if (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com') || u.hostname === 'youtu.be') {
      return { source: 'youtube', channel: t };
    }
  } catch { /* 非 URL 忽略 */ }
  return null;
}

function fmtUpperDate(sec: number | null): string {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleDateString('zh-CN', { year: '2-digit', month: 'numeric', day: 'numeric' });
}

function UpperBatchSection({ onTasksChanged }: { onTasksChanged: () => void }) {
  const toast = useToast();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<{ total: number; items: UpperVideoItem[]; channel?: { id: string | null; name: string | null } } | null>(null);
  // 当前拉取目标（提交批量时定 source/creatorUid）：load 成功时记忆，input 变更不重置（旧列表仍可提交）
  const [target, setTarget] = useState<UpperTarget | null>(null);
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
    const tgt = parseUpperTarget(input);
    if (!tgt) { setErr('输入 UP 的数字 UID / 空间页链接，或 YouTube 频道 @handle / UC 开头 ID / 频道页链接'); return; }
    setLoading(true);
    setErr(null);
    setSubmitMsg(null);
    try {
      const r = await expandUpperVideos(tgt);
      setData(r);
      setTarget(tgt);
      setSelected(new Set());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setData(null);
      setTarget(null);
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
    requestTaskNotifyPermission(); // 用户手势内请求授权:批量跑完要能弹系统提醒
    if (selected.size > 50 && !window.confirm(`将创建 ${selected.size} 个采集任务（串行执行，约需 ${Math.ceil((selected.size * 8) / 60)} 分钟），确认？`)) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      // UP/频道归属随批落任务行（2026-08-22）：B 站 mid / YouTube channelId（展开回执带，无则 undefined）——
      // 未入库/失败任务也能在历史页按 UP 筛
      const source = target?.source ?? 'bilibili';
      const creatorUid = target?.source === 'bilibili' ? target.mid : data?.channel?.id ?? undefined;
      const r = await createCollectTasksBatch([...selected], source, creatorUid);
      const text = `已创建 ${r.created} 个任务${r.skipped ? `，跳过 ${r.skipped} 个（已在队列）` : ''}`;
      setSubmitMsg({ ok: true, text });
      toast(text, 'success'); // 中上 toast：列表在下方/已切走时也能看到任务已下发
      setSelected(new Set());
      onTasksChanged();
    } catch (e: any) {
      const text = String(e?.message ?? e);
      setSubmitMsg({ ok: false, text });
      toast(`批量提交失败：${text}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="text-sm font-medium">按 UP / 频道批量</div>
        <div className="flex gap-2">
          <Input
            className="h-10 flex-1"
            placeholder="B 站 UID / 空间链接，或 YouTube 频道 @handle / UC… / 频道页链接（需桌面扩展在线）"
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
              {/* YouTube 展开带频道名（归属可见）；B 站用 mid */}
              {data.channel?.name && <span className="text-foreground">{data.channel.name} · </span>}
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
              <div className={cn('text-sm', submitMsg.ok ? 'text-emerald-700' : 'text-destructive')}>
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
        'cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        active ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}

// ── 采集超时配置已挪独立设置页（2026-08-22,SettingsPage）——系统配置集中,不散进功能页 ──

export function CollectPage() {
  const toast = useToast();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CollectTask[]>([]);
  const aliveRef = useRef(true);
  // 在途待删任务 id:乐观移除后、DELETE 往返期间,轮询响应带回的这些 id 不写回列表
  // (否则批次卡以半删状态随轮询复活闪烁);删完或失败收尾时移除登记并 refresh 对齐真值。
  const deletingRef = useRef(new Set<number>());
  // 上一轮拉回的任务列表:完成检测 diff 基准(被删 id 不出现在 next 即出局,不误报完成)
  const tasksRef = useRef<CollectTask[]>([]);

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
        const next = items.filter((t) => !deletingRef.current.has(t.id));
        // 完成检测:与上一轮 diff 出「进行中→终态」转移且已无进行中 → 系统通知
        // (提交后切走标签页,跑完即被提醒;Notification 不可用/未授权时静默跳过)
        const finished = terminalTransitions(tasksRef.current, next);
        if (finished.length > 0 && !next.some((t) => isActiveStatus(t.status))) sendTaskDoneNotification(finished);
        tasksRef.current = next;
        setTasks(next);
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
    requestTaskNotifyPermission(); // 用户手势内请求授权:提交后跑完要能弹系统提醒
    setSubmitting(true);
    setErr(null);
    try {
      await createCollectTask(text.trim());
      setText('');
      toast('已提交采集任务', 'success');
      refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      toast(`提交失败：${String(e?.message ?? e)}`, 'error');
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
      toast('已删除任务', 'success');
    } catch {
      toast('删除失败，已恢复列表', 'error');
      refresh();
    } finally {
      deletingRef.current.delete(id);
    }
  };

  // 删除整个批次:级联删全部成员(含在途——与单删「任意状态可删」语义一致)。
  // 逐条容错:404=成员已被别处删视为已达成,其他失败也不中止,尽量删完;
  // 收尾移除登记并统一 refresh,失败成员经此恢复可见。
  const removeBatch = async (batchId: string) => {
    const ids = tasks.filter((t) => t.batch_id === batchId).map((t) => t.id);
    for (const id of ids) deletingRef.current.add(id);
    setTasks((prev) => prev.filter((t) => t.batch_id !== batchId));
    let failed = 0;
    for (const id of ids) {
      try {
        await deleteCollectTask(id);
      } catch {
        failed++; /* 单条失败继续下一个;真值以收尾 refresh 为准 */
      }
    }
    for (const id of ids) deletingRef.current.delete(id);
    if (failed === 0) toast(`已删除批次（${ids.length} 个任务）`, 'success');
    else toast(`删除批次完成（失败 ${failed} 个，已恢复列表）`, 'error');
    refresh();
  };

  // 重试:failed/limited 任务原地重置——resubmitTasks 经 retry 端点把原行重置回 pending 重跑
  // (不建新行,批次卡/进度随原行更新;库内已有字幕的 server 直接置成功免重采)。
  const retry = async (list: CollectTask[]) => {
    try {
      const r = await resubmitTasks(list);
      toast(retrySummary(r), r.dispatched + r.alreadyOk > 0 ? 'success' : 'default');
    } catch (e: any) {
      toast(`重试失败：${String(e?.message ?? e)}`, 'error');
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
        <h2 className="text-xl font-semibold tracking-tight">采集</h2>
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
