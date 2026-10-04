// 视频列表批量打标/摘标（CLI tags apply/remove 的多选 web 形态，Phase 3）：
// 表头全选（仅当前页）+ 行勾选；选中>0 显示操作条——
//   打标：标签名 Input + 档位 Select（manual/batch/ai）→ POST /api/tags/apply；
//   摘标：标签名 Input + 档位 Select（含「全部档位」）→ POST /api/tags/remove，
//         选全部档位先弹确认框（删除不可撤销），指定档位直接删。
// 勾选不跨页保留：key 只存当前页 source:vid，VideoList 在 queryKey 变化时清空。
// 结构约束：勾选列/操作条都是子组件，VideoList 无条件挂载操作条（无选中且无结果时
// 渲染 null），主组件零新增分支、不抬其复杂度台账（TrackExportBar 同款手法）。
import { useState } from 'react';
import type { Dispatch, MouseEvent, SetStateAction } from 'react';
import { applyTags, removeTags } from '../api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TableCell, TableHead } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import type { VideoListItem } from '../types';

export type SelSetter = Dispatch<SetStateAction<Set<string>>>;

// 勾选主键：source:source_vid（与 tags apply/remove 的 TagTarget 一一对应）
function selKey(v: VideoListItem): string {
  return `${v.source}:${v.source_vid}`;
}

// 标签名解析：中英文逗号分隔、去首尾空白、去重（与详情页 onAddTags 同口径）
export function parseTagNames(input: string): string[] {
  return [...new Set(input.split(/[,，]/).map((s) => s.trim()).filter(Boolean))];
}

// 档位 → 中文（消息文案用；只收三个可写档——「全部」由调用点自行拼，不进本函数）
function scopeLabel(s: 'manual' | 'batch' | 'ai'): string {
  return s === 'manual' ? '手动' : s === 'batch' ? '批量' : 'AI';
}

// 表头全选框（仅当前页）：半选态走 indeterminate；勾选集整体换入/换出
export function BulkCheckHead({ sel, setSel, items }: { sel: Set<string>; setSel: SelSetter; items: VideoListItem[] }) {
  const keys = items.map(selKey);
  const all = keys.length > 0 && keys.every((k) => sel.has(k));
  const some = keys.some((k) => sel.has(k));
  return (
    <TableHead className="w-8 pl-2">
      <input
        type="checkbox"
        aria-label="全选当前页"
        checked={all}
        ref={(el) => {
          if (el) el.indeterminate = !all && some;
        }}
        onChange={() => setSel(all ? new Set<string>() : new Set(keys))}
        className="size-4 cursor-pointer accent-primary"
      />
    </TableHead>
  );
}

// 行勾选框：点击在单元格上截停（stopPropagation），不触发整行进详情的 onClick
export function BulkCheckCell({ v, sel, setSel }: { v: VideoListItem; sel: Set<string>; setSel: SelSetter }) {
  const key = selKey(v);
  const toggle = (ev: MouseEvent) => {
    ev.stopPropagation();
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <TableCell className="w-8 pl-2" onClick={toggle}>
      <input
        type="checkbox"
        aria-label={`选择 ${v.title}`}
        checked={sel.has(key)}
        readOnly
        className="size-4 cursor-pointer accent-primary"
      />
    </TableCell>
  );
}

// 批量操作条：已选 N ｜ 打标 [Input][档位][按钮] ｜ 摘标 [Input][档位含全部][按钮] ｜ 取消选择
export function VideoBulkBar({ items, sel, setSel }: { items: VideoListItem[]; sel: Set<string>; setSel: SelSetter }) {
  const toast = useToast();
  const selected = items.filter((v) => sel.has(selKey(v)));
  const [tagNames, setTagNames] = useState('');
  const [tagScope, setTagScope] = useState<'manual' | 'batch' | 'ai'>('manual');
  const [untagNames, setUntagNames] = useState('');
  const [untagScope, setUntagScope] = useState<'manual' | 'batch' | 'ai' | 'all'>('manual');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // 无选中且无上次操作结果 → 不渲染（VideoList 无条件挂载，靠这里隐身）
  if (selected.length === 0 && !msg) return null;

  const targets = selected.map((v) => ({ source: v.source, source_vid: v.source_vid }));
  const tagReady = parseTagNames(tagNames).length > 0;
  const untagReady = parseTagNames(untagNames).length > 0;

  // 打标：applyTags 成功 → 结果提示 + 清空选择（提示保留在操作条上供阅读）
  async function doApply() {
    const names = parseTagNames(tagNames);
    if (names.length === 0 || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await applyTags({ items: targets, names, scope: tagScope });
      const text = `已为 ${targets.length} 个视频打标 ${names.length} 个标签（${scopeLabel(tagScope)}档）：新增 ${r.inserted} 条关联，缺失 ${r.missing} 个`;
      setMsg({ kind: 'success', text });
      toast(`打标完成：新增 ${r.inserted} 条关联`, 'success');
      setSel(new Set());
    } catch (e: unknown) {
      const text = e instanceof Error ? e.message : String(e);
      setMsg({ kind: 'error', text: `打标失败：${text}` });
      toast(`打标失败：${text}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  // 摘标入口：全部档位先确认（不可撤销），指定档位直接删
  function doRemove() {
    if (!untagReady || busy) return;
    if (untagScope === 'all') {
      setConfirmOpen(true);
      return;
    }
    void runRemove(untagScope);
  }

  // 摘标执行：scope=undefined 时整个省略 scope 键（removeTags 契约：省略=删全部档位）
  async function runRemove(scope?: 'manual' | 'batch' | 'ai') {
    const names = parseTagNames(untagNames);
    setBusy(true);
    setMsg(null);
    try {
      const body = scope ? { items: targets, names, scope } : { items: targets, names };
      const r = await removeTags(body);
      const text = `已为 ${targets.length} 个视频摘除 ${names.length} 个标签（${scope ? scopeLabel(scope) : '全部'}档位）：删除 ${r.removed} 条关联，缺失 ${r.missing} 个`;
      setMsg({ kind: 'success', text });
      toast(`摘标完成：删除 ${r.removed} 条关联`, 'success');
      setSel(new Set());
    } catch (e: unknown) {
      const text = e instanceof Error ? e.message : String(e);
      setMsg({ kind: 'error', text: `摘标失败：${text}` });
      toast(`摘标失败：${text}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  const cancel = () => {
    setSel(new Set());
    setMsg(null);
  };

  return (
    <div className="rounded-md border bg-muted/30 p-3" data-testid="video-bulk-bar">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">已选 <span className="tabular-nums">{selected.length}</span></span>
        <span className="text-muted-foreground">|</span>
        {selected.length > 0 && (
          <>
            <Input
              className="h-8 w-44"
              aria-label="批量打标标签名"
              placeholder="标签名，逗号分隔"
              value={tagNames}
              disabled={busy}
              onChange={(e) => setTagNames(e.target.value)}
            />
            <Select value={tagScope} onValueChange={(v) => setTagScope(v as 'manual' | 'batch' | 'ai')}>
              <SelectTrigger className="h-8 w-24" aria-label="打标档位">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">手动档</SelectItem>
                <SelectItem value="batch">批量档</SelectItem>
                <SelectItem value="ai">AI 档</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" className="h-8" disabled={busy || !tagReady} onClick={() => void doApply()}>
              {busy ? '处理中…' : '打标'}
            </Button>
            <span className="text-muted-foreground">|</span>
            <Input
              className="h-8 w-44"
              aria-label="批量摘标标签名"
              placeholder="标签名，逗号分隔"
              value={untagNames}
              disabled={busy}
              onChange={(e) => setUntagNames(e.target.value)}
            />
            <Select value={untagScope} onValueChange={(v) => setUntagScope(v as 'manual' | 'batch' | 'ai' | 'all')}>
              <SelectTrigger className="h-8 w-28" aria-label="摘标档位">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">手动档</SelectItem>
                <SelectItem value="batch">批量档</SelectItem>
                <SelectItem value="ai">AI 档</SelectItem>
                <SelectItem value="all">全部档位</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-8" disabled={busy || !untagReady} onClick={doRemove}>
              摘标
            </Button>
            <span className="text-muted-foreground">|</span>
            <Button size="sm" variant="ghost" className="h-8" onClick={cancel}>
              取消选择
            </Button>
          </>
        )}
        {msg && (
          <span className={msg.kind === 'error' ? 'text-destructive' : 'text-emerald-600'} role="status">
            {msg.text}
          </span>
        )}
      </div>
      {/* 全部档位摘标确认框：删除多视频 × 多标签的全档位关联不可撤销，强确认一次 */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除全部档位关联</DialogTitle>
            <DialogDescription>
              将删除 {targets.length} 个视频的这些标签的【全部档位】关联，不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              再想想
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
                void runRemove();
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
