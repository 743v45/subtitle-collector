import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAsync } from '@/lib/useAsync';
import { listCategories, listCreators, setCreatorCategory, type Category, type CreatorListItem } from '@/api';

const PAGE_SIZE = 20;
type CreatorSort = 'first_seen' | 'fans' | 'video_count';

export function CreatorsPage({ onOpen }: { onOpen: (id: number) => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [scope, setScope] = useState<'agent' | 'human'>('human');
  const [catFilter, setCatFilter] = useState<string>('');
  const [sort, setSort] = useState<CreatorSort>('first_seen');
  const [page, setPage] = useState(1);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  // 搜索防抖（300ms），避免每次按键都打后端。
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // 列表：useAsync 驱动，error 显式落到 UI（不再 .catch 静默吞）。
  const { data: listResult, loading, error, reload } = useAsync(
    () => listCreators({
      q: debouncedQ || undefined,
      category: catFilter || undefined,
      scope: catFilter ? scope : undefined,
      sort,
      page,
      size: PAGE_SIZE,
    }),
    [debouncedQ, catFilter, scope, sort, page],
  );
  const items = listResult?.items ?? [];
  const total = listResult?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 筛选下拉随 scope 切换重新拉；表格内两套可编辑选项各拉一次。
  const { data: filterCats } = useAsync<Category[]>(() => listCategories(scope), [scope]);
  const { data: agentCats } = useAsync<Category[]>(() => listCategories('agent'), []);
  const { data: humanCats } = useAsync<Category[]>(() => listCategories('human'), []);

  function switchScope(s: 'agent' | 'human') {
    if (s === scope) return;
    setScope(s);
    setCatFilter('');   // 切 scope 后旧分类名对新 scope 无意义，清空。
    setPage(1);
  }

  async function changeCategory(c: CreatorListItem, catScope: 'agent' | 'human', name: string) {
    setBusyUid(c.source_uid);
    try {
      await setCreatorCategory(c.source_uid, catScope, name);
      toast('已更新', 'success');
      reload();
    } catch (e: unknown) {
      toast(`失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusyUid(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">UP 主管理</h2>
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="搜索 UP 主名/mid"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          className="max-w-xs"
        />
        <div className="flex gap-1">
          {(['agent', 'human'] as const).map((s) => (
            <Button
              key={s}
              variant={s === scope ? 'default' : 'outline'}
              size="sm"
              onClick={() => switchScope(s)}
            >
              {s === 'agent' ? 'Agent 分类' : '人工分类'}
            </Button>
          ))}
        </div>
        <Select
          value={catFilter || undefined}
          onValueChange={(v) => { setCatFilter(v); setPage(1); }}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder={`按${scope === 'agent' ? 'Agent' : '人工'}分类筛选`} />
          </SelectTrigger>
          <SelectContent>
            {(filterCats ?? []).map((c) => (
              <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sort}
          onValueChange={(v) => { setSort(v as CreatorSort); setPage(1); }}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="first_seen">首见时间</SelectItem>
            <SelectItem value="fans">粉丝数</SelectItem>
            <SelectItem value="video_count">视频数</SelectItem>
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
            <TableHead className="text-right">粉丝</TableHead>
            <TableHead className="text-right">视频数</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {error ? (
            <TableRow>
              <TableCell colSpan={6} className="text-sm text-destructive">
                加载失败：{error}
                <Button variant="link" size="sm" onClick={reload}>重试</Button>
              </TableCell>
            </TableRow>
          ) : loading && items.length === 0 ? (
            Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                <TableCell><Skeleton className="h-8 w-32" /></TableCell>
                <TableCell><Skeleton className="h-8 w-32" /></TableCell>
                <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-10" /></TableCell>
                <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-8" /></TableCell>
              </TableRow>
            ))
          ) : items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">暂无数据</TableCell>
            </TableRow>
          ) : (
            items.map((c) => (
              <TableRow key={c.id} className="cursor-pointer hover:bg-accent" onClick={() => onOpen(c.id)}>
                <TableCell>{c.name ?? '(未知)'}</TableCell>
                <TableCell className="font-mono text-muted-foreground">{c.source_uid}</TableCell>
                {/* stopPropagation：点 Select 触发器不能冒泡到行触发行跳转。SelectContent 走 Portal 不会冒泡到行。 */}
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Select
                    value={c.category_agent_name ?? undefined}
                    onValueChange={(v) => changeCategory(c, 'agent', v)}
                    disabled={busyUid === c.source_uid}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue placeholder="未分类" />
                    </SelectTrigger>
                    <SelectContent>
                      {(agentCats ?? []).map((h) => (
                        <SelectItem key={h.id} value={h.name}>{h.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Select
                    value={c.category_human_name ?? undefined}
                    onValueChange={(v) => changeCategory(c, 'human', v)}
                    disabled={busyUid === c.source_uid}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue placeholder="未分类" />
                    </SelectTrigger>
                    <SelectContent>
                      {(humanCats ?? []).map((h) => (
                        <SelectItem key={h.id} value={h.name}>{h.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right tabular-nums">{c.fans != null ? c.fans.toLocaleString() : '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{c.video_count}</TableCell>
              </TableRow>
            ))
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
