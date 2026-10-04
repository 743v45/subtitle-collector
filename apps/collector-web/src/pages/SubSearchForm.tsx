// 字幕检索表单（SubSearchPage 的表单区）：受控展示 + 状态回传。
// 检索是显式动作（按钮/回车），提交逻辑（trim 守卫 + 写 URL）留在 SubSearchPage，本组件只回传表单状态。
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PlatformSelect } from '@/components/PlatformSelect';
import { RotateCcw, Search } from 'lucide-react';
import type { SubSearchQueryState } from '../subSearchFilterUrl';

export function SubSearchForm({ value, onChange, onSubmit, onReset }: {
  value: SubSearchQueryState;
  onChange: (next: SubSearchQueryState) => void;
  onSubmit: () => void;
  onReset: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[220px] flex-1"
          placeholder="检索字幕内容（必填）"
          aria-label="检索关键词"
          value={value.kw}
          onChange={(e) => onChange({ ...value, kw: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
        />
        <Button disabled={!value.kw.trim()} onClick={onSubmit}>
          <Search className="h-4 w-4" />
          搜索
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={value.regex}
            onChange={(e) => onChange({ ...value, regex: e.target.checked })}
            className="size-3.5 accent-primary"
          />
          正则模式
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={value.caseSensitive}
            onChange={(e) => onChange({ ...value, caseSensitive: e.target.checked })}
            className="size-3.5 accent-primary"
          />
          区分大小写
        </label>
        <label className="flex items-center gap-1.5">
          上下文
          <Input
            className="h-8 w-20"
            type="number"
            min={0}
            aria-label="上下文秒数"
            value={value.ctx}
            onChange={(e) => onChange({ ...value, ctx: e.target.value })}
          />
          秒
        </label>
        <PlatformSelect value={value.source || null} onChange={(v) => onChange({ ...value, source: v ?? '' })} />
        <Input
          className="w-[160px]"
          placeholder="创作者名（可选）"
          aria-label="创作者名"
          value={value.creator}
          onChange={(e) => onChange({ ...value, creator: e.target.value })}
        />
        <Button variant="ghost" size="sm" onClick={onReset}>
          <RotateCcw className="h-4 w-4" />
          重置
        </Button>
      </div>
    </div>
  );
}
