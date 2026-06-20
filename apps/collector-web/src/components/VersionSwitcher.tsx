import type { VersionInfo } from '../types';
import { Button } from '@/components/ui/button';
const label = (v: VersionInfo) => v.origin === 'external' ? '外挂' : v.origin === 'asr' ? 'ASR' : '人工';
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
            // 选中用 B 站蓝；非选中用 outline variant（shadcn 默认样式，不内联）
            className={isSel ? 'bg-[#23ade5] text-white hover:bg-[#23ade5]' : 'text-muted-foreground'}
          >
            {label(v)} {v.is_default && '★'}
          </Button>
        );
      })}
    </div>
  );
}
