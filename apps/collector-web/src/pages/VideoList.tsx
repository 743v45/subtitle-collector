import { useEffect, useRef, useState } from 'react';
import { listVideos, getStatsAggregate } from '../api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useAsync } from '@/lib/useAsync';
import { TAG_SOURCE_CLASS, type TagSource } from '@/lib/tagSources';
import { creatorUrl, videoUrl } from '../lib/externalLinks';
import { ExtLink } from '@/components/ExtLink';
import { navigate, useQueryUpdater, useRoute } from '../router';
import { videoListFromQuery } from '../videoFilterUrl';
import { ArrowDown, ArrowUp, Check, ChevronDown, Film, RotateCcw, X } from 'lucide-react';
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
        tags: f.tags.length > 0 ? f.tags : undefined,
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
  const secondaryActive = !!(f.tags.length > 0 || f.tagSource || f.lang || f.hasSubtitle || f.sinceDate || f.untilDate || f.minDur || f.maxDur || f.minView || f.maxView);

  // 进详情：URL 附加当前列表 query → 返回时筛选原样还原
  const openVideo = (source: string, sourceVid: string) => {
    const qs = queryKey ? `?${queryKey}` : '';
    navigate(`/videos/${source}/${encodeURIComponent(sourceVid)}${qs}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">视频库</h2>
        {/* tabular-nums：计数变化时宽度稳定不跳动 */}
        <span className="text-sm text-muted-foreground">
          共 <span className="font-medium tabular-nums text-foreground">{total}</span> 条
        </span>
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
        <Button variant="ghost" size="sm" onClick={() => setShowMore((s) => !s)} aria-expanded={showMore}>
          更多筛选
          <ChevronDown className={cn('h-4 w-4 transition-transform duration-150', showMore && 'rotate-180')} />
          {/* 指示点常驻占位（透明度切换），避免激活时按钮宽度跳动 */}
          <span
            aria-hidden="true"
            className={cn('ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-primary transition-opacity duration-150', secondaryActive ? 'opacity-100' : 'opacity-0')}
          />
        </Button>
        <Button variant="outline" size="sm" onClick={resetAll}>
          <RotateCcw className="h-4 w-4" />
          重置
        </Button>
      </div>

      {/* 次要筛选折叠区 */}
      {showMore && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 p-3">
          {/* 多标签筛选：下拉多选面板（手写受控组件，不引第三方依赖），选中项回显为可 × 移除的 Badge */}
          <TagMultiSelect
            options={tagOptions}
            selected={f.tags}
            onChange={(next) => setFilter({ tags: next.length > 0 ? next.join(',') : null })}
          />
          {f.tags.map((name) => (
            <Badge key={name} variant="secondary" className="gap-1 font-normal">
              {name}
              <button
                type="button"
                aria-label={`移除标签筛选 ${name}`}
                className="-mr-1 flex size-4 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-muted-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setFilter({ tags: f.tags.filter((x) => x !== name).join(',') || null })}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
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
        <div className="tabular-nums">第 {f.page}/{totalPages} 页</div>
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

      {/* 列表区：一行一视频的横向列表（窄屏隐藏次要列，Tailwind 响应式 table-cell），
          loading / error / 空态改造成行式；表头纯展示（排序仍走顶部筛选）。
          容器 rounded+shadow 出卡片质感；表头 muted 底与正文分层 */}
      <div className="overflow-hidden rounded-lg border shadow-sm" aria-busy={loading || undefined}>
        {/* table-fixed：列宽由表头显式声明。标题 38%（1440 容器约 420px）优先保长标题；
            标签列无显式宽吃剩余（~150px，badge 两行）；min-w-[240px] 保底：375px 窄屏只剩
            标题+播放 两列时不至于被压没（240+64+padding < 375 视口，不横滚） */}
        <Table className="table-fixed">
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[96px] pl-3" aria-label="封面" />
              <TableHead className="w-[34%] min-w-[200px]">标题</TableHead>
              <TableHead className="hidden w-32 md:table-cell">创作者</TableHead>
              <TableHead className="w-16 text-right">播放</TableHead>
              <TableHead className="hidden w-16 text-right sm:table-cell">时长</TableHead>
              <TableHead className="hidden w-14 text-right lg:table-cell">轨道</TableHead>
              <TableHead className="hidden w-32 xl:table-cell">发布时间</TableHead>
              <TableHead className="hidden w-20 xl:table-cell">分区</TableHead>
              <TableHead className="hidden md:table-cell">标签</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={`sk-${i}`}>
                  <TableCell className="pl-3"><Skeleton className="h-5 w-full max-w-64" /></TableCell>
                  <TableCell className="hidden md:table-cell"><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="ml-auto h-4 w-10" /></TableCell>
                  <TableCell className="hidden sm:table-cell"><Skeleton className="ml-auto h-4 w-10" /></TableCell>
                  <TableCell className="hidden lg:table-cell"><Skeleton className="ml-auto h-4 w-8" /></TableCell>
                  <TableCell className="hidden xl:table-cell"><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell className="hidden xl:table-cell"><Skeleton className="h-4 w-14" /></TableCell>
                  <TableCell className="hidden md:table-cell"><Skeleton className="h-4 w-24" /></TableCell>
                </TableRow>
              ))}

            {!loading && error && (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center">
                  <div className="text-sm text-destructive">加载失败：{error}</div>
                  <Button variant="outline" size="sm" className="mt-2" onClick={reload}>
                    重试
                  </Button>
                </TableCell>
              </TableRow>
            )}

            {!loading && !error && items.map((v) => <VideoRow key={v.id} v={v} onOpen={openVideo} />)}

            {!loading && !error && items.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center">
                  {/* 空态给行动指引：可能是筛选过严（给重置），也可能是库真没数据（引导去采集） */}
                  {secondaryActive || f.q || f.sq || f.source || f.tname ? (
                    <div className="space-y-1.5">
                      <div className="text-sm text-muted-foreground">没有匹配的视频——试试放宽筛选条件</div>
                      <Button variant="outline" size="sm" onClick={resetAll}>
                        <RotateCcw className="h-4 w-4" />
                        重置筛选
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="text-sm text-muted-foreground">视频库还是空的</div>
                      <Button variant="outline" size="sm" onClick={() => navigate('/collect')}>
                        去采集页提交第一个任务
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── 多标签下拉多选（手写受控面板：button + absolute 定位 div，不新增依赖）──
// 视觉对齐 select.tsx（border rounded-md bg-popover shadow-md）；面板外点击关闭；
// 勾选即回调 onChange（父组件写 URL query），选项带计数。
function TagMultiSelect({ options, selected, onChange }: {
  options: { key: string; count: number }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 面板外 mousedown → 关闭（mousedown 而非 click，避免面板内点击冒泡时序问题）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = (name: string) => {
    onChange(selected.includes(name) ? selected.filter((s) => s !== name) : [...selected, name]);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-9 min-w-[140px] cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-ring',
          open && 'ring-1 ring-ring',
        )}
      >
        <span className={cn('truncate', selected.length === 0 && 'text-muted-foreground')}>
          {selected.length > 0 ? `标签（${selected.length}）` : '标签'}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 opacity-50 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {options.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">暂无标签</div>
          )}
          {options.map((t) => {
            const checked = selected.includes(t.key);
            return (
              <button
                key={t.key}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => toggle(t.key)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors duration-150 hover:bg-accent focus:bg-accent"
              >
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border',
                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                  )}
                >
                  {checked && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate" title={t.key}>{t.key}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t.count}</span>
              </button>
            );
          })}
        </div>
      )}
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
  const iconColor = v.source === 'youtube' ? 'text-red-500' : 'text-[#FB7299]';

  return (
    // 整行点击进详情（onOpen 已附加当前列表 query → 返回原样还原）
    <TableRow onClick={() => onOpen(v.source, v.source_vid)} className="cursor-pointer">
      {/* 封面缩略图（16:10 圆角）：媒体库观感的锚点;无封面回落 Film 占位,懒加载减流量 */}
      <TableCell className="pl-3">
        <div className="flex h-[50px] w-[80px] items-center justify-center overflow-hidden rounded bg-muted">
          {v.pic ? (
            <img
              src={v.pic.replace(/^http:\/\//, 'https://')} /* 老数据存 http: 头,https 站点下会被 mixed content 拦 */
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover transition-transform duration-200 hover:scale-105"
            />
          ) : (
            <Film className="size-4 text-muted-foreground" aria-hidden="true" />
          )}
        </div>
      </TableCell>
      {/* fixed 布局列宽由表头定；单元格内 truncate 需 flex 子项 min-w-0 */}
      <TableCell>
        <div className="flex items-center gap-1.5">
          <PlatformIcon source={v.source} className={cn('h-3.5 w-3.5 shrink-0', iconColor)} />
          <span className="min-w-0 truncate" title={v.title}>{v.title}</span>
          <ExtLink href={videoUrl(v.source, v.source_vid)} label="在原站打开视频" />
        </div>
      </TableCell>
      <TableCell className="hidden truncate text-muted-foreground md:table-cell" title={v.creator_name ?? undefined}>
        {v.creator_name && v.creator_source_uid
          ? <ExtLink href={creatorUrl(v.source, v.creator_source_uid)} label={`在原站打开 ${v.creator_name} 的空间`}>{v.creator_name}</ExtLink>
          : (v.creator_name ?? '—')}
      </TableCell>
      <TableCell className="text-right tabular-nums">{v.view != null ? formatView(v.view) : '—'}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatDuration(v.duration) || '—'}</TableCell>
      <TableCell className="hidden text-right tabular-nums lg:table-cell">{v.track_count}</TableCell>
      <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground xl:table-cell">
        {v.published_at ? formatTs(v.published_at) : '—'}
      </TableCell>
      <TableCell className="hidden xl:table-cell">
        {v.tname ? <Badge variant="secondary">{v.tname}</Badge> : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {tagDetails.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
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
      </TableCell>
    </TableRow>
  );
}
