// 创作者列表表格（2026-10-05 自 CreatorsPage.tsx 抽出，承载 Q6a 勾选列与 Q6b 行内「刷新资料」按钮）：
// - 勾选列：原生 input（shadcn/ui 无 checkbox；头部=全选本页可见行，行内 stopPropagation 防触发行跳转）
// - 刷新资料：仅 bilibili 行渲染（refreshCreatorProfile 只实现了 B 站链路），busy 时禁点防连点
// - 行点击仍跳详情（onOpen）；Select 单元格走 CreatorCategoryCell
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { creatorUrl } from '../lib/externalLinks';
import { ExtLink } from '@/components/ExtLink';
import { PlatformIcon, platformIconClass } from '@/components/PlatformIcon';
import { cn } from '@/lib/utils';
import { CreatorCategoryCell } from './CreatorCategoryCell';
import type { Category, CreatorListItem } from '@/api';

export function CreatorsTable({
  items, cats, loading, error, reload, busyUid, refreshingId,
  selected, allSelected, onToggleRow, onToggleAll,
  onOpen, onCategoryChange, onRefreshProfile, emptyHint,
}: {
  items: CreatorListItem[];
  cats: Category[] | null | undefined; // useAsync data 是 T | null，调用方直传
  loading: boolean;
  error: string | null;
  reload: () => void;
  busyUid: string | null;      // 分类写入中的行（按 source_uid）
  refreshingId: number | null; // 刷新资料中的行（按 creators.id）
  selected: Set<number>;
  allSelected: boolean;
  onToggleRow: (c: CreatorListItem) => void;
  onToggleAll: () => void;
  onOpen: (id: number) => void;
  onCategoryChange: (c: CreatorListItem, scope: 'agent' | 'human', name: string) => void;
  onRefreshProfile: (c: CreatorListItem) => void;
  emptyHint: string; // 有筛选时提示放宽条件，无筛选时提示先采集（父级按当前筛选拼好）
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-10">
            {/* Q6a 全选本页（可见行）：勾选集只存 creators.id，翻页/筛选后各页独立勾 */}
            <input
              type="checkbox"
              className="size-4 cursor-pointer accent-primary"
              aria-label="全选本页"
              checked={allSelected}
              onChange={() => onToggleAll()}
            />
          </TableHead>
          <TableHead>名称</TableHead>
          <TableHead>ID</TableHead>
          <TableHead>Agent 分类</TableHead>
          <TableHead>人工分类</TableHead>
          <TableHead className="text-right">粉丝</TableHead>
          <TableHead className="text-right">视频数</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {error ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={8} className="text-sm text-destructive">
              加载失败：{error}
              <Button variant="link" size="sm" onClick={reload}>重试</Button>
            </TableCell>
          </TableRow>
        ) : loading && items.length === 0 ? (
          Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell><Skeleton className="h-4 w-4" /></TableCell>
              <TableCell><Skeleton className="h-4 w-24" /></TableCell>
              <TableCell><Skeleton className="h-4 w-20" /></TableCell>
              <TableCell><Skeleton className="h-8 w-32" /></TableCell>
              <TableCell><Skeleton className="h-8 w-32" /></TableCell>
              <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-10" /></TableCell>
              <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-8" /></TableCell>
              <TableCell className="text-right"><Skeleton className="ml-auto h-7 w-20" /></TableCell>
            </TableRow>
          ))
        ) : items.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={8} className="py-8 text-center">
              <div className="text-sm text-muted-foreground">{emptyHint}</div>
            </TableCell>
          </TableRow>
        ) : (
          items.map((c) => {
            const checked = selected.has(c.id);
            const refreshing = refreshingId === c.id;
            return (
              <TableRow key={c.id} className="cursor-pointer hover:bg-accent" onClick={() => onOpen(c.id)}>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer accent-primary"
                    aria-label={`选择 ${c.name ?? c.source_uid}`}
                    checked={checked}
                    onChange={() => onToggleRow(c)}
                  />
                </TableCell>
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
                  <CreatorCategoryCell
                    value={c.category_agent_name}
                    cats={cats}
                    disabled={busyUid === c.source_uid}
                    placeholder="未分类"
                    triggerClass="w-32"
                    onPick={(name) => onCategoryChange(c, 'agent', name)}
                  />
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <CreatorCategoryCell
                    value={c.category_human_name}
                    cats={cats}
                    disabled={busyUid === c.source_uid}
                    placeholder="未分类"
                    triggerClass="w-32"
                    onPick={(name) => onCategoryChange(c, 'human', name)}
                  />
                </TableCell>
                <TableCell className="text-right tabular-nums">{c.fans != null ? c.fans.toLocaleString('zh-CN') : '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{c.video_count}</TableCell>
                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  {/* Q6b 刷新资料：仅 bilibili（B 站空间 API 链路；youtube/douyin 无对应实现不渲染按钮） */}
                  {c.source === 'bilibili' && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={refreshing || busyUid === c.source_uid}
                      aria-label={`刷新 ${c.name ?? c.source_uid} 的资料`}
                      title="重新拉取昵称/头像/粉丝数等空间资料"
                      onClick={() => onRefreshProfile(c)}
                    >
                      {refreshing ? '刷新中…' : '刷新资料'}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
