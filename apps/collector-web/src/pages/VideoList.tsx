import { useEffect, useRef, useState } from 'react';
import { listVideos } from '../api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import type { VideoListItem } from '../types';

const PAGE_SIZE = 20;

export function VideoList({ onOpen }: { onOpen: (source: string, sourceVid: string) => void }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<VideoListItem[]>([]);
  const [total, setTotal] = useState(0);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    const t = setTimeout(() => {
      listVideos(q, page, PAGE_SIZE)
        .then(r => { if (seq === seqRef.current) { setItems(r.items); setTotal(r.total); } })
        .catch(() => { if (seq === seqRef.current) { setItems([]); setTotal(0); } });
    }, 300);
    return () => clearTimeout(t);
  }, [q, page]);

  const onQChange = (v: string) => { setQ(v); setPage(1); };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-3 p-4">
      <Input value={q} onChange={e => onQChange(e.target.value)} placeholder="搜索标题/创作者" className="mb-3" />
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <div>共 {total} 条 · 第 {page}/{totalPages} 页</div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>上一页</Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages || total === 0} onClick={() => setPage(p => p + 1)}>下一页</Button>
        </div>
      </div>
      <div className="space-y-2">
        {items.map(v => (
          <Card
            key={v.id}
            onClick={() => onOpen(v.source, v.source_vid)}
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
        {items.length === 0 && <div className="text-sm text-muted-foreground">暂无数据</div>}
      </div>
    </div>
  );
}
