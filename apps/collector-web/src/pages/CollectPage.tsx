import { useEffect, useRef, useState } from 'react';
import { createCollectTask, deleteCollectTask, listCollectTasks, getVideo, getVersion, getStatsOverview } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useAsync } from '@/lib/useAsync';
import { navigate } from '../router';
import { ChevronDown, ChevronUp, Eye, Loader2, Send, Trash2 } from 'lucide-react';
import type { CollectTask, CollectTaskStatus, VideoDetail } from '../types';
import type { SubtitleLine } from '@/components/SubtitleView';

const REFRESH_MS = 2000;
// 就地预览正文行数（点击「查看完整字幕」进详情看全部）
const PREVIEW_LINES = 8;

// 任务状态徽章文案（pending 细分「等待扩展上线/排队中」由客户端数区分,这里统一显示）
const STATUS_META: Record<CollectTaskStatus, { label: string; className: string }> = {
  pending: { label: '排队中', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  dispatched: { label: '采集中', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  succeeded: { label: '已完成', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  failed: { label: '失败', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
};

const PLATFORM_LABEL: Record<string, string> = { bilibili: 'B站', youtube: 'YouTube' };

function formatTs(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// 扩展回执 result（JSON 字符串）→ 摘要文案
function resultSummary(task: CollectTask): string {
  if (task.status === 'failed') return task.error ?? '采集失败';
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
        库内 <span className="font-medium tabular-nums text-foreground">{data.videos.toLocaleString()}</span> 视频
        · <span className="font-medium tabular-nums text-foreground">{data.tracks.toLocaleString()}</span> 字幕轨
      </span>
      <span>
        今日 +<span className="font-medium tabular-nums text-foreground">{data.today_videos.toLocaleString()}</span>
      </span>
    </button>
  );
}

// ── 就地预览：succeeded 任务展开看入库结果（轨列表 + 默认轨正文前几行）──
function TaskPreview({ task }: { task: CollectTask }) {
  const detailQ = useAsync(() => getVideo(task.source, task.source_vid), [task.source, task.source_vid]);

  if (detailQ.loading) {
    return (
      <div className="space-y-2 pt-1">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (detailQ.error) {
    return (
      <div className="pt-1 text-sm text-destructive">
        预览加载失败：{detailQ.error}
      </div>
    );
  }
  return <TaskPreviewBody task={task} detail={detailQ.data} onReload={detailQ.reload} />;
}

function TaskPreviewBody({ task, detail, onReload }: { task: CollectTask; detail: VideoDetail | null; onReload: () => void }) {
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
          {bodyQ.loading && <Skeleton className="h-24 w-full" />}
          {!bodyQ.loading && bodyQ.error && (
            <div className="text-xs text-destructive">
              字幕加载失败：{bodyQ.error}
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

function TaskRow({ task, onDelete }: { task: CollectTask; onDelete: (id: number) => void }) {
  const meta = STATUS_META[task.status] ?? STATUS_META.pending;
  const [expanded, setExpanded] = useState(false);
  const canOpen = task.status === 'succeeded'; // failed 未入库不可跳;no_subtitle 的 succeeded 视频在库可跳

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
        <div className={cn('text-sm', task.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
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

export function CollectPage() {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CollectTask[]>([]);
  const aliveRef = useRef(true);

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
      .then(({ items }) => { if (aliveRef.current) setTasks(items); })
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

  // 删除任务：成功后本地立即移除（不等 2s 轮询）;失败静默（行还在,轮询自然恢复）
  const remove = async (id: number) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try {
      await deleteCollectTask(id);
    } catch {
      refresh();
    }
  };

  const hasActive = tasks.some((t) => t.status === 'pending' || t.status === 'dispatched');

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

      {/* 任务列表（2s 轮询,有进行中任务时提示） */}
      <div className="space-y-2">
        {hasActive && (
          <div className="text-xs text-muted-foreground animate-pulse">
            有任务进行中,每 {REFRESH_MS / 1000}s 自动刷新…
          </div>
        )}
        {tasks.map((t) => <TaskRow key={t.id} task={t} onDelete={(id) => { void remove(id); }} />)}
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
