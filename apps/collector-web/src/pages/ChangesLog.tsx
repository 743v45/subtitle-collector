import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { useAsync } from '@/lib/useAsync';
import { useQueryUpdater, useRoute } from '../router';
import { getChanges } from '@/api';
import { PlatformIcon, platformIconClass } from '@/components/PlatformIcon';
import { PlatformSelect } from '@/components/PlatformSelect';
import { cn } from '@/lib/utils';
import type { ChangeRow } from '@/types';

const PAGE_SIZE = 30;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN');
}

// old/new 值可能很长（如 extra JSON），截断显示，hover title 看全
function ValueCell({ v }: { v: string | null }) {
  if (v == null || v === '') return <span className="text-muted-foreground">—</span>;
  const display = v.length > 80 ? v.slice(0, 80) + '…' : v;
  return (
    <span className="break-all font-mono text-xs" title={v}>
      {display}
    </span>
  );
}

export function ChangesLog() {
  // 类型 + 平台筛选 + 页码进 URL（#/changes?entity=video&source=bilibili&page=2），刷新/后退还原
  const route = useRoute();
  const updateQuery = useQueryUpdater();
  const entity = route.query.get('entity') ?? '';
  const sourceRaw = route.query.get('source');
  const source = sourceRaw === 'bilibili' || sourceRaw === 'youtube' ? sourceRaw : null;
  const pageRaw = Number(route.query.get('page'));
  const page = Number.isInteger(pageRaw) && pageRaw > 1 ? pageRaw : 1;
  const { data, loading, error, reload } = useAsync(
    () => getChanges({ entity: entity || undefined, source: source ?? undefined, page, size: PAGE_SIZE }),
    [entity, source, page],
  );
  const items: ChangeRow[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">采集 / 变更日志</h2>
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={entity || '__all'}
          onValueChange={(v) => updateQuery({ entity: v === '__all' ? null : v }, { resetPage: true })}
        >
          <SelectTrigger className="w-32" aria-label="类型筛选">
            <SelectValue placeholder="类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">全部</SelectItem>
            <SelectItem value="video">视频</SelectItem>
            <SelectItem value="creator">创作者</SelectItem>
          </SelectContent>
        </Select>
        <PlatformSelect value={source} onChange={(v) => updateQuery({ source: v }, { resetPage: true })} />
        <Button variant="outline" size="sm" onClick={reload}>刷新</Button>
      </div>

      <div className="overflow-hidden rounded-md border" aria-busy={loading || undefined}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-40">时间</TableHead>
              <TableHead className="w-16">类型</TableHead>
              <TableHead className="w-20">标识</TableHead>
              <TableHead className="w-32">字段</TableHead>
              <TableHead>变更（旧 → 新）</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {error ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="text-sm text-destructive">
                  加载失败：{error}
                  <Button variant="link" size="sm" onClick={reload}>重试</Button>
                </TableCell>
              </TableRow>
            ) : loading && items.length === 0 ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-full" /></TableCell>
                </TableRow>
              ))
            ) : items.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-8 text-center">
                  <div className="text-sm text-muted-foreground">暂无变更记录——采集新视频或重采后，字段变更会记录在这里</div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{fmtTime(c.changed_at)}</TableCell>
                  <TableCell className="text-xs">
                    <span className="inline-flex items-center gap-1">
                      {/* 派生 source 列：实体行所属平台（不可判时省略图标） */}
                      {c.source && <PlatformIcon source={c.source} className={cn('h-3 w-3', platformIconClass(c.source))} />}
                      {c.entity === 'video' ? '视频' : c.entity === 'creator' ? 'UP' : c.entity}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{c.entity_id}</TableCell>
                  <TableCell className="text-xs">{c.field}</TableCell>
                  <TableCell>
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <ValueCell v={c.old_value} />
                      <span className="text-muted-foreground">→</span>
                      <ValueCell v={c.new_value} />
                    </span>
                  </TableCell>
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

      {items.length > 0 && (
        <Card>
          <CardContent className="p-3 text-xs text-muted-foreground">
            说明：记录视频/创作者字段的结构性变更（标题、分区、标签、资料等）；播放量等统计波动不记（采集时即时快照，存 videos.extra）。
          </CardContent>
        </Card>
      )}
    </div>
  );
}
