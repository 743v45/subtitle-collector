import { useEffect, useState } from 'react';
import { listVideos, getStatsAggregate } from '../api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useAsync } from '@/lib/useAsync';
import { TAG_SOURCE_CLASS, type TagSource } from '@/lib/tagSources';
import { ArrowDown, ArrowUp, ChevronDown, RotateCcw } from 'lucide-react';
import type { VideoFilter, VideoListItem } from '../types';

const PAGE_SIZE = 20;

type SortField = NonNullable<VideoFilter['sort']>;
type DateField = NonNullable<VideoFilter['date_field']>;

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

// 秒 → m:ss / h:mm:ss
function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// 播放量 → 万 / 亿
function formatView(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 10000) return String(n);
  if (n < 100000000) return `${(n / 10000).toFixed(1)}万`;
  return `${(n / 100000000).toFixed(1)}亿`;
}

export function VideoList({ onOpen }: { onOpen: (source: string, sourceVid: string) => void }) {
  // q / 字幕关键词 都走防抖（300ms）
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [subtitleQInput, setSubtitleQInput] = useState('');
  const [subtitleQ, setSubtitleQ] = useState('');
  // 平台（B 站/YouTube）+ 分区（下拉，选项从 aggregate 拉）
  const [source, setSource] = useState('');
  const [tname, setTname] = useState('');
  // 次要筛选（折叠区）：标签（下拉，精确）+ 标签档位（下拉）
  const [tagName, setTagName] = useState('');
  const [tagSourceSel, setTagSourceSel] = useState('');
  const [lang, setLang] = useState('');
  const [hasSubtitle, setHasSubtitle] = useState(false);
  // 时间区间（YYYY-MM-DD）+ 时长区间（分钟）+ 播放量区间（万）
  const [dateField, setDateField] = useState<DateField>('first_seen');
  const [sinceDate, setSinceDate] = useState('');
  const [untilDate, setUntilDate] = useState('');
  const [minDur, setMinDur] = useState('');
  const [maxDur, setMaxDur] = useState('');
  const [minView, setMinView] = useState('');
  const [maxView, setMaxView] = useState('');
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
  useEffect(() => {
    const t = setTimeout(() => setSubtitleQ(subtitleQInput), 300);
    return () => clearTimeout(t);
  }, [subtitleQInput]);

  // 分区下拉选项：从 aggregate groupBy=tname 拉（过滤空/unknown），topN=200 覆盖常见分区
  const { data: partitionsData } = useAsync(() => getStatsAggregate('tname', {}, 200), []);
  const partitions = (partitionsData ?? []).filter((p) => p.key && p.key !== '(unknown)');

  // 标签下拉选项：从 aggregate groupBy=tag 拉（四档并聚 DISTINCT），与分区下拉同思路
  const { data: tagAggData } = useAsync(() => getStatsAggregate('tag', {}, 200), []);
  const tagOptions = (tagAggData ?? []).filter((t) => t.key);

  // 日期 → 毫秒时间戳（since 当天 00:00，until 当天 23:59:59.999）；分钟 → 秒；万 → 绝对值
  const since = sinceDate ? new Date(sinceDate + 'T00:00:00').getTime() : undefined;
  const until = untilDate ? new Date(untilDate + 'T23:59:59.999').getTime() : undefined;
  const min_duration = minDur && Number.isFinite(Number(minDur)) ? Math.floor(Number(minDur)) * 60 : undefined;
  const max_duration = maxDur && Number.isFinite(Number(maxDur)) ? Math.floor(Number(maxDur)) * 60 : undefined;
  const min_view = minView && Number.isFinite(Number(minView)) ? Math.floor(Number(minView)) * 10000 : undefined;
  const max_view = maxView && Number.isFinite(Number(maxView)) ? Math.floor(Number(maxView)) * 10000 : undefined;

  const { data, loading, error, reload } = useAsync(
    () =>
      listVideos({
        q: q || undefined,
        source: source || undefined,
        subtitle_q: subtitleQ || undefined,
        tname: tname || undefined,
        tags: tagName ? [tagName] : undefined,
        tag_source: tagSourceSel ? [tagSourceSel] : undefined,
        lang: lang || undefined,
        has_subtitle: hasSubtitle || undefined,
        date_field: dateField,
        since,
        until,
        min_duration,
        max_duration,
        min_view,
        max_view,
        sort,
        desc: sort ? desc : undefined,
        page,
        size: PAGE_SIZE,
      }),
    [source, q, subtitleQ, tname, tagName, tagSourceSel, lang, hasSubtitle, dateField, since, until, min_duration, max_duration, min_view, max_view, sort, desc, page],
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
    setSource('');
    setSubtitleQInput('');
    setSubtitleQ('');
    setTname('');
    setTagName('');
    setTagSourceSel('');
    setLang('');
    setHasSubtitle(false);
    setDateField('first_seen');
    setSinceDate('');
    setUntilDate('');
    setMinDur('');
    setMaxDur('');
    setMinView('');
    setMaxView('');
    setSort(undefined);
    setDesc(true);
    setPage(1);
  }

  // 任一次要筛选已激活时，"更多筛选"按钮给个视觉提示
  const secondaryActive = !!(tagName || tagSourceSel || lang || hasSubtitle || sinceDate || untilDate || minDur || maxDur || minView || maxView);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">视频库</h2>
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>

      {/* 主筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[180px] flex-1"
          placeholder="搜索标题 / 创作者"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <Select
          value={source || '__all'}
          onValueChange={(v) => onFilterChange(setSource)(v === '__all' ? '' : v)}
        >
          <SelectTrigger className="w-[120px]">
            <SelectValue placeholder="平台" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">全部平台</SelectItem>
            <SelectItem value="bilibili">哔哩哔哩</SelectItem>
            <SelectItem value="youtube">YouTube</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="min-w-[160px] flex-1"
          placeholder="搜字幕内容"
          value={subtitleQInput}
          onChange={(e) => setSubtitleQInput(e.target.value)}
        />
        <Select
          value={tname || '__all'}
          onValueChange={(v) => onFilterChange(setTname)(v === '__all' ? '' : v)}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="分区" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">全部分区</SelectItem>
            {partitions.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.key} ({p.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 p-3">
          <Select
            value={tagName || '__all'}
            onValueChange={(v) => onFilterChange(setTagName)(v === '__all' ? '' : v)}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="标签" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">全部标签</SelectItem>
              {tagOptions.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {t.key} ({t.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={tagSourceSel || '__all'}
            onValueChange={(v) => onFilterChange(setTagSourceSel)(v === '__all' ? '' : v)}
          >
            <SelectTrigger className="w-[120px]">
              <SelectValue placeholder="标签档位" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">全部档位</SelectItem>
              <SelectItem value="manual">手动</SelectItem>
              <SelectItem value="batch">批量</SelectItem>
              <SelectItem value="ai">AI</SelectItem>
              <SelectItem value="bili">B站</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="max-w-[140px]"
            placeholder="语言，如 zh/en"
            value={lang}
            onChange={(e) => onFilterChange(setLang)(e.target.value)}
          />
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>时长</span>
            <Input
              type="number"
              min={0}
              className="w-20"
              placeholder="最小"
              value={minDur}
              onChange={(e) => onFilterChange(setMinDur)(e.target.value)}
            />
            <span>~</span>
            <Input
              type="number"
              min={0}
              className="w-20"
              placeholder="最大"
              value={maxDur}
              onChange={(e) => onFilterChange(setMaxDur)(e.target.value)}
            />
            <span>分钟</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>播放</span>
            <Input
              type="number"
              min={0}
              className="w-20"
              placeholder="最小"
              value={minView}
              onChange={(e) => onFilterChange(setMinView)(e.target.value)}
            />
            <span>~</span>
            <Input
              type="number"
              min={0}
              className="w-20"
              placeholder="最大"
              value={maxView}
              onChange={(e) => onFilterChange(setMaxView)(e.target.value)}
            />
            <span>万</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Select value={dateField} onValueChange={(v) => onFilterChange(setDateField)(v as DateField)}>
              <SelectTrigger className="h-8 w-[88px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="first_seen">首见</SelectItem>
                <SelectItem value="published_at">发布</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="date"
              className="w-36"
              value={sinceDate}
              onChange={(e) => onFilterChange(setSinceDate)(e.target.value)}
            />
            <span>~</span>
            <Input
              type="date"
              className="w-36"
              value={untilDate}
              onChange={(e) => onFilterChange(setUntilDate)(e.target.value)}
            />
          </div>
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

      {/* 列表区：响应式网格（移动单列 / md 两列 / xl 三列），loading / error / 空态 */}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3 xl:grid-cols-3">
        {loading &&
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="space-y-2 p-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </CardHeader>
            </Card>
          ))}

        {!loading && error && (
          <Card className="col-span-full">
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
          <Card className="col-span-full">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">暂无数据</CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// 平台图标：bilibili(粉 #FB7299) / youtube(红) 内联 SVG（simpleicons.org path，与扩展 platforms.ts 同源）
function PlatformIcon({ source, className }: { source: string; className?: string }) {
  const path = source === 'youtube'
    ? 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z'
    : 'M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z';
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

function VideoRow({ v, onOpen }: { v: VideoListItem; onOpen: (source: string, sourceVid: string) => void }) {
  // tag_details（四档带色）优先；旧接口只回 tags 时退化为无色 outline Badge
  const tagDetails: { name: string; source?: TagSource }[] =
    v.tag_details ?? (v.tags ?? []).map((name) => ({ name }));
  const shownTags = tagDetails.slice(0, 3);
  const extraTags = Math.max(0, tagDetails.length - shownTags.length);
  const dur = formatDuration(v.duration);
  const iconColor = v.source === 'youtube' ? 'text-red-500' : 'text-[#FB7299]';

  return (
    <Card
      onClick={() => onOpen(v.source, v.source_vid)}
      className="cursor-pointer transition-colors hover:bg-accent"
    >
      <CardHeader className="space-y-1 p-3">
        <CardTitle className="flex items-start gap-1.5 text-sm font-medium">
          <PlatformIcon source={v.source} className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', iconColor)} />
          <span className="line-clamp-2">{v.title}</span>
        </CardTitle>
        <CardDescription className="text-xs flex flex-wrap items-center gap-x-2">
          <span>{v.creator_name ?? '—'}</span>
          {v.view != null && <span>· 播放 {formatView(v.view)}</span>}
          {dur && <span>· {dur}</span>}
          <span>· {v.track_count} 轨</span>
          {v.published_at ? <span>· 发布 {formatTs(v.published_at)}</span> : null}
        </CardDescription>
        {(v.tname || tagDetails.length > 0) && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {v.tname && <Badge variant="secondary">{v.tname}</Badge>}
            {shownTags.map((t, i) => (
              <Badge
                key={`${t.name}-${t.source ?? i}`}
                variant="outline"
                className={t.source ? TAG_SOURCE_CLASS[t.source] : undefined}
              >
                {t.name}
              </Badge>
            ))}
            {extraTags > 0 && <Badge variant="outline">+{extraTags}</Badge>}
          </div>
        )}
      </CardHeader>
    </Card>
  );
}
