import type { TrackInfo } from '../types';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// 轨切换器用 shadcn Tabs（受控）；选中态由 primary token 接管（平台品牌色只用于平台图标）。
export function TrackSwitcher({ tracks, selected, onSelect }: { tracks: TrackInfo[]; selected: number | null; onSelect: (id: number) => void; }) {
  return (
    <div className="my-3">
      <Tabs value={selected != null ? String(selected) : ''} onValueChange={(v) => onSelect(Number(v))}>
        <TabsList className="flex flex-wrap h-auto gap-1.5 bg-transparent p-0">
          {tracks.map((t) => (
            <TabsTrigger
              key={t.id}
              value={String(t.id)}
              className="rounded-full border border-input bg-background text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:font-medium"
            >
              {t.lan_doc || t.lan || '?'}{t.is_default && '（默认）'}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
