// ── 采集任务卡片（2026-08-22 从 CollectPage 提取）──
// 采集页（最近 30 条,轮询）与历史页（全量分页）共用:单任务卡 TaskRow / 批次聚合卡 BatchTaskCard。
// 重试:failed/limited 行与批次卡「重试未成功」按钮 → onRetry(该组未终态外的可重试任务);
// 上层用批量端点重建任务(终态允许重采,pending/dispatched 由 server 去重跳过)。
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { navigate } from '../router';
import { getVideo, getVersion } from '../api';
import { useAsync } from '@/lib/useAsync';
import type { SubtitleLine } from '@/components/SubtitleView';
import { ChevronDown, ChevronUp, Eye, RotateCcw, Trash2 } from 'lucide-react';
import type { CollectTask, VideoDetail } from '../types';

// 任务状态徽章文案与配色（pending 细分「等待扩展上线/排队中」由客户端数区分,这里统一显示）
export const STATUS_META: Record<CollectTask['status'], { label: string; className: string }> = {
  pending: { label: '排队中', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  dispatched: { label: '采集中', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  succeeded: { label: '已完成', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  failed: { label: '失败', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  limited: { label: '受限', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
};

export const PLATFORM_LABEL: Record<string, string> = { bilibili: 'B站', youtube: 'YouTube' };

// 可重试判据:终态且产出不全（failed / limited——字幕受限 0 轨）。succeeded 的 no_subtitle 是真无字幕,不可重试。
export function retryable(t: CollectTask): boolean {
  return t.status === 'failed' || t.status === 'limited';
}

export function formatTs(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// 扩展回执 result（JSON 字符串）→ 摘要文案
export function resultSummary(task: CollectTask): string {
  if (task.status === 'failed') return task.error ?? '采集失败';
  if (task.status === 'limited') return '字幕受限（pot），0 轨入库；元信息已入库，可重试';
  if (task.status === 'pending') return '等待派发（扩展上线后自动开始）';
  if (!task.result) return task.status === 'dispatched' ? '已下发到扩展…' : '';
  try {
    const r = JSON.parse(task.result) as { captured?: number; tracks?: number; reason?: string };
    if (r.reason === 'no_subtitle') return '视频无字幕轨';
    if (r.reason === 'pot_limited') return '字幕受限（pot），0 轨入库';
    if (typeof r.captured === 'number') return `采到 ${r.captured} 轨字幕`; // YouTube 回执
    if (typeof r.tracks === 'number') return `采到 ${r.tracks} 轨字幕`;     // B 站回执
  } catch { /* 非预期结构忽略 */ }
  return '';
}

export function TaskRow({ task, onDelete, onRetry }: {
  task: CollectTask;
  onDelete: (id: number) => void;
  onRetry?: (task: CollectTask) => void;
}) {
  const meta = STATUS_META[task.status] ?? STATUS_META.pending;
  const [expanded, setExpanded] = useState(false);
  const canOpen = task.status === 'succeeded'; // failed/limited 未入库不可跳;no_subtitle 的 succeeded 视频在库可跳
  const canRetry = retryable(task) && !!onRetry;

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs font-medium', meta.className)}>{meta.label}</span>
          {/* 标题直出（server JOIN videos）；未入库（pending/failed）回落 平台·BV号 */}
          {task.title ? (
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={task.title}>{task.title}</span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {PLATFORM_LABEL[task.source] ?? task.source} · {task.source_vid}
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatTs(task.created_at)}</span>
          {canRetry && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-primary"
              aria-label="重试采集"
              title="重试采集（重建任务）"
              onClick={() => onRetry!(task)}
            >
              <RotateCcw className="size-4" />
            </Button>
          )}
          {canOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-primary"
              aria-label="查看视频详情"
              title="查看视频详情"
              onClick={() => navigate(`/videos/${task.source}/${encodeURIComponent(task.source_vid)}`)}
            >
              <Eye className="size-4" />
            </Button>
          )}
          {/* succeeded 展开就地预览；其余状态无内容可预览 */}
          {canOpen ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label={expanded ? '收起预览' : '展开预览'}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label="删除任务"
            onClick={() => onDelete(task.id)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        <div className={cn('text-sm', task.status === 'failed' ? 'text-destructive' : task.status === 'limited' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
          {/* 有标题时次行给 平台·BV号 + 摘要;无标题保持摘要 */}
          {task.title && (
            <span className="text-xs">{PLATFORM_LABEL[task.source] ?? task.source} · {task.source_vid} · </span>
          )}
          {resultSummary(task)}
        </div>
        {expanded && canOpen && <TaskPreview task={task} />}
      </CardContent>
    </Card>
  );
}

// ── 就地预览：succeeded 任务展开看入库结果（轨列表 + 默认轨正文前几行）──
const PREVIEW_LINES = 8; // 就地预览正文行数（点击「查看完整字幕」进详情看全部）

function TaskPreview({ task }: { task: CollectTask }) {
  const detailQ = useAsync(() => getVideo(task.source, task.source_vid), [task.source, task.source_vid]);

  if (detailQ.loading) {
    return (
      <div className="space-y-2 pt-1">
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-16 w-full animate-pulse rounded bg-muted" />
      </div>
    );
  }
  if (detailQ.error) {
    return (
      <div className="pt-1 text-sm text-destructive">
        预览加载失败:{detailQ.error}
      </div>
    );
  }
  return <TaskPreviewBody task={task} detail={detailQ.data} />;
}

function TaskPreviewBody({ task, detail }: { task: CollectTask; detail: VideoDetail | null }) {
  const tracks = detail?.tracks ?? [];
  const defTrack = tracks.find((t) => t.is_default) ?? tracks[0];
  const defVersion = defTrack?.versions.find((v) => v.is_default) ?? defTrack?.versions[0];
  const bodyQ = useAsync(
    () => defVersion != null ? getVersion(defVersion.id) : Promise.resolve(null),
    [defVersion?.id],
  );

  const openFull = () => navigate(`/videos/${task.source}/${encodeURIComponent(task.source_vid)}`);

  return (
    <div className="space-y-2 pt-1">
      {/* 轨列表（标题已在卡片主行直出,预览区不重复） */}
      <div className="flex flex-wrap gap-1">
        {tracks.length === 0 && <span className="text-xs text-muted-foreground">视频无字幕轨（仅元信息入库）</span>}
        {tracks.map((t) => (
          <span
            key={t.id}
            className={cn(
              'rounded px-1.5 py-0.5 text-xs',
              t.id === defTrack?.id
                ? 'bg-primary/15 text-primary'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {t.lan_doc || t.lan || '?'} · {t.versions.length} 版
          </span>
        ))}
      </div>

      {/* 默认轨正文前几行 */}
      {defVersion != null && (
        <>
          {bodyQ.loading && <div className="h-24 w-full animate-pulse rounded bg-muted" />}
          {!bodyQ.loading && bodyQ.error && (
            <div className="text-xs text-destructive">
              字幕加载失败:{bodyQ.error}
              <button className="ml-1 underline" onClick={bodyQ.reload}>重试</button>
            </div>
          )}
          {!bodyQ.loading && !bodyQ.error && (
            <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-muted/40 p-2">
              {((bodyQ.data?.version?.payload?.body ?? []) as SubtitleLine[])
                .slice(0, PREVIEW_LINES)
                .map((l, i) => (
                  <div key={i} className="flex gap-2 text-xs">
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {String(Math.floor(l.from / 60)).padStart(2, '0')}:{String(Math.floor(l.from % 60)).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 break-words">{l.content}</span>
                  </div>
                ))}
              {(bodyQ.data?.version?.payload?.body ?? []).length === 0 && (
                <span className="text-xs text-muted-foreground">（字幕体为空）</span>
              )}
            </div>
          )}
        </>
      )}

      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={openFull}>
        查看完整字幕
      </Button>
    </div>
  );
}

// 批次聚合卡:同 batch_id 的批量任务聚成一张卡。
// 批次无实体/状态——徽章与进度全部从子任务派生（任一在途=进行中;全终态按 失败>受限>完成 取最高警级）。
// 展开看子任务轻行(状态 + 标题/vid + 摘要 + 单删);卡头删除 = 级联删全部成员;有未成功(failed/limited)可整批重试。
export function BatchTaskCard({ items, onDelete, onDeleteBatch, onRetry, onRetryTask }: {
  items: CollectTask[];
  onDelete: (id: number) => void;
  onDeleteBatch: (batchId: string) => void;
  onRetry?: (tasks: CollectTask[]) => void;
  onRetryTask?: (task: CollectTask) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = items.some((t) => t.status === 'pending' || t.status === 'dispatched');
  const ok = items.filter((t) => t.status === 'succeeded').length;
  const fail = items.filter((t) => t.status === 'failed').length;
  const limited = items.filter((t) => t.status === 'limited').length;
  // 批次徽章派生:进行中(有 dispatched=采集中,否则排队中)/失败/受限/全成功
  const meta = active
    ? items.some((t) => t.status === 'dispatched') ? STATUS_META.dispatched : STATUS_META.pending
    : fail > 0 ? STATUS_META.failed : limited > 0 ? STATUS_META.limited : STATUS_META.succeeded;
  const label = active
    ? meta.label
    : fail > 0 ? (ok > 0 ? `完成 ${ok} 失败 ${fail}` : `失败 ${fail}`)
    : limited > 0 ? `受限 ${limited}`
    : `已完成 ${ok}`;
  const sources = [...new Set(items.map((t) => t.source))];
  const createdAt = Math.min(...items.map((t) => t.created_at));
  const batchId = items[0].batch_id!;
  const unretry = items.filter(retryable);
  const canRetry = unretry.length > 0 && !!onRetry;

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs font-medium', meta.className)}>{label}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            批量采集 · {items.length} 个视频
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {sources.map((s) => PLATFORM_LABEL[s] ?? s).join('/')}
            </span>
          </span>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {ok}/{items.length}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatTs(createdAt)}</span>
          {canRetry && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-primary"
              aria-label={`重试 ${unretry.length} 个未成功`}
              title={`重试 ${unretry.length} 个未成功（失败+受限）`}
              onClick={() => onRetry!(unretry)}
            >
              <RotateCcw className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label={expanded ? '收起子任务' : '展开子任务'}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label="删除整个批次"
            title="删除整个批次（含未完成子任务）"
            onClick={() => onDeleteBatch(batchId)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        {expanded && (
          <div className="space-y-1 rounded-md bg-muted/30 p-2">
            {items.map((t) => {
              const m = STATUS_META[t.status] ?? STATUS_META.pending;
              return (
                <div key={t.id} className="flex items-center gap-2 text-sm">
                  <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs', m.className)}>{m.label}</span>
                  <span
                    className="min-w-0 flex-1 truncate text-xs"
                    title={t.title ?? `${PLATFORM_LABEL[t.source] ?? t.source} · ${t.source_vid}`}
                  >
                    {t.title || `${PLATFORM_LABEL[t.source] ?? t.source} · ${t.source_vid}`}
                  </span>
                  <span className={cn('shrink-0 text-xs', t.status === 'failed' ? 'text-destructive' : t.status === 'limited' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                    {resultSummary(t)}
                  </span>
                  {retryable(t) && onRetryTask && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-primary"
                      aria-label="重试子任务"
                      title="重试采集（重建任务）"
                      onClick={() => onRetryTask(t)}
                    >
                      <RotateCcw className="size-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-destructive"
                    aria-label="删除子任务"
                    onClick={() => onDelete(t.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
