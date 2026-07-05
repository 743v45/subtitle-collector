import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listCategories, listCreators, setCreatorCategory, type Category, type CreatorListItem } from '@/api';

const PAGE_SIZE = 20;

export function CreatorsPage() {
  const [q, setQ] = useState('');
  const [catFilter, setCatFilter] = useState<string>('');
  const [humanCats, setHumanCats] = useState<Category[]>([]);
  const [items, setItems] = useState<CreatorListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const seqRef = useRef(0);

  useEffect(() => {
    listCategories('human').then(setHumanCats).catch(() => setHumanCats([]));
  }, []);

  useEffect(() => {
    const seq = ++seqRef.current;
    const t = setTimeout(() => {
      listCreators({
        q: q || undefined,
        category: catFilter || undefined,
        scope: catFilter ? 'human' : undefined,
        page,
        size: PAGE_SIZE,
      })
        .then((r) => { if (seq === seqRef.current) { setItems(r.items); setTotal(r.total); } })
        .catch(() => { if (seq === seqRef.current) { setItems([]); setTotal(0); } });
    }, 300);
    return () => clearTimeout(t);
  }, [q, catFilter, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function setHuman(uid: string, name: string) {
    await setCreatorCategory(uid, 'human', name);
    const seq = ++seqRef.current;
    const r = await listCreators({
      q: q || undefined,
      category: catFilter || undefined,
      scope: catFilter ? 'human' : undefined,
      page,
      size: PAGE_SIZE,
    });
    if (seq === seqRef.current) { setItems(r.items); setTotal(r.total); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">UP 主管理</h2>
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>
      <div className="flex gap-2 items-center">
        <Input
          placeholder="搜索 UP 主名/mid"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          className="max-w-xs"
        />
        <Select value={catFilter || '__all'} onValueChange={(v) => { setCatFilter(v === '__all' ? '' : v); setPage(1); }}>
          <SelectTrigger className="w-48"><SelectValue placeholder="按人工分类筛选" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">全部</SelectItem>
            {humanCats.map((c) => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>mid</TableHead>
            <TableHead>Agent 分类</TableHead>
            <TableHead>人工分类</TableHead>
            <TableHead className="text-right">视频数</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.name ?? '(未知)'}</TableCell>
              <TableCell className="text-muted-foreground">{c.source_uid}</TableCell>
              <TableCell>{c.category_agent_name ? <Badge>{c.category_agent_name}</Badge> : '—'}</TableCell>
              <TableCell>
                <Select
                  value={c.category_human_name ?? '__none'}
                  onValueChange={(v) => setHuman(c.source_uid, v)}
                >
                  <SelectTrigger className="w-32"><SelectValue placeholder="未分类" /></SelectTrigger>
                  <SelectContent>
                    {humanCats.map((h) => <SelectItem key={h.id} value={h.name}>{h.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="text-right">{c.video_count}</TableCell>
            </TableRow>
          ))}
          {items.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">暂无数据</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
        <div>第 {page}/{totalPages} 页</div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages || total === 0} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      </div>
    </div>
  );
}
