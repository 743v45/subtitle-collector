// 创作者批量分类操作条（2026-10-05，Q6a）：勾选 >0 行时出现在表格上方。
// 两个槽位下拉均三态：— 不变 —（不传该键）/ — 清除 —（传 null）/ 具体分类（传 id）。
// 「不变」的表达：api.setCreatorsCategoryBatch 固定 JSON.stringify({ids, agent_category_id,
// human_category_id})，undefined 键会被丢弃（= server 保持原值），null = 清空该槽
// （契约见 api.test R5 / apiCreators.ts 注释；server 端 parseCategorySlot 三态对齐）。
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Category } from '@/api';

// 槽位选择三态：'keep' 不变 / 'clear' 清除 / 数字 = 分类 id
export type BatchSlotChoice = 'keep' | 'clear' | number;

// Radix Select 值必须是字符串，id/语义态各占一个哨兵前缀
export const KEEP = '__keep';
export const CLEAR = '__clear';

// UI 字符串值 → BatchSlotChoice
export function parseSlotChoice(v: string): BatchSlotChoice {
  if (v === KEEP) return 'keep';
  if (v === CLEAR) return 'clear';
  return Number(v);
}

// BatchSlotChoice → api 参数：keep → undefined（JSON.stringify 丢键=server 保持原值，槽位三态
// 契约见 apiCreators.setCreatorsCategoryBatch）
export function batchArg(c: BatchSlotChoice): number | null | undefined {
  return c === 'keep' ? undefined : c === 'clear' ? null : c;
}

function SlotSelect({ scope, value, cats, disabled, onChange }: {
  scope: 'agent' | 'human';
  value: BatchSlotChoice;
  cats: Category[] | null | undefined; // useAsync data 是 T | null，调用方直传
  disabled: boolean;
  onChange: (c: BatchSlotChoice) => void;
}) {
  const str = value === 'keep' ? KEEP : value === 'clear' ? CLEAR : String(value);
  return (
    <Select value={str} onValueChange={(v) => onChange(parseSlotChoice(v))} disabled={disabled}>
      <SelectTrigger className="w-40" aria-label={scope === 'agent' ? '设为 Agent 分类' : '设为人工分类'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={KEEP}>— 不变 —</SelectItem>
        <SelectItem value={CLEAR}>— 清除 —</SelectItem>
        {(cats ?? []).map((c) => (
          <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CreatorsBatchBar({
  count, cats, busy, agentChoice, humanChoice, onAgentChoice, onHumanChoice, onApply, onClearSelection,
}: {
  count: number;
  cats: Category[] | null | undefined;
  busy: boolean;
  agentChoice: BatchSlotChoice;
  humanChoice: BatchSlotChoice;
  onAgentChoice: (c: BatchSlotChoice) => void;
  onHumanChoice: (c: BatchSlotChoice) => void;
  onApply: () => void;
  onClearSelection: () => void;
}) {
  // 两槽位都「不变」＝没有要改的东西，应用无意义，禁点防误发
  const nothingToDo = agentChoice === 'keep' && humanChoice === 'keep';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <span className="text-sm font-medium tabular-nums">已选 {count} 个</span>
      <span className="text-xs text-muted-foreground">设为 Agent 分类</span>
      <SlotSelect scope="agent" value={agentChoice} cats={cats} disabled={busy} onChange={onAgentChoice} />
      <span className="text-xs text-muted-foreground">设为人工分类</span>
      <SlotSelect scope="human" value={humanChoice} cats={cats} disabled={busy} onChange={onHumanChoice} />
      <Button size="sm" onClick={onApply} disabled={busy || nothingToDo}>
        {busy ? '应用中…' : '应用'}
      </Button>
      <Button variant="outline" size="sm" onClick={onClearSelection} disabled={busy}>
        取消选择
      </Button>
      <span className="text-xs text-muted-foreground">— 清除 — 置空该槽位；— 不变 — 保持原值</span>
    </div>
  );
}
