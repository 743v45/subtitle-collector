import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface SubtitleLine { from: number; to: number; content: string; }
export function SubtitleView({ body }: { body: SubtitleLine[] }) {
  const fmt = (sec: number) => { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; };
  const copy = () => { navigator.clipboard.writeText(body.map(l => l.content).join('\n')); };
  return (
    <div>
      <Button variant="outline" size="sm" onClick={copy} className="mb-2">复制全文</Button>
      <div className="max-h-[400px] overflow-y-auto rounded border border-border p-2">
        {body.map((l, i) => (
          <div key={i} className="flex gap-3 py-0.5 leading-relaxed">
            <span className={cn('whitespace-nowrap text-xs text-muted-foreground tabular-nums')}>{fmt(l.from)} → {fmt(l.to)}</span>
            <span>{l.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
