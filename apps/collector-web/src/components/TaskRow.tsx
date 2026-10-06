// ── 单任务卡 TaskRow（2026-10-05 从 TaskCards.tsx 拆出;采集页/历史页共用）──
// 标题行（展示单元改造 2026-10-05）：video_title 优先直出（截断省略）,裸 ID source_vid
// （抖音长数字可读性差）降级为标题下副行 font-mono code 小字;video_title/title 皆无（未入库）
// 回落 平台·ID 旧貌。行尾四个操作图标（重试/查看详情/展开预览/删除）均有中文 title 写明行为后果。
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { navigate } from '../router';
import { getVideo, getVersion } from '../api';
import { useAsync, type UseAsyncResult } from '@/lib/useAsync';
import { creatorUrl, videoUrl } from '../lib/externalLinks';
import { ExtLink } from '@/components/ExtLink';
import type { SubtitleLine } from '@/components/SubtitleView';
import { ChevronDown, ChevronUp, Eye, RotateCcw, Trash2 } from 'lucide-react';
import { PLATFORM_LABEL, STATUS_META, TIP_DELETE, TIP_RETRY, formatTs, resultSummary, retryable } from './taskCardShared';
import type { CollectTask, VideoDetail } from '../types';

// 标题行:video_title（分页行新字段）→ title（旧 JOIN 字段,批内成员仍走此列）回落 → 平台·ID（未入库旧貌）。
// 有标题时裸 ID 以 code 小字降级为副行——不占摘要行,截断时 title 悬停看全。
function TaskTitle({ task }: { task: CollectTask }) {
  const displayTitle = task.video_title ?? task.title;
  if (!displayTitle) {
    return (
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {PLATFORM_LABEL[task.source] ?? task.source} · {task.source_vid}
      </span>
    );
  }
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium" title={displayTitle}>{displayTitle}</span>
      <span className="block truncate font-mono text-xs text-muted-foreground" title={task.source_vid}>{task.source_vid}</span>
    </span>
  );
}

// 摘要行 UP 段:有 uid 外链跳空间,仅名回落纯文本（creators LEFT JOIN,未入库 null → 不渲染）
function CreatorSegment({ task }: { task: CollectTask }) {
  if (task.creator_name && task.creator_source_uid) {
    return (
      <> · <ExtLink href={creatorUrl(task.source, task.creator_source_uid)} label={`在原站打开 ${task.creator_name} 的空间`}>{task.creator_name}</ExtLink></>
    );
  }
  if (task.creator_name) return <> · {task.creator_name}</>;
  return null;
}

// 行尾操作图标组（重试/查看详情/展开预览/删除,全部带中文 title 写明行为后果）:
// 重试（failed/limited 且传入 onRetry）与详情/预览（succeeded）互斥,删除恒在。
function RowActions({ task, expanded, onToggleExpand, onDelete, onRetry }: {
  task: CollectTask;
  expanded: boolean;
  onToggleExpand: () => void;
  onDelete: (id: number) => void;
  onRetry?: (task: CollectTask) => void;
}) {
  const canOpen = task.status === 'succeeded'; // failed/limited 未入库不可跳;no_subtitle 的 succeeded 视频在库可跳
  const canRetry = retryable(task) && !!onRetry;
  return (
    <>
      {canRetry && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-primary"
          aria-label="重试采集"
          title={TIP_RETRY}
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
          title="查看视频详情：跳转详情页查看全部字幕轨与标签"
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
          title={expanded ? '收起预览：折叠就地字幕预览' : '展开预览：就地预览已入库字幕（前 8 行）'}
          onClick={onToggleExpand}
        >
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-destructive"
        aria-label="删除任务"
        title={TIP_DELETE}
        onClick={() => onDelete(task.id)}
      >
        <Trash2 className="size-4" />
      </Button>
    </>
  );
}

export function TaskRow({ task, onDelete, onRetry }: {
  task: CollectTask;
  onDelete: (id: number) => void;
  onRetry?: (task: CollectTask) => void;
}) {
  const meta = STATUS_META[task.status] ?? STATUS_META.pending;
  const [expanded, setExpanded] = useState(false);
  const canOpen = task.status === 'succeeded';
  const hasTitle = (task.video_title ?? task.title) != null;

  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs font-medium', meta.className)}>{meta.label}</span>
          <TaskTitle task={task} />
          {/* 原站外链：任何状态都可开原站页面（failed/未入库也有 BV 号可跳） */}
          <ExtLink href={videoUrl(task.source, task.source_vid)} label="在原站打开视频" />
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatTs(task.created_at)}</span>
          <RowActions
            task={task}
            expanded={expanded}
            onToggleExpand={() => setExpanded((e) => !e)}
            onDelete={onDelete}
            onRetry={onRetry}
          />
        </div>
        <div className={cn('text-sm', task.status === 'failed' ? 'text-destructive' : task.status === 'limited' ? 'text-amber-400' : 'text-muted-foreground')}>
          {/* 有标题时次行给 平台·UP名 + 摘要（裸 ID 已上移标题副行,不再重复）;无标题保持纯摘要 */}
          {hasTitle && (
            <span className="text-xs">
              {PLATFORM_LABEL[task.source] ?? task.source}
              <CreatorSegment task={task} />{' '}·{' '}
            </span>
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
      <div className="space-y-2 pt-1" aria-busy="true">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-16 w-full" />
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

// getVersion 响应形状（预览字幕请求的数据类型;useAsync 初始 null → 整体允许 null）
type VersionResponse = Awaited<ReturnType<typeof getVersion>> | null;

// 轨列表 chips:默认轨高亮;空轨给「仅元信息入库」空态
function PreviewTracks({ tracks, defTrackId }: { tracks: VideoDetail['tracks']; defTrackId: number | undefined }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tracks.length === 0 && <span className="text-xs text-muted-foreground">视频无字幕轨（仅元信息入库）</span>}
      {tracks.map((t) => (
        <span
          key={t.id}
          className={cn(
            'rounded px-1.5 py-0.5 text-xs',
            t.id === defTrackId ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          {t.lan_doc || t.lan || '?'} · {t.versions.length} 版
        </span>
      ))}
    </div>
  );
}

// 默认轨正文前几行:loading 骨架 / 错误 + 手动重试 / 正文（空体给空态）;无默认版不渲染
function PreviewSubtitle({ bodyQ, hasVersion }: { bodyQ: UseAsyncResult<VersionResponse>; hasVersion: boolean }) {
  const body = (bodyQ.data?.version?.payload?.body ?? []) as SubtitleLine[];
  if (!hasVersion) return null;
  return (
    <>
      {bodyQ.loading && <Skeleton className="h-24 w-full" />}
      {!bodyQ.loading && bodyQ.error && (
        <div className="text-xs text-destructive">
          字幕加载失败:{bodyQ.error}
          <button className="ml-1 cursor-pointer underline" onClick={bodyQ.reload}>重试</button>
        </div>
      )}
      {!bodyQ.loading && !bodyQ.error && (
        <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-muted/40 p-2">
          {body.slice(0, PREVIEW_LINES).map((l, i) => (
            <div key={i} className="flex gap-2 text-xs">
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {String(Math.floor(l.from / 60)).padStart(2, '0')}:{String(Math.floor(l.from % 60)).padStart(2, '0')}
              </span>
              <span className="min-w-0 break-words">{l.content}</span>
            </div>
          ))}
          {body.length === 0 && <span className="text-xs text-muted-foreground">（字幕体为空）</span>}
        </div>
      )}
    </>
  );
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
      <PreviewTracks tracks={tracks} defTrackId={defTrack?.id} />
      {/* 默认轨正文前几行 */}
      <PreviewSubtitle bodyQ={bodyQ} hasVersion={defVersion != null} />
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={openFull}>
        查看完整字幕
      </Button>
    </div>
  );
}
