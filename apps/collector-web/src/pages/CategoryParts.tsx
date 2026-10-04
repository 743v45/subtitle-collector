// 分类页私有部件（2026-10-05 自 CategoriesPage.tsx 抽出，偿还行数台账）：
// CategoryRenameDialog = 改名弹窗（回显旧名 → PATCH）；groupCategories = Q8b 前缀分组（纯展示）。
// 分组只发生在渲染层：存储、增删改、分类 id 引用全部不变。
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Category } from '@/api';

export function CategoryRenameDialog({ target, name, onName, renaming, onClose, onSave }: {
  target: Category | null;   // null = 关闭
  name: string;              // 输入框当前值（受控，父级持有）
  onName: (v: string) => void;
  renaming: boolean;         // PATCH 进行中（防连点 + 关闭拦截）
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => { if (!o && !renaming) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>改名</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rn">名称</Label>
          <Input
            id="rn"
            value={name}
            onChange={(e) => onName(e.target.value)}
            disabled={renaming}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={renaming}>
              取消
            </Button>
            <Button size="sm" onClick={onSave} disabled={renaming || !name.trim()}>
              {renaming ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// 无「-」的分类归入的组名（恒排最后）
const GROUPLESS = '其他';

export interface CategoryGroup {
  prefix: string;
  rows: Array<{ cat: Category; suffix: string }>; // suffix = 去掉前缀与 - 的展示名
}

// Q8b 前缀分组：「编程-前端」→ 组「编程」+ 展示名「前端」（按第一个 - 切，仅此一处切分）；
// 无 - 归「其他」组；名字以 - 开头/结尾等边界回落原名展示。组序=组内首条出现序，「其他」恒最后。
export function groupCategories(items: Category[]): CategoryGroup[] {
  const groups = new Map<string, Array<{ cat: Category; suffix: string }>>();
  for (const cat of items) {
    const i = cat.name.indexOf('-');
    const prefixed = i > 0;
    const prefix = prefixed ? cat.name.slice(0, i) : GROUPLESS;
    const suffix = prefixed ? (cat.name.slice(i + 1) || cat.name) : cat.name;
    const rows = groups.get(prefix) ?? [];
    rows.push({ cat, suffix });
    groups.set(prefix, rows);
  }
  return [...groups.entries()]
    .map(([prefix, rows]) => ({ prefix, rows }))
    .sort((a, b) => (a.prefix === GROUPLESS ? 1 : b.prefix === GROUPLESS ? -1 : 0));
}
