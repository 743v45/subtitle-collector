import { useEffect, useState } from 'react';
import { listVideos } from '../api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useAsync } from '@/lib/useAsync';
import { ArrowDown, ArrowUp, ChevronDown, RotateCcw } from 'lucide-react';
import type { VideoFilter, VideoListItem } from '../types';

const PAGE_SIZE = 20;

type SortField = NonNullable<VideoFilter['sort']>;

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'first_seen', label: '首见时间' },
  { value: 'published_at', label: '发布时间' },
  { value: 'view', label: '播放量' },
  { value: 'duration', label: '时长' },
];

function formatTs(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

export function VideoList({ onOpen }: { onOpen: (source: string, sourceVid: string) => void }) {
  // q 走防抖（输入即时更新 qInput，300ms 后落到 q 驱动查询）
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  // 次要筛选（折叠区）
  const [tname, setTname] = useState('');
  const [tag, setTag] = useState('');
  const [lang, setLang] = useState('');
  const [hasSubtitle, setHasSubtitle] = useState(false);
  // 排序
  const [sort, setSort] = useState<SortField | undefined>(undefined);
  const [desc, setDesc] = useState(true);
  // 折叠态 + 分页
  const [showMore, setShowMore] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const { data, loading, error, reload } = useAsync(
    () =>
      listVideos({
        q: q || undefined,
        tname: tname || undefined,
        tag: tag || undefined,
        lang: lang || undefined,
        has_subtitle: hasSubtitle || undefined,
        sort,
        desc: sort ? desc : undefined,
        page,
        size: PAGE_SIZE,
      }),
    [q, tname, tag, lang, hasSubtitle, sort, desc, page],
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 任一筛选变化都回到第 1 页
  const onFilterChange = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(1);
  };

  function resetAll() {
    setQInput('');
    setQ('');
    setTname('');
    setTag('');
    setLang('');
    setHasSubtitle(false);
    setSort(undefined);
    setDesc(true);
    setPage(1);
  }

  // 任一次要筛选已激活时，"更多筛选"按钮给个视觉提示
  const secondaryActive = !!(tname || tag || lang || hasSubtitle);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">视频库</h2>
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>

      {/* 主筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[200px] flex-1"
          placeholder="搜索标题 / UP主"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <div className="flex items-center gap-1">
          <Select
            value={sort ?? '__default'}
            onValueChange={(v) => onFilterChange(setSort)(v === '__default' ? undefined : (v as SortField))}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="排序" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default">默认排序</SelectItem>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="px-2"
            disabled={!sort}
            title={desc ? '当前降序，点击切换升序' : '当前升序，点击切换降序'}
            onClick={() => onFilterChange(setDesc)(!desc)}
          >
            {desc ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
          </Button>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowMore((s) => !s)}>
          更多筛选
          <ChevronDown className={cn('h-4 w-4 transition-transform', showMore && 'rotate-180')} />
          {secondaryActive && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-primary" />}
        </Button>
        <Button variant="outline" size="sm" onClick={resetAll}>
          <RotateCcw className="h-4 w-4" />
          重置
        </Button>
      </div>

      {/* 次要筛选折叠区 */}
      {showMore && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
          <Input
            className="max-w-[180px]"
            placeholder="分区（模糊）"
            value={tname}
            onChange={(e) => onFilterChange(setTname)(e.target.value)}
          />
          <Input
            className="max-w-[180px]"
            placeholder="标签（模糊）"
            value={tag}
            onChange={(e) => onFilterChange(setTag)(e.target.value)}
          />
          <Input
            className="max-w-[140px]"
            placeholder="语言，如 zh/en"
            value={lang}
            onChange={(e) => onFilterChange(setLang)(e.target.value)}
          />
          <Button
            variant={hasSubtitle ? 'default' : 'outline'}
            size="sm"
            onClick={() => onFilterChange(setHasSubtitle)(!hasSubtitle)}
          >
            仅含字幕：{hasSubtitle ? '开' : '关'}
          </Button>
        </div>
      )}

      {/* 分页 */}
      <div className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
        <div>第 {page}/{totalPages} 页</div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || total === 0}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      </div>

      {/* 列表区：loading / error / 空态 */}
      <div className="space-y-2">
        {loading &&
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="space-y-2 p-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </CardHeader>
            </Card>
          ))}

        {!loading && error && (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 p-6 text-center text-sm">
              <div className="text-destructive">加载失败：{error}</div>
              <Button variant="outline" size="sm" onClick={reload}>
                重试
              </Button>
            </CardContent>
          </Card>
        )}

        {!loading && !error && items.map((v) => <VideoRow key={v.id} v={v} onOpen={onOpen} />)}

        {!loading && !error && items.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">暂无数据</CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function VideoRow({ v, onOpen }: { v: VideoListItem; onOpen: (source: string, sourceVid: string) => void }) {
  const tags = v.tags ?? [];
  const shownTags = tags.slice(0, 3);
  const extraTags = Math.max(0, tags.length - shownTags.length);

  return (
    <Card
      onClick={() => onOpen(v.source, v.source_vid)}
      className="cursor-pointer transition-colors hover:bg-accent"
    >
      <CardHeader className="space-y-1 p-4">
        <CardTitle className="text-base font-medium">{v.title}</CardTitle>
        <CardDescription className="text-xs">
          {v.creator_name ?? '—'} · {v.track_count} 轨
          {v.published_at ? ` · 发布 ${formatTs(v.published_at)}` : ''} · 首见 {formatTs(v.first_seen_at)}
        </CardDescription>
        {(v.tname || tags.length > 0) && (
          <div className="flex flex-wrap gap-1 pt-1">
            {v.tname && <Badge variant="secondary">{v.tname}</Badge>}
            {shownTags.map((t) => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
            {extraTags > 0 && <Badge variant="outline">+{extraTags}</Badge>}
          </div>
        )}
      </CardHeader>
    </Card>
  );
}
