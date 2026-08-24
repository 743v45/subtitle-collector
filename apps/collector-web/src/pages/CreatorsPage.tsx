import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAsync } from '@/lib/useAsync';
import { useQueryUpdater, useRoute } from '../router';
import { listCategories, listCreators, setCreatorCategory, type Category, type CreatorListItem } from '@/api';
import { creatorUrl } from '../lib/externalLinks';
import { ExtLink } from '@/components/ExtLink';
import { PlatformIcon, platformIconClass } from '@/components/PlatformIcon';
import { PlatformSelect } from '@/components/PlatformSelect';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;
type CreatorSort = 'first_seen' | 'fans' | 'video_count';
const SORTS: readonly CreatorSort[] = ['first_seen', 'fans', 'video_count'];

export function CreatorsPage({ onOpen }: { onOpen: (id: number) => void }) {
  const toast = useToast();
  // 筛选/页码进 URL（#/creators?q=…&sort=fans&page=2），刷新/后退还原；q 输入本地防抖后写 URL
  const route = useRoute();
  const updateQuery = useQueryUpdater();
  const setFilter = (patch: Record<string, string | null | undefined>) => updateQuery(patch, { resetPage: true });
  const q = route.query.get('q') ?? '';
  const catFilter = route.query.get('cat') ?? '';
  const scope = (route.query.get('scope') === 'agent' ? 'agent' : 'human') as 'agent' | 'human';
  const sourceRaw = route.query.get('source');
  const source = sourceRaw === 'bilibili' || sourceRaw === 'youtube' ? sourceRaw : null;
  const sortRaw = route.query.get('sort');
  const sort: CreatorSort = (SORTS as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as CreatorSort) : 'first_seen';
  const pageRaw = Number(route.query.get('page'));
  const page = Number.isInteger(pageRaw) && pageRaw > 1 ? pageRaw : 1;
  const [busyUid, setBusyUid] = useState<string | null>(null);

  // 搜索防抖（300ms）：本地回显,停止输入后写 URL
  const [qInput, setQInput] = useState(q);
  useEffect(() => { setQInput(q); }, [q]);
  useEffect(() => {
    const t = setTimeout(() => { if (qInput !== q) setFilter({ q: qInput || null }); }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // 列表：useAsync 驱动，error 显式落到 UI（不再 .catch 静默吞）。
  const { data: listResult, loading, error, reload } = useAsync(
    () => listCreators({
      q: q || undefined,
      category: catFilter || undefined,
      scope: catFilter ? scope : undefined,
      source: source ?? undefined,
      sort,
      page,
      size: PAGE_SIZE,
    }),
    [q, catFilter, scope, source, sort, page],
  );
  const items = listResult?.items ?? [];
  const total = listResult?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 筛选下拉随 scope 切换重新拉；表格内两套可编辑选项各拉一次。
  const { data: filterCats } = useAsync<Category[]>(() => listCategories(scope), [scope]);
  const { data: agentCats } = useAsync<Category[]>(() => listCategories('agent'), []);
  const { data: humanCats } = useAsync<Category[]>(() => listCategories('human'), []);

  // 切 scope：旧分类名对新 scope 无意义，一并清掉
  function switchScope(s: 'agent' | 'human') {
    if (s === scope) return;
    updateQuery({ scope: s === 'human' ? null : s, cat: null }, { resetPage: true });
  }

  async function changeCategory(c: CreatorListItem, catScope: 'agent' | 'human', name: string) {
    setBusyUid(c.source_uid);
    try {
      // 平台段必传：uid 两平台命名空间独立（B 站 mid / YouTube channelId），不带会写错行
      await setCreatorCategory(c.source, c.source_uid, catScope, name);
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
        <h2 className="text-xl font-semibold tracking-tight">创作者管理</h2>
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="搜索 创作者名/ID"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
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
          onValueChange={(v) => setFilter({ cat: v || null })}
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
          onValueChange={(v) => setFilter({ sort: v === 'first_seen' ? null : v })}
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
        <PlatformSelect value={source} onChange={(v) => setFilter({ source: v })} />
      </div>

      <div className="overflow-hidden rounded-md border" aria-busy={loading || undefined}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>名称</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Agent 分类</TableHead>
              <TableHead>人工分类</TableHead>
              <TableHead className="text-right">粉丝</TableHead>
              <TableHead className="text-right">视频数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {error ? (
              <TableRow className="hover:bg-transparent">
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
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="py-8 text-center">
                  <div className="text-sm text-muted-foreground">
                    {q || catFilter || source ? '没有匹配的创作者——试试放宽搜索或筛选' : '暂无创作者——采集视频后创作者会自动入库'}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
            items.map((c) => (
              <TableRow key={c.id} className="cursor-pointer hover:bg-accent" onClick={() => onOpen(c.id)}>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    {/* 平台图标：同名创作者两平台各一条时靠它分辨（2026-08-24） */}
                    <PlatformIcon source={c.source} className={cn('h-3.5 w-3.5', platformIconClass(c.source))} />
                    {c.name ?? '(未知)'}
                    <ExtLink href={creatorUrl(c.source, c.source_uid)} label={`在原站打开 ${c.name ?? c.source_uid} 的空间`} />
                  </span>
                </TableCell>
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
                <TableCell className="text-right tabular-nums">{c.fans != null ? c.fans.toLocaleString('zh-CN') : '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{c.video_count}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      </div>

      <div className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
        <div className="tabular-nums">第 {page}/{totalPages} 页</div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => updateQuery({ page: page - 1 > 1 ? String(page - 1) : null })}>上一页</Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages || total === 0} onClick={() => updateQuery({ page: String(page + 1) })}>下一页</Button>
        </div>
      </div>
    </div>
  );
}
