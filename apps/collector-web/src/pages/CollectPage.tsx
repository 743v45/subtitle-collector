import { useEffect, useRef, useState } from 'react';
import { createCollectTask, deleteCollectTask, listCollectTasks } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Loader2, Send, Trash2 } from 'lucide-react';
import type { CollectTask, CollectTaskStatus } from '../types';

const REFRESH_MS = 2000;

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
    if (typeof r.captured === 'number') return `采到 ${r.captured} 轨字幕`;
  } catch { /* 非预期结构忽略 */ }
  return '';
}

function TaskRow({ task, onDelete }: { task: CollectTask; onDelete: (id: number) => void }) {
  const meta = STATUS_META[task.status] ?? STATUS_META.pending;
  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', meta.className)}>{meta.label}</span>
          <span className="text-xs text-muted-foreground">{PLATFORM_LABEL[task.source] ?? task.source} · {task.source_vid}</span>
          <span className="ml-auto text-xs text-muted-foreground">{formatTs(task.created_at)}</span>
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
          {resultSummary(task)}
        </div>
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
