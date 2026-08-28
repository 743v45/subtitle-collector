import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Check, ChevronDown } from 'lucide-react';

// ── 多标签下拉多选（手写受控面板：button + absolute 定位 div，不新增依赖）──
// 视频页次要筛选用（2026-08-29 从 VideoList 抽出共享件）。视觉对齐 select.tsx
// （border rounded-md bg-popover shadow-md）；面板外点击关闭；
// 勾选即回调 onChange（父组件写 URL query），选项带计数。
export function TagMultiSelect({ options, selected, onChange }: {
  options: { key: string; count: number }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 面板外 mousedown → 关闭（mousedown 而非 click，避免面板内点击冒泡时序问题）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = (name: string) => {
    onChange(selected.includes(name) ? selected.filter((s) => s !== name) : [...selected, name]);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-9 min-w-[140px] cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-ring',
          open && 'ring-1 ring-ring',
        )}
      >
        <span className={cn('truncate', selected.length === 0 && 'text-muted-foreground')}>
          {selected.length > 0 ? `标签（${selected.length}）` : '标签'}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 opacity-50 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {options.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">暂无标签</div>
          )}
          {options.map((t) => {
            const checked = selected.includes(t.key);
            return (
              <button
                key={t.key}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => toggle(t.key)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors duration-150 hover:bg-accent focus:bg-accent"
              >
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border',
                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                  )}
                >
                  {checked && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate" title={t.key}>{t.key}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t.count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
