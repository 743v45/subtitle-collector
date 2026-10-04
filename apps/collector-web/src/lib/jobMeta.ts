// jobs 展示元数据与轮询纯逻辑（Phase 4）：components/JobCard 与 components/RecentJobs 共用。
// 抽 lib 纯函数（无 React 依赖）——轮询节拍/进度条取档/汇总文案都可直测，不靠挂组件。
// 措辞：字幕（subtitle），非弹幕。
import type { AsrJobResult, FindJobResult, JobProgress, JobRow, JobStatus } from '../api-jobs';

// 轮询间隔：对齐采集页任务列表的 2s 节拍
export const JOB_POLL_MS = 2000;

// 任务类型中文标签（未知类型回落原值——server 先行加类型时 UI 不至于裸奔英文键）
export const JOB_TYPE_LABEL: Record<string, string> = {
  'asr-backfill': 'ASR 转写',
  'collect-find': '搜索采集',
};

export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABEL[type] ?? type;
}

// 五态徽章文案与配色（暗色主题：x-500/15 底 + x-400 字，对齐 TaskCards STATUS_META 先例；
// running 加 animate-pulse 蓝闪；pending/cancelled 同为灰但文案区分）
export const JOB_STATUS_META: Record<JobStatus, { label: string; className: string }> = {
  pending: { label: '排队中', className: 'bg-muted text-muted-foreground' },
  running: { label: '运行中', className: 'bg-blue-500/15 text-blue-400 animate-pulse' },
  done: { label: '已完成', className: 'bg-emerald-500/15 text-emerald-400' },
  failed: { label: '失败', className: 'bg-red-500/15 text-red-400' },
  cancelled: { label: '已取消', className: 'bg-muted text-muted-foreground' },
};

// 终态判据：done/failed/cancelled 均不再轮询
export function isTerminalStatus(s: JobStatus): boolean {
  return s === 'done' || s === 'failed' || s === 'cancelled';
}

// 轮询节拍（纯函数）：active → JOB_POLL_MS；终态 → 0（调用方 0 即停，不再排下一轮）
export function nextPollDelay(s: JobStatus): number {
  return isTerminalStatus(s) ? 0 : JOB_POLL_MS;
}

// 进度条宽度档位（Tailwind JIT 只编译源码里出现过的字面量类名，动态拼 `w-[${pct}%]` 不会生成——
// 10% 步进取档，全档类名字面量在此数组里）。禁 inline style（样式政策），此即合规替代。
const BAR_WIDTHS = ['w-0', 'w-[10%]', 'w-[20%]', 'w-[30%]', 'w-[40%]', 'w-[50%]', 'w-[60%]', 'w-[70%]', 'w-[80%]', 'w-[90%]', 'w-full'] as const;

export function barWidthClass(done: number, total: number): string {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done <= 0) return 'w-0';
  const pct = Math.min(100, Math.round((done / total) * 100));
  return BAR_WIDTHS[Math.min(BAR_WIDTHS.length - 1, Math.floor(pct / 10))]; // pct 已夹取，下标恒在界内
}

// created_at（ms）→「MM/DD HH:mm」；空值回落空串
export function formatJobTime(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// 耗时：终态用 finished_at，运行中用当前时刻；未开始（无 started_at）回落空串。<60s 显示「Ns」
export function formatElapsed(job: Pick<JobRow, 'status' | 'started_at' | 'finished_at'>, now = Date.now()): string {
  if (job.started_at == null) return '';
  const end = job.finished_at ?? (isTerminalStatus(job.status) ? job.started_at : now);
  const sec = Math.max(0, Math.round((end - job.started_at) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

// 失败分布收窄：{分类码: 计数} 里滤零项并降序（大数在前），空 → 空数组
export function failedEntries(failed: Record<string, number> | undefined | null): Array<[string, number]> {
  return Object.entries(failed ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
}

// done 汇总文案（asr：圈定 N · 成功 M · 失败分布；find：候选/粉丝过滤/未知/建任务）。
// 同时供 JobCard 展示与 done 系统通知 body，保证两处口径一致。
export function jobResultSummary(job: JobRow): string {
  if (job.type === 'asr-backfill') {
    const r = (job.result ?? {}) as AsrJobResult;
    const failed = failedEntries(r.failed).map(([code, n]) => `${code} ${n}`).join(' · ');
    return `圈定 ${r.circled ?? 0} · 成功 ${r.done ?? 0}${failed ? ` · 失败 ${failed}` : ''}`;
  }
  const r = (job.result ?? {}) as FindJobResult;
  const parts = [
    `候选 ${r.candidates ?? 0}`,
    `粉丝过滤剔除 ${r.filtered_fans ?? 0}`,
    `粉丝未知 ${r.unknown_fans ?? 0}`,
  ];
  if (r.collected) parts.push(`建任务 ${r.collected.created}（跳过 ${r.collected.skipped}）`);
  return parts.join(' · ');
}

// 运行中进度一行文案（find 型阶段化：search=搜索中、filter=过滤中）
export function jobProgressText(p: JobProgress): string {
  if (p.stage === 'filter') {
    return `过滤中：已抓 ${p.pages_fetched ?? 0} 页 · 候选 ${p.candidates ?? 0} · 时间过滤剔除 ${p.filtered_since ?? 0} · 粉丝过滤剔除 ${p.filtered_fans ?? 0} · 粉丝未知 ${p.unknown_fans ?? 0}`;
  }
  return `搜索中：已抓 ${p.pages_fetched ?? 0} 页 · 候选 ${p.candidates ?? 0} 条`;
}
