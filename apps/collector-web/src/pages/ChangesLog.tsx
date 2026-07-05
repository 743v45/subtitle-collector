import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { useAsync } from '@/lib/useAsync';
import { getChanges } from '@/api';
import type { ChangeRow } from '@/types';

const PAGE_SIZE = 30;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
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
  const [entity, setEntity] = useState<string>('');
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useAsync(
    () => getChanges({ entity: entity || undefined, page, size: PAGE_SIZE }),
    [entity, page],
  );
  const items: ChangeRow[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">采集 / 变更日志</h2>
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={entity || '__all'}
          onValueChange={(v) => { setEntity(v === '__all' ? '' : v); setPage(1); }}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">全部</SelectItem>
            <SelectItem value="video">视频</SelectItem>
            <SelectItem value="creator">UP 主</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={reload}>刷新</Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-40">时间</TableHead>
            <TableHead className="w-16">类型</TableHead>
            <TableHead className="w-20">标识</TableHead>
            <TableHead className="w-32">字段</TableHead>
            <TableHead>变更（旧 → 新）</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {error ? (
            <TableRow>
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
            <TableRow>
              <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">暂无数据</TableCell>
            </TableRow>
          ) : (
            items.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtTime(c.changed_at)}</TableCell>
                <TableCell className="text-xs">
                  {c.entity === 'video' ? '视频' : c.entity === 'creator' ? 'UP' : c.entity}
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

      <div className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
        <div>第 {page}/{totalPages} 页</div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages || total === 0} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      </div>

      {items.length > 0 && (
        <Card>
          <CardContent className="p-3 text-xs text-muted-foreground">
            说明：记录视频/UP 主字段的结构性变更（标题、分区、标签、资料等）；播放量等统计波动不记（采集时即时快照，存 videos.extra）。
          </CardContent>
        </Card>
      )}
    </div>
  );
}
