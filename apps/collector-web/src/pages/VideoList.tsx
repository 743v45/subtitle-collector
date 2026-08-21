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
import { navigate, useQueryUpdater, useRoute } from '../router';
import { videoListFromQuery } from '../videoFilterUrl';
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
  return new Date(ts).toLocaleString('zh-CN');
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

export function VideoList() {
  // ── 筛选状态：URL 是唯一真相 ──
  // 全部筛选从 hash query 派生（#/videos?source=youtube&page=2），变更 replace 写回；
  // 刷新/分享/后退/标签页跳入都还原。输入框本地回显防抖 300ms 后写 URL。
  const route = useRoute();
  const updateQuery = useQueryUpdater();
  const f = videoListFromQuery(route.query);

  // 筛选变更（resetPage：任一筛选变化回第 1 页）
  const setFilter = (patch: Record<string, string | null | undefined>) => updateQuery(patch, { resetPage: true });

  // 搜索框：本地回显 + 防抖写 q/sq（打字不打爆历史栈、不打断输入）
  const [qInput, setQInput] = useState(f.q);
  const [sqInput, setSqInput] = useState(f.sq);
  // 外部 query 变化（后退/分享/标签页跳入）→ 同步输入框；同值时 React bail out 无感
  useEffect(() => { setQInput(f.q); }, [f.q]);
  useEffect(() => { setSqInput(f.sq); }, [f.sq]);
  useEffect(() => {
    const t = setTimeout(() => { if (qInput !== f.q) setFilter({ q: qInput || null }); }, 300);
    return () => clearTimeout(t);
  }, [qInput]);
  useEffect(() => {
    const t = setTimeout(() => { if (sqInput !== f.sq) setFilter({ sq: sqInput || null }); }, 300);
    return () => clearTimeout(t);
  }, [sqInput]);

  // 分区下拉选项：从 aggregate groupBy=tname 拉（过滤空/unknown），topN=200 覆盖常见分区
  const { data: partitionsData } = useAsync(() => getStatsAggregate('tname', {}, 200), []);
  const partitions = (partitionsData ?? []).filter((p) => p.key && p.key !== '(unknown)');

  // 标签下拉选项：从 aggregate groupBy=tag 拉（四档并聚 DISTINCT），与分区下拉同思路
  const { data: tagAggData } = useAsync(() => getStatsAggregate('tag', {}, 200), []);
  const tagOptions = (tagAggData ?? []).filter((t) => t.key);

  // 日期 → 毫秒时间戳（since 当天 00:00，until 当天 23:59:59.999）；分钟 → 秒；万 → 绝对值
  const since = f.sinceDate ? new Date(f.sinceDate + 'T00:00:00').getTime() : undefined;
  const until = f.untilDate ? new Date(f.untilDate + 'T23:59:59.999').getTime() : undefined;
  const min_duration = f.minDur && Number.isFinite(Number(f.minDur)) ? Math.floor(Number(f.minDur)) * 60 : undefined;
  const max_duration = f.maxDur && Number.isFinite(Number(f.maxDur)) ? Math.floor(Number(f.maxDur)) * 60 : undefined;
  const min_view = f.minView && Number.isFinite(Number(f.minView)) ? Math.floor(Number(f.minView)) * 10000 : undefined;
  const max_view = f.maxView && Number.isFinite(Number(f.maxView)) ? Math.floor(Number(f.maxView)) * 10000 : undefined;

  const queryKey = route.query.toString();
  const { data, loading, error, reload } = useAsync(
    () =>
      listVideos({
        q: f.q || undefined,
        source: f.source || undefined,
        subtitle_q: f.sq || undefined,
        tname: f.tname || undefined,
        tags: f.tag ? [f.tag] : undefined,
        tag_source: f.tagSource ? [f.tagSource] : undefined,
        lang: f.lang || undefined,
        has_subtitle: f.hasSubtitle || undefined,
        date_field: f.dateField,
        since,
        until,
        min_duration,
        max_duration,
        min_view,
        max_view,
        sort: f.sort,
        desc: f.sort ? f.desc : undefined,
        page: f.page,
        size: PAGE_SIZE,
      }),
    [queryKey],
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 折叠态（瞬态 UI,不进 URL）
  const [showMore, setShowMore] = useState(false);

  function resetAll() {
    setQInput('');
    setSqInput('');
    navigate('/videos');
  }

  // 任一次要筛选已激活时，"更多筛选"按钮给个视觉提示
  const secondaryActive = !!(f.tag || f.tagSource || f.lang || f.hasSubtitle || f.sinceDate || f.untilDate || f.minDur || f.maxDur || f.minView || f.maxView);

  // 进详情：URL 附加当前列表 query → 返回时筛选原样还原
  const openVideo = (source: string, sourceVid: string) => {
    const qs = queryKey ? `?${queryKey}` : '';
    navigate(`/videos/${source}/${encodeURIComponent(sourceVid)}${qs}`);
  };

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
          value={f.source || '__all'}
          onValueChange={(v) => setFilter({ source: v === '__all' ? null : v })}
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
          value={sqInput}
          onChange={(e) => setSqInput(e.target.value)}
        />
        <Select
          value={f.tname || '__all'}
          onValueChange={(v) => setFilter({ tname: v === '__all' ? null : v })}
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
            value={f.sort ?? '__default'}
            onValueChange={(v) => setFilter({ sort: v === '__default' ? null : (v as SortField) })}
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
            disabled={!f.sort}
            title={f.desc ? '当前降序，点击切换升序' : '当前升序，点击切换降序'}
            onClick={() => setFilter({ desc: f.desc ? '0' : null })}
          >
            {f.desc ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
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
            value={f.tag || '__all'}
            onValueChange={(v) => setFilter({ tag: v === '__all' ? null : v })}
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
            value={f.tagSource || '__all'}
            onValueChange={(v) => setFilter({ tag_source: v === '__all' ? null : v })}
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
              <SelectItem value="season">合集</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="max-w-[140px]"
            placeholder="语言，如 zh/en"
            value={f.lang}
            onChange={(e) => setFilter({ lang: e.target.value || null })}
          />
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>时长</span>
            <Input
              type="number"
              min={0}
              className="w-20"
              placeholder="最小"
              value={f.minDur}
              onChange={(e) => setFilter({ min_dur: e.target.value || null })}
            />
            <span>~</span>
            <Input
              type="number"
              min={0}
              className="w-20"
              placeholder="最大"
              value={f.maxDur}
              onChange={(e) => setFilter({ max_dur: e.target.value || null })}
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
              value={f.minView}
              onChange={(e) => setFilter({ min_view: e.target.value || null })}
            />
            <span>~</span>
            <Input
              type="number"
              min={0}
              className="w-20"
              placeholder="最大"
              value={f.maxView}
              onChange={(e) => setFilter({ max_view: e.target.value || null })}
            />
            <span>万</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Select value={f.dateField} onValueChange={(v) => setFilter({ date_field: v === 'first_seen' ? null : (v as DateField) })}>
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
              value={f.sinceDate}
              onChange={(e) => setFilter({ since_date: e.target.value || null })}
            />
            <span>~</span>
            <Input
              type="date"
              className="w-36"
              value={f.untilDate}
              onChange={(e) => setFilter({ until_date: e.target.value || null })}
            />
          </div>
          <Button
            variant={f.hasSubtitle ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter({ has_subtitle: f.hasSubtitle ? null : '1' })}
          >
            仅含字幕：{f.hasSubtitle ? '开' : '关'}
          </Button>
        </div>
      )}

      {/* 分页 */}
      <div className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
        <div>第 {f.page}/{totalPages} 页</div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={f.page <= 1} onClick={() => updateQuery({ page: f.page - 1 > 1 ? String(f.page - 1) : null })}>
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={f.page >= totalPages || total === 0}
            onClick={() => updateQuery({ page: String(f.page + 1) })}
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

        {!loading && !error && items.map((v) => <VideoRow key={v.id} v={v} onOpen={openVideo} />)}

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
