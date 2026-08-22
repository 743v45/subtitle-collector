import type { VersionInfo } from '../types';
import { Button } from '@/components/ui/button';
const label = (v: VersionInfo) => v.origin === 'external' ? '外挂' : v.origin === 'asr' ? 'ASR' : '人工';
// 选中态用 primary token（shadcn default variant），不内联平台品牌色。
export function VersionSwitcher({ versions, selected, onSelect }: { versions: VersionInfo[]; selected: number | null; onSelect: (id: number) => void; }) {
  if (versions.length <= 1) return null;
  return (
    <div className="my-2 flex flex-wrap gap-1.5">
      {versions.map((v) => {
        const isSel = v.id === selected;
        return (
          <Button
            key={v.id}
            variant={isSel ? 'default' : 'outline'}
            size="sm"
            onClick={() => onSelect(v.id)}
            className={isSel ? undefined : 'text-muted-foreground'}
          >
            {label(v)}{v.is_default && '（默认）'}
          </Button>
        );
      })}
    </div>
  );
}
