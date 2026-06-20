import { useEffect, useState } from 'react';
import { listVideos } from '../api';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export function VideoList({ onOpen }: { onOpen: (source: string, sourceVid: string) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      listVideos(q).then(r => { setItems(r.items); setTotal(r.total); });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="space-y-3 p-4">
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索标题/创作者" className="mb-3" />
      <div className="text-sm text-muted-foreground">共 {total} 条</div>
      <div className="space-y-2">
        {items.map(v => (
          <Card
            key={v.id}
            onClick={() => onOpen(v.source, v.source_vid)}
            // 整卡可点：加 cursor-pointer + hover 态，样式全走 shadcn Card + Tailwind 工具类
            className="cursor-pointer transition-colors hover:bg-accent"
          >
            <CardHeader className="p-4">
              <CardTitle className="text-base font-medium">{v.title}</CardTitle>
              <CardDescription className="text-xs">
                {v.creator_name ?? '-'} · {v.track_count} 轨 · {new Date(v.first_seen_at).toLocaleString()}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
