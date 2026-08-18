import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';
import { GripVertical } from 'lucide-react';
import { listTags, renameTag, deleteTag, getTagPriority, putTagPriority, type TagItem } from '@/api';
import { TAG_SOURCE_DOT, TAG_SOURCE_LABEL, type TagSource } from '@/lib/tagSources';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

const DEFAULT_PRIORITY: TagSource[] = ['manual', 'batch', 'bili', 'ai'];

// 标签库档位过滤（bili 档来自视频自带、无独立实体，不在过滤组）
type LibraryScope = '' | 'manual' | 'batch' | 'ai';
const SCOPES: { value: LibraryScope; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'manual', label: '手动' },
  { value: 'batch', label: '批量' },
  { value: 'ai', label: 'AI' },
];

export function TagsPage() {
  const toast = useToast();
  const [scope, setScope] = useState<LibraryScope>('');
  const { data: items, loading, error, reload } = useAsync(
    () => listTags(scope ? { source: scope } : {}),
    [scope],
  );

  // ── 展示优先级（拖拽 / 上下移本地排序，点「保存排序」整体 PUT）──
  const priorityQ = useAsync(() => getTagPriority(), []);
  const [order, setOrder] = useState<TagSource[] | null>(null); // 本地编辑态；null = 未改动
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const current = order ?? priorityQ.data ?? DEFAULT_PRIORITY;

  function moveItem(from: number, to: number) {
    if (from === to || to < 0 || to >= current.length) return;
    const next = [...current];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    setOrder(next);
  }

  async function saveOrder() {
    setSavingOrder(true);
    try {
      await putTagPriority(current);
      setOrder(null); // 编辑态复位，以服务端返回为准
      priorityQ.reload();
      toast('已保存排序', 'success');
    } catch (e: unknown) {
      toast(`保存排序失败：${errMsg(e)}`, 'error');
    } finally {
      setSavingOrder(false);
    }
  }

  // ── 改名（Dialog，撞名服务端 409）──
  const [renameTarget, setRenameTarget] = useState<TagItem | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renaming, setRenaming] = useState(false);

  function openRename(t: TagItem) {
    setRenameTarget(t);
    setRenameName(t.name);
  }

  async function onRename() {
    if (!renameTarget) return;
    const n = renameName.trim();
    if (!n) return;
    if (n === renameTarget.name) { setRenameTarget(null); return; }
    setRenaming(true);
    try {
      await renameTag(renameTarget.id, n);
      toast('已改名', 'success');
      setRenameTarget(null);
      reload();
    } catch (e: unknown) {
      toast(`改名失败：${errMsg(e)}`, 'error');
    } finally {
      setRenaming(false);
    }
  }

  // ── 删除（解除该标签与全部视频的关联）──
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function onDelete(t: TagItem) {
    if (!window.confirm(`删除标签「${t.name}」？将解除该标签与全部视频的关联`)) return;
    setDeletingId(t.id);
    try {
      await deleteTag(t.id);
      toast('已删除', 'success');
      reload();
    } catch (e: unknown) {
      toast(`删除失败：${errMsg(e)}`, 'error');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">标签管理</h2>
        <span className="text-sm text-muted-foreground">共 {items?.length ?? 0} 条</span>
      </div>

      {/* 展示优先级：同名标签跨档位冲突时靠前者胜出（列表页 winner 去重） */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">展示优先级</CardTitle>
          <CardDescription>
            同名标签跨档位冲突时，靠前者优先展示；拖动行或用上移/下移调整，保存后生效
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {current.map((s, i) => (
            <div
              key={s}
              draggable
              onDragStart={() => setDragFrom(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragFrom != null) moveItem(dragFrom, i); setDragFrom(null); }}
              onDragEnd={() => setDragFrom(null)}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
                dragFrom === i ? 'opacity-50' : 'bg-card',
              )}
            >
              <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />
              <span className={cn('h-2 w-2 shrink-0 rounded-full', TAG_SOURCE_DOT[s])} />
              <span className="font-medium">{TAG_SOURCE_LABEL[s]}</span>
              {s === 'bili' && (
                <span className="text-xs text-muted-foreground">来自视频自带，不可编辑</span>
              )}
              <span className="ml-auto flex gap-1">
                <Button variant="outline" size="sm" disabled={i === 0} onClick={() => moveItem(i, i - 1)}>
                  上移
                </Button>
                <Button variant="outline" size="sm" disabled={i === current.length - 1} onClick={() => moveItem(i, i + 1)}>
                  下移
                </Button>
              </span>
            </div>
          ))}
          <div className="flex justify-end pt-1">
            <Button size="sm" disabled={order == null || savingOrder} onClick={saveOrder}>
              {savingOrder ? '保存中…' : '保存排序'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 档位过滤 */}
      <div className="flex gap-2 items-center">
        {SCOPES.map((s) => (
          <Button
            key={s.value || 'all'}
            variant={scope === s.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => setScope(s.value)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <span>加载失败：{error}</span>
          <Button variant="outline" size="sm" onClick={reload}>重试</Button>
        </div>
      )}

      {/* 标签库 */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>手动</TableHead>
            <TableHead>批量</TableHead>
            <TableHead>AI</TableHead>
            <TableHead>总计</TableHead>
            <TableHead>创建时间</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && Array.from({ length: 3 }).map((_, i) => (
            <TableRow key={`sk-${i}`}>
              {Array.from({ length: 7 }).map((_, j) => (
                <TableCell key={j}><Skeleton className="h-4 w-16" /></TableCell>
              ))}
            </TableRow>
          ))}
          {!loading && items?.map((t) => {
            const rowBusy = deletingId === t.id || renameTarget?.id === t.id;
            return (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="tabular-nums">{t.counts.manual}</TableCell>
                <TableCell className="tabular-nums">{t.counts.batch}</TableCell>
                <TableCell className="tabular-nums">{t.counts.ai}</TableCell>
                <TableCell className="tabular-nums">{t.counts.total}</TableCell>
                <TableCell className="text-muted-foreground">{fmtTime(t.created_at)}</TableCell>
                <TableCell className="text-right space-x-2">
                  <Button variant="outline" size="sm" disabled={rowBusy} onClick={() => openRename(t)}>
                    改名
                  </Button>
                  <Button variant="destructive" size="sm" disabled={rowBusy} onClick={() => onDelete(t)}>
                    {deletingId === t.id ? '删除中…' : '删除'}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          {!loading && !error && (items?.length ?? 0) === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">暂无标签</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* 改名 Dialog（替代 window.prompt） */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(o) => { if (!o && !renaming) setRenameTarget(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>标签改名</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rn">名称</Label>
            <Input
              id="rn"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              disabled={renaming}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRenameTarget(null)}
                disabled={renaming}
              >
                取消
              </Button>
              <Button size="sm" onClick={onRename} disabled={renaming || !renameName.trim()}>
                {renaming ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
