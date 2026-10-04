// ── 批量聚合卡 BatchTaskCard（2026-10-05 从 TaskCards.tsx 拆出;采集页/历史页共用）──
// 同 batch_id 的批量任务聚成一张卡。批次无实体/状态——徽章与进度全部从子任务派生
// （任一在途=进行中;全终态按 失败>受限>完成 取最高警级）。展开看子任务轻行（状态 + 标题/vid +
// 摘要 + 单删）;卡头删除 = 级联删全部成员;有未成功（failed/limited）可整批重试。
// 2026-10-05:卡头副文案融入 UP/博主归属（批量提交入口已知的 creator_name,成员 JOIN 而来;
// 旧批/成员全部未入库时 null → 不显示）;行尾四图标 tooltip 全量补齐。
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { navigate } from '../router';
import { videoUrl } from '../lib/externalLinks';
import { ExtLink } from '@/components/ExtLink';
import { ChevronDown, ChevronUp, Focus, RotateCcw, Trash2 } from 'lucide-react';
import { PLATFORM_LABEL, STATUS_META, TIP_DELETE, TIP_RETRY, formatTs, retryable, resultSummary } from './taskCardShared';
import type { CollectTask } from '../types';

// 批次徽章与计数标签派生:任一在途=进行中（有 dispatched=采集中,否则排队中）;
// 全终态按 失败>受限>完成 取最高警级,完成/失败混排给「完成 N 失败 M」。
function batchBadge(items: CollectTask[]): { className: string; label: string } {
  const ok = items.filter((t) => t.status === 'succeeded').length;
  const fail = items.filter((t) => t.status === 'failed').length;
  const limited = items.filter((t) => t.status === 'limited').length;
  const active = items.some((t) => t.status === 'pending' || t.status === 'dispatched');
  const meta = active
    ? items.some((t) => t.status === 'dispatched') ? STATUS_META.dispatched : STATUS_META.pending
    : fail > 0 ? STATUS_META.failed : limited > 0 ? STATUS_META.limited : STATUS_META.succeeded;
  const label = active
    ? meta.label
    : fail > 0 ? (ok > 0 ? `完成 ${ok} 失败 ${fail}` : `失败 ${fail}`)
    : limited > 0 ? `受限 ${limited}`
    : `已完成 ${ok}`;
  return { className: meta.className, label };
}

// 展开后的子任务轻行:状态徽章 + 标题/vid + 原站外链 + 摘要 + 单条重试/删除
function BatchSubRow({ task, onDelete, onRetryTask }: {
  task: CollectTask;
  onDelete: (id: number) => void;
  onRetryTask?: (task: CollectTask) => void;
}) {
  const m = STATUS_META[task.status] ?? STATUS_META.pending;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs', m.className)}>{m.label}</span>
      <span
        className="min-w-0 flex-1 truncate text-xs"
        title={task.title ?? `${PLATFORM_LABEL[task.source] ?? task.source} · ${task.source_vid}`}
      >
        {task.title || `${PLATFORM_LABEL[task.source] ?? task.source} · ${task.source_vid}`}
      </span>
      <ExtLink href={videoUrl(task.source, task.source_vid)} label="在原站打开视频" />
      <span className={cn('shrink-0 text-xs', task.status === 'failed' ? 'text-destructive' : task.status === 'limited' ? 'text-amber-400' : 'text-muted-foreground')}>
        {resultSummary(task)}
      </span>
      {retryable(task) && onRetryTask && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-primary"
          aria-label="重试子任务"
          title={TIP_RETRY}
          onClick={() => onRetryTask(task)}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-6 text-muted-foreground hover:text-destructive"
        aria-label="删除子任务"
        title={TIP_DELETE}
        onClick={() => onDelete(task.id)}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

export function BatchTaskCard({ items, onDelete, onDeleteBatch, onRetry, onRetryTask }: {
  items: CollectTask[];
  onDelete: (id: number) => void;
  onDeleteBatch: (batchId: string) => void;
  onRetry?: (tasks: CollectTask[]) => void;
  onRetryTask?: (task: CollectTask) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { className, label } = batchBadge(items);
  const ok = items.filter((t) => t.status === 'succeeded').length;
  const sources = [...new Set(items.map((t) => t.source))];
  // UP/博主归属:批量提交整批同一来源,取首个非空成员显示（全部为 null → 不显示该段）
  const creatorName = items.find((t) => t.creator_name)?.creator_name;
  const createdAt = Math.min(...items.map((t) => t.created_at));
  const batchId = items[0].batch_id!;
  const unretry = items.filter(retryable);
  const canRetry = unretry.length > 0 && !!onRetry;

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs font-medium', className)}>{label}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            批量采集 · {items.length} 个视频
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {sources.map((s) => PLATFORM_LABEL[s] ?? s).join('/')}{creatorName ? ` · UP/博主：${creatorName}` : ''}
            </span>
          </span>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {ok}/{items.length}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatTs(createdAt)}</span>
          {/* 批次聚焦入口：跳历史页按 batch_id 只看这一批（采集页只留最近 30 条,批次被挤出后唯一回看入口） */}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-primary"
            aria-label="在历史页查看整批"
            title="在历史页查看整批：按本批批次聚焦历史记录"
            onClick={() => navigate(`/history?batch_id=${encodeURIComponent(batchId)}`)}
          >
            <Focus className="size-4" />
          </Button>
          {canRetry && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-primary"
              aria-label={`重试 ${unretry.length} 个未成功`}
              title={`重试 ${unretry.length} 个未成功：失败/受限行重置回排队重跑（不新建任务记录）`}
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
            title={expanded ? '收起子任务：折叠本批成员明细' : '展开子任务：查看本批成员状态，可单条重试/删除'}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label="删除整个批次"
            title="删除整个批次：级联移除本批全部任务记录（含未完成），不影响已入库视频与字幕"
            onClick={() => onDeleteBatch(batchId)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        {expanded && (
          <div className="space-y-1 rounded-md bg-muted/30 p-2">
            {items.map((t) => (
              <BatchSubRow key={t.id} task={t} onDelete={onDelete} onRetryTask={onRetryTask} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
