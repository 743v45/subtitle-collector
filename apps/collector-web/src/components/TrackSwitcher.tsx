import type { TrackInfo } from '../types';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// 轨切换器用 shadcn Tabs（受控）；选中态/胶囊样式由 Tabs variant 接管，不写内联样式。
export function TrackSwitcher({ tracks, selected, onSelect }: { tracks: TrackInfo[]; selected: number | null; onSelect: (id: number) => void; }) {
  return (
    <div className="my-3">
      <Tabs value={selected != null ? String(selected) : ''} onValueChange={(v) => onSelect(Number(v))}>
        <TabsList className="flex flex-wrap h-auto gap-2 bg-transparent p-0">
          {tracks.map((t) => (
            <TabsTrigger
              key={t.id}
              value={String(t.id)}
              className="rounded-full data-[state=active]:bg-[#fb7299] data-[state=active]:text-white data-[state=active]:font-semibold"
            >
              {t.lan_doc || t.lan || '?'} {t.is_default && '(默认)'}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
