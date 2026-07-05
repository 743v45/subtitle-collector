import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useAsync } from '@/lib/useAsync';
import { listCategories, createCategory, updateCategory, deleteCategory, type Category } from '@/api';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function CategoriesPage() {
  const toast = useToast();
  const [scope, setScope] = useState<'agent' | 'human'>('agent');
  const { data: items, loading, error, reload } = useAsync(() => listCategories(scope), [scope]);

  // 新建
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);

  // 改名（Dialog 替代 window.prompt）
  const [renameTarget, setRenameTarget] = useState<Category | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renaming, setRenaming] = useState(false);

  // 删除
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function onCreate() {
    const n = createName.trim();
    if (!n) return;
    setCreating(true);
    try {
      await createCategory(n, scope);
      toast('已新建', 'success');
      setCreateName('');
      setCreateOpen(false);
      reload();
    } catch (e: unknown) {
      toast(`新建失败：${errMsg(e)}`, 'error');
    } finally {
      setCreating(false);
    }
  }

  function openRename(c: Category) {
    setRenameTarget(c);
    setRenameName(c.name);
  }

  async function onRename() {
    if (!renameTarget) return;
    const n = renameName.trim();
    if (!n) return;
    if (n === renameTarget.name) { setRenameTarget(null); return; }
    setRenaming(true);
    try {
      await updateCategory(renameTarget.id, { name: n });
      toast('已改名', 'success');
      setRenameTarget(null);
      reload();
    } catch (e: unknown) {
      toast(`改名失败：${errMsg(e)}`, 'error');
    } finally {
      setRenaming(false);
    }
  }

  async function onDelete(c: Category) {
    if (!window.confirm(`删除「${c.name}」？关联 UP 主该分类将置空`)) return;
    setDeletingId(c.id);
    try {
      await deleteCategory(c.id);
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
        <h2 className="text-lg font-semibold">分类管理</h2>
        <span className="text-sm text-muted-foreground">共 {items?.length ?? 0} 条</span>
      </div>
      <div className="flex gap-2 items-center">
        {(['agent', 'human'] as const).map((s) => (
          <Button key={s} variant={s === scope ? 'default' : 'outline'} size="sm" onClick={() => setScope(s)}>
            {s === 'agent' ? 'Agent 分类' : '人工分类'}
          </Button>
        ))}
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild><Button size="sm">新建</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新建{scope === 'agent' ? ' Agent' : '人工'}分类</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="cn">名称</Label>
              <Input
                id="cn"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                disabled={creating}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)} disabled={creating}>
                  取消
                </Button>
                <Button size="sm" onClick={onCreate} disabled={creating || !createName.trim()}>
                  {creating ? '保存中…' : '保存'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <span>加载失败：{error}</span>
          <Button variant="outline" size="sm" onClick={reload}>重试</Button>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>排序</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && Array.from({ length: 3 }).map((_, i) => (
            <TableRow key={`sk-${i}`}>
              <TableCell><Skeleton className="h-4 w-32" /></TableCell>
              <TableCell><Skeleton className="h-4 w-8" /></TableCell>
              <TableCell className="text-right"><Skeleton className="ml-auto h-7 w-28" /></TableCell>
            </TableRow>
          ))}
          {!loading && items?.map((c) => {
            const rowBusy = deletingId === c.id || renameTarget?.id === c.id;
            return (
              <TableRow key={c.id}>
                <TableCell>{c.name}</TableCell>
                <TableCell>{c.sort_order}</TableCell>
                <TableCell className="text-right space-x-2">
                  <Button variant="outline" size="sm" disabled={rowBusy} onClick={() => openRename(c)}>
                    改名
                  </Button>
                  <Button variant="destructive" size="sm" disabled={rowBusy} onClick={() => onDelete(c)}>
                    {deletingId === c.id ? '删除中…' : '删除'}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          {!loading && !error && (items?.length ?? 0) === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">暂无分类</TableCell>
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
            <DialogTitle>改名</DialogTitle>
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
