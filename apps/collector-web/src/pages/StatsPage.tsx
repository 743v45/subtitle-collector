import { getStatsOverview, getStatsAggregate } from '../api';
import { useAsync } from '@/lib/useAsync';
import { useQueryUpdater, useRoute } from '../router';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PlatformSelect } from '@/components/PlatformSelect';
import { cn } from '@/lib/utils';
import { PlatformIcon, platformIconClass } from '@/components/PlatformIcon';
import type { StatsGroupBy, KeyValue, StatsOverview } from '../types';

const GROUP_LABEL: Record<StatsGroupBy, string> = {
  tname: '分区',
  creator: '创作者',
  lang: '语言',
  'track-type': '轨类型',
  tag: '标签',
  source: '平台',
};
const TRACK_TYPE_LABEL: Record<string, string> = { '1': 'AI 字幕', '2': 'CC 字幕' };
const SOURCE_LABEL: Record<string, string> = { bilibili: '哔哩哔哩', youtube: 'YouTube' };

// 条形宽度用静态字面量数组（Tailwind JIT 扫描源码字面量识别 w-[X%] 任意值类），
// 避免运行时拼接类名导致 JIT 漏生成；也符合「禁 style={{}} 内联」政策。
const WIDTH_CLASSES = [
  'w-[0%]', 'w-[10%]', 'w-[20%]', 'w-[30%]', 'w-[40%]',
  'w-[50%]', 'w-[60%]', 'w-[70%]', 'w-[80%]', 'w-[90%]', 'w-[100%]',
];

function fmtTime(ms: number | null): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('zh-CN');
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tabular-nums">{value.toLocaleString('zh-CN')}</div>
      </CardContent>
    </Card>
  );
}

export function StatsPage() {
  // overview 一次取回 total + by_source，平台筛选本地切换（不发第二次请求）
  const overview = useAsync(() => getStatsOverview(), []);
  // 平台筛选 + 分组维度都进 URL（#/stats?source=bilibili&groupBy=lang），非默认不写
  const route = useRoute();
  const updateQuery = useQueryUpdater();
  const sourceRaw = route.query.get('source');
  const source = sourceRaw === 'bilibili' || sourceRaw === 'youtube' ? sourceRaw : null;
  const groupByRaw = route.query.get('groupBy');
  const groupBy: StatsGroupBy = (Object.keys(GROUP_LABEL) as StatsGroupBy[]).includes(groupByRaw as StatsGroupBy)
    ? (groupByRaw as StatsGroupBy)
    : 'tname';
  const agg = useAsync(() => getStatsAggregate(groupBy, source ? { source } : {}), [groupBy, source]);

  // 平台筛选联动：null=全平台（total），否则取 by_source 小节（无该平台数据时 null → 空态）
  const o: StatsOverview | null = overview.data
    ? (source ? overview.data.by_source[source] ?? null : overview.data.total)
    : null;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold tracking-tight">数据看板</h2>

      {/* 平台筛选（共享 PlatformSelect，对齐 VideoList 三选项） */}
      <PlatformSelect value={source} onChange={(v) => updateQuery({ source: v })} />

      {/* overview 数字卡（随平台筛选联动） */}
      {overview.loading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[88px]" />)}
        </div>
      )}
      {overview.error && (
        <div className="text-sm text-destructive">
          加载统计失败：{overview.error}{' '}
          <button className="cursor-pointer underline" onClick={overview.reload}>重试</button>
        </div>
      )}
      {o && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
            <StatCard label="视频" value={o.videos} />
            <StatCard label="字幕轨" value={o.tracks} />
            <StatCard label="字幕版本" value={o.versions} />
            <StatCard label="创作者" value={o.creators} />
            <StatCard label="语言数" value={o.languages} />
            <StatCard label="分区数" value={o.categories} />
          </div>
          <div className="text-xs text-muted-foreground">
            采集时间范围：{fmtTime(o.first_seen_min)} ~ {fmtTime(o.first_seen_max)}
          </div>
        </>
      )}
      {overview.data && source && !o && (
        <div className="text-sm text-muted-foreground">该平台暂无数据</div>
      )}

      {/* 分组聚合 Top 榜（flex-wrap：375 档 6 个按钮一行放不下会折行,不横滚） */}
      <div className="flex flex-wrap gap-1 pt-2">
        {(Object.keys(GROUP_LABEL) as StatsGroupBy[]).map((g) => (
          <Button key={g} variant={groupBy === g ? 'default' : 'outline'} size="sm" onClick={() => updateQuery({ groupBy: g === 'tname' ? null : g })}>
            按{GROUP_LABEL[g]}
          </Button>
        ))}
      </div>
      <AggregatePanel
        groupBy={groupBy}
        loading={agg.loading}
        error={agg.error}
        data={agg.data}
        reload={agg.reload}
      />
    </div>
  );
}

function AggregatePanel({
  groupBy, loading, error, data, reload,
}: {
  groupBy: StatsGroupBy;
  loading: boolean;
  error: string | null;
  data: KeyValue[] | null;
  reload: () => void;
}) {
  if (loading) {
    return (
      <div className="mt-3 space-y-2" aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-3 text-sm text-destructive">
        加载失败：{error}{' '}
        <button className="cursor-pointer underline" onClick={reload}>重试</button>
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="mt-3 text-sm text-muted-foreground">
        暂无数据——采集入库后这里会出现聚合统计
      </div>
    );
  }
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="mt-3 space-y-1.5">
      {data.map((d, i) => {
        const label = groupBy === 'track-type'
          ? (TRACK_TYPE_LABEL[d.key] ?? d.key)
          : groupBy === 'source'
            ? (SOURCE_LABEL[d.key] ?? d.key)
            : d.key;
        const widthIdx = Math.min(10, Math.floor((d.count / max) * 10));
        return (
          <div key={i} className="flex items-center gap-3 text-sm">
            <div className="flex w-40 shrink-0 items-center gap-1 truncate text-muted-foreground" title={label}>
              <span className="mr-1 tabular-nums">#{i + 1}</span>
              {groupBy === 'source' && (
                <PlatformIcon source={d.key} className={cn('h-3.5 w-3.5', platformIconClass(d.key))} />
              )}
              <span className="min-w-0 truncate">{label}</span>
            </div>
            <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
              <div className={cn('h-full rounded bg-primary/40 transition-all', WIDTH_CLASSES[widthIdx])} />
            </div>
            <div className="w-12 shrink-0 text-right tabular-nums">{d.count}</div>
          </div>
        );
      })}
    </div>
  );
}
