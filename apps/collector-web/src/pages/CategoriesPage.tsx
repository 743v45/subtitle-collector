import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { listCategories, createCategory, updateCategory, deleteCategory, type Category } from '@/api';

export function CategoriesPage() {
  const [scope, setScope] = useState<'agent' | 'human'>('agent');
  const [items, setItems] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);

  async function refresh() {
    try {
      setItems(await listCategories(scope));
    } catch {
      setItems([]);
    }
  }
  useEffect(() => { refresh(); }, [scope]);

  async function onCreate() {
    if (!name.trim()) return;
    await createCategory(name.trim(), scope);
    setName('');
    setOpen(false);
    refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">分类管理</h2>
        <span className="text-sm text-muted-foreground">共 {items.length} 条</span>
      </div>
      <div className="flex gap-2 items-center">
        {(['agent', 'human'] as const).map((s) => (
          <Button key={s} variant={s === scope ? 'default' : 'outline'} size="sm" onClick={() => setScope(s)}>
            {s === 'agent' ? 'Agent 分类' : '人工分类'}
          </Button>
        ))}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm">新建</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新建{scope === 'agent' ? ' Agent' : '人工'}分类</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="cn">名称</Label>
              <Input id="cn" value={name} onChange={(e) => setName(e.target.value)} />
              <Button onClick={onCreate}>保存</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>排序</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.name}</TableCell>
              <TableCell>{c.sort_order}</TableCell>
              <TableCell className="text-right space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const n = window.prompt('新名称', c.name);
                    if (n && n !== c.name) {
                      await updateCategory(c.id, { name: n });
                      refresh();
                    }
                  }}
                >
                  改名
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={async () => {
                    if (window.confirm(`删除「${c.name}」？关联 UP 主该分类将置空`)) {
                      await deleteCategory(c.id);
                      refresh();
                    }
                  }}
                >
                  删除
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {items.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">暂无分类</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
