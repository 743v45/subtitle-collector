// 创作者分类页：CRUD（新建/改名/删除）+ Q8b 前缀分组展示（2026-10-05）。
// 分组：分类名形如「编程-前端」按第一个 - 前缀分组，组头=前缀、组内=去前缀后缀；无 - 归「其他」（恒最后）。
// 纯展示层分组——存储/增删改/分类 id 引用不变（改名弹窗与分组部件见 CategoryParts.tsx）。
import { Fragment, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useAsync } from '@/lib/useAsync';
import { navigate } from '../router';
import { listCategories, createCategory, updateCategory, deleteCategory, type Category } from '@/api';
import { CategoryRenameDialog, groupCategories } from './CategoryParts';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function CategoriesPage() {
  const toast = useToast();
  const { data: items, loading, error, reload } = useAsync(() => listCategories(), []);

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
      await createCategory(n);
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
    if (!window.confirm(`删除「${c.name}」？${c.creator_count > 0 ? `${c.creator_count} 个创作者的该分类将置空` : '无创作者关联'}`)) return;
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

  const groups = items ? groupCategories(items) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">创作者分类</h2>
          {/* 分类只作用于创作者（打在 UP 主/频道上，视频与字幕不挂分类）；一套共享值域，Agent 与人工在 UP 主两个槽位分别打标 */}
          <p className="mt-1 text-sm text-muted-foreground">只针对创作者：Agent 与人工共用同一套分类，在 UP 主页面分开选</p>
        </div>
        <span className="text-sm text-muted-foreground">共 {items?.length ?? 0} 条</span>
      </div>
      <div className="flex gap-2 items-center">
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild><Button size="sm">新建</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新建分类</DialogTitle>
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

      <div className="overflow-hidden rounded-md border" aria-busy={loading || undefined}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>名称</TableHead>
              <TableHead className="text-right">创作者</TableHead>
              <TableHead className="text-right">排序</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && Array.from({ length: 3 }).map((_, i) => (
              <TableRow key={`sk-${i}`}>
                <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                <TableCell><Skeleton className="ml-auto h-4 w-8" /></TableCell>
                <TableCell><Skeleton className="ml-auto h-4 w-8" /></TableCell>
                <TableCell className="text-right"><Skeleton className="ml-auto h-7 w-28" /></TableCell>
              </TableRow>
            ))}
            {!loading && groups.map((g) => (
              <Fragment key={g.prefix}>
                {/* 组头行：前缀（「其他」组 = 无 - 前缀的分类） */}
                <TableRow className="hover:bg-transparent bg-muted/50">
                  <TableCell colSpan={4} className="py-1.5 text-xs font-semibold text-muted-foreground">
                    {g.prefix}（{g.rows.length}）
                  </TableCell>
                </TableRow>
                {g.rows.map(({ cat, suffix }) => {
                  const rowBusy = deletingId === cat.id || renameTarget?.id === cat.id;
                  return (
                    <TableRow key={cat.id}>
                      {/* 展示后缀、title 保留全名（悬停可见真名；无 - 后缀=全名不加 title） */}
                      <TableCell className="font-medium" title={cat.name !== suffix ? cat.name : undefined}>{suffix}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {/* 数量即该分类下创作者数（两槽位任一指向）；点击跳创作者列表按本分类过滤（不带 scope——两槽位任一命中） */}
                        {cat.creator_count > 0 ? (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto p-0"
                            title={`查看「${cat.name}」下的 ${cat.creator_count} 个创作者`}
                            onClick={() => navigate(`/creators?cat=${encodeURIComponent(cat.name)}`)}
                          >
                            {cat.creator_count}
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{cat.sort_order}</TableCell>
                      <TableCell className="space-x-2 text-right">
                        <Button variant="outline" size="sm" disabled={rowBusy} onClick={() => openRename(cat)}>
                          改名
                        </Button>
                        <Button variant="destructive" size="sm" disabled={rowBusy} onClick={() => onDelete(cat)}>
                          {deletingId === cat.id ? '删除中…' : '删除'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </Fragment>
            ))}
            {!loading && !error && (items?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center">
                  <div className="text-sm text-muted-foreground">暂无创作者分类——点右上「新建」创建第一个分类</div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <CategoryRenameDialog
        target={renameTarget}
        name={renameName}
        onName={setRenameName}
        renaming={renaming}
        onClose={() => setRenameTarget(null)}
        onSave={onRename}
      />
    </div>
  );
}
