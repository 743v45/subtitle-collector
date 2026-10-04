// ── 通用 job 卡（CLI 全功能 web 化 Phase 4）：/api/jobs 单任务的自适应展示 ──
// 两种用法：{jobId}（自取数 + 2s 轮询，终态自动停；提交卡与最近任务列表用）
// 或受控 {job}（父组件持有数据直渲，不轮询不通知——转移通知语义只属于自取模式）。
// done 时发浏览器通知（复用 lib/taskNotify 的 jobs 通道；仅「进行中→done」转移，挂载即 done 不打扰）。
// 展示逻辑（徽章配色/进度条取档/汇总文案/轮询节拍）全部下沉 lib/jobMeta 纯函数，此处只做分派与布局。
import { useEffect, useRef, useState } from 'react';
import { Ban, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { cancelJob, getJob } from '../api-jobs';
import type { AsrJobResult, JobProgress, JobRow, JobStatus } from '../api-jobs';
import {
  JOB_POLL_MS, JOB_STATUS_META, barWidthClass, failedEntries, formatElapsed, formatJobTime,
  isTerminalStatus, jobProgressText, jobResultSummary, jobTypeLabel, nextPollDelay,
} from '../lib/jobMeta';
import { sendJobDoneNotification } from '../lib/taskNotify';

// 状态徽章（五态文案配色见 JOB_STATUS_META；RecentJobs 列表行复用）
export function StatusBadge({ status }: { status: JobStatus }) {
  const meta = JOB_STATUS_META[status] ?? JOB_STATUS_META.pending;
  return (
    <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs font-medium', meta.className)}>
      {meta.label}
    </span>
  );
}

// 失败分布 chips：「分类码 ×N · 样例vid」，大数在前；零项不渲染。运行中无样例（result 未落）只出计数。
function FailedChips({ failed, samples }: { failed?: Record<string, number> | null; samples?: Record<string, string[]> }) {
  const entries = failedEntries(failed);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([code, n]) => {
        const sample = samples?.[code] ?? [];
        return (
          <span key={code} className="rounded bg-red-500/15 px-1.5 py-0.5 text-xs text-red-400">
            {code} ×{n}{sample.length > 0 ? ` · ${sample.join('、')}` : ''}
          </span>
        );
      })}
    </div>
  );
}

// asr 运行中：进度条（done/total，档位取宽）+ 失败分类 chips；total 未落 = 还在圈定
function AsrProgress({ job }: { job: JobRow }) {
  const p = (job.progress ?? {}) as JobProgress;
  const total = p.total ?? 0;
  const done = p.done ?? 0;
  return (
    <div className="space-y-1">
      {total > 0 ? (
        <>
          {/* 宽度走字面量档位：禁 inline style（样式政策），Tailwind JIT 只认源码字面量类名 */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full rounded-full bg-primary transition-all', barWidthClass(done, total))} />
          </div>
          <div className="text-xs tabular-nums text-muted-foreground">转写中 {done}/{total}</div>
        </>
      ) : (
        <div className="text-xs text-muted-foreground">圈定中…</div>
      )}
      <FailedChips failed={p.failed} />
    </div>
  );
}

// find 运行中：阶段化一行文案（search/filter），progress 未落 = 等扩展执行
function FindProgress({ job }: { job: JobRow }) {
  const p = job.progress;
  if (p?.stage == null) {
    return <div className="text-sm text-muted-foreground">启动中（等待在线扩展执行搜索）…</div>;
  }
  return <div className="text-sm text-muted-foreground">{jobProgressText(p)}</div>;
}

// done 汇总：绿字一行（口径同系统通知 body）+ asr 型失败 chips（带样例 vid）
function DoneSummary({ job }: { job: JobRow }) {
  if (job.type === 'asr-backfill') {
    const r = (job.result ?? {}) as AsrJobResult;
    return (
      <div className="space-y-1">
        <div className="text-sm text-emerald-400">{jobResultSummary(job)}</div>
        <FailedChips failed={r.failed} samples={r.samples} />
      </div>
    );
  }
  return <div className="text-sm text-emerald-400">{jobResultSummary(job)}</div>;
}

// 按状态 × 类型分派正文
function JobBody({ job }: { job: JobRow }) {
  if (job.status === 'failed') {
    return <div role="alert" className="text-sm text-destructive">{job.error ?? '任务失败（无错误详情）'}</div>;
  }
  if (job.status === 'done') return <DoneSummary job={job} />;
  if (job.status === 'cancelled') return null; // 徽章已表达「已取消」，正文不重复
  if (job.status === 'pending') return <div className="text-sm text-muted-foreground">排队中（等待 worker 执行）</div>;
  // running：按类型分派
  if (job.type === 'asr-backfill') return <AsrProgress job={job} />;
  if (job.type === 'collect-find') return <FindProgress job={job} />;
  return null;
}

export function JobCard({ jobId, job: controlledJob, onChanged }: {
  jobId?: number;                // 自取模式：挂载即取 + 轮询
  job?: JobRow | null;           // 受控模式：父组件持有数据直渲（不轮询不通知）
  onChanged?: (job: JobRow) => void;
}) {
  const [fetched, setFetched] = useState<JobRow | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const prevStatusRef = useRef<JobStatus | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged; // latest-ref：轮询 effect 闭包不依赖回调身份

  const isPolling = jobId != null;
  const job = isPolling ? fetched : (controlledJob ?? null);

  // 自取模式轮询：挂载即取，setTimeout 链按 nextPollDelay 节拍续排（终态=0 自动停）；
  // 卸载 alive+clearTimeout 双保险；单次取数失败不清旧状态、红字提示并按标准节拍续链重试
  useEffect(() => {
    if (jobId == null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    prevStatusRef.current = null; // 换 id 重置转移基线
    const tick = async (): Promise<void> => {
      try {
        const next = await getJob(jobId);
        if (!alive) return;
        setPollError(null);
        setFetched(next);
        // 「进行中→done」转移发系统通知；挂载即 done 不发（用户没从这张卡提交过任务，不抢戏）
        const prev = prevStatusRef.current;
        if (prev != null && !isTerminalStatus(prev) && next.status === 'done') {
          sendJobDoneNotification(next, jobResultSummary(next));
        }
        prevStatusRef.current = next.status;
        onChangedRef.current?.(next);
        const delay = nextPollDelay(next.status);
        if (delay > 0) timer = setTimeout(() => { void tick(); }, delay);
      } catch (e) {
        if (!alive) return;
        setPollError((e as Error).message);
        timer = setTimeout(() => { void tick(); }, JOB_POLL_MS);
      }
    };
    void tick();
    return () => { alive = false; if (timer != null) clearTimeout(timer); };
  }, [jobId]);

  const handleCancel = async (): Promise<void> => {
    if (!job || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const updated = await cancelJob(job.id);
      if (isPolling) setFetched(updated); // 就地切 cancelled；轮询链下一轮复核终态后自动停
      prevStatusRef.current = updated.status;
      onChangedRef.current?.(updated);
    } catch (e) {
      // running 不可取消（server 409「running 任务不可取消」）等失败：红字透出，任务本身不受影响
      setCancelError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  if (!job) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载任务…
        </CardContent>
      </Card>
    );
  }

  const cancellable = job.status === 'pending' || job.status === 'running';
  const elapsed = formatElapsed(job);

  return (
    <Card>
      <CardContent className="space-y-1.5 p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{jobTypeLabel(job.type)}</span>
          <span className="text-xs tabular-nums text-muted-foreground">#{job.id}</span>
          <StatusBadge status={job.status} />
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {formatJobTime(job.created_at)}
            {elapsed !== '' ? ` · 耗时 ${elapsed}` : ''}
          </span>
          {cancellable && (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={cancelling} onClick={() => { void handleCancel(); }}>
              {cancelling ? <Loader2 className="size-3 animate-spin" /> : <Ban className="size-3" />}
              取消
            </Button>
          )}
        </div>
        <JobBody job={job} />
        {pollError && <div role="alert" className="text-xs text-amber-400">刷新失败：{pollError}（将继续重试）</div>}
        {cancelError && <div role="alert" className="text-xs text-destructive">取消失败：{cancelError}</div>}
      </CardContent>
    </Card>
  );
}
