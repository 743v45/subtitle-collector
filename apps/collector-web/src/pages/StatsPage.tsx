import { useState } from 'react';
import { getStatsOverview, getStatsAggregate } from '../api';
import { useAsync } from '@/lib/useAsync';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { StatsGroupBy, KeyValue } from '../types';

const GROUP_LABEL: Record<StatsGroupBy, string> = {
  tname: '分区',
  creator: 'UP 主',
  lang: '语言',
  'track-type': '轨类型',
};
const TRACK_TYPE_LABEL: Record<string, string> = { '1': 'AI 字幕', '2': 'CC 字幕' };

// 条形宽度用静态字面量数组（Tailwind JIT 扫描源码字面量识别 w-[X%] 任意值类），
// 避免运行时拼接类名导致 JIT 漏生成；也符合「禁 style={{}} 内联」政策。
const WIDTH_CLASSES = [
  'w-[0%]', 'w-[10%]', 'w-[20%]', 'w-[30%]', 'w-[40%]',
  'w-[50%]', 'w-[60%]', 'w-[70%]', 'w-[80%]', 'w-[90%]', 'w-[100%]',
];

function fmtTime(ms: number | null): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleString();
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

export function StatsPage() {
  const overview = useAsync(() => getStatsOverview(), []);
  const [groupBy, setGroupBy] = useState<StatsGroupBy>('tname');
  const agg = useAsync(() => getStatsAggregate(groupBy), [groupBy]);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">数据看板</h2>

      {/* overview 数字卡 */}
      {overview.loading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[88px]" />)}
        </div>
      )}
      {overview.error && (
        <div className="text-sm text-destructive">
          加载统计失败：{overview.error}{' '}
          <button className="underline" onClick={overview.reload}>重试</button>
        </div>
      )}
      {overview.data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
            <StatCard label="视频" value={overview.data.videos} />
            <StatCard label="字幕轨" value={overview.data.tracks} />
            <StatCard label="字幕版本" value={overview.data.versions} />
            <StatCard label="UP 主" value={overview.data.creators} />
            <StatCard label="语言数" value={overview.data.languages} />
            <StatCard label="分区数" value={overview.data.categories} />
          </div>
          <div className="text-xs text-muted-foreground">
            采集时间范围：{fmtTime(overview.data.first_seen_min)} ~ {fmtTime(overview.data.first_seen_max)}
          </div>
        </>
      )}

      {/* 分组聚合 Top 榜 */}
      <div className="flex gap-1 pt-2">
        {(Object.keys(GROUP_LABEL) as StatsGroupBy[]).map((g) => (
          <Button key={g} variant={groupBy === g ? 'default' : 'outline'} size="sm" onClick={() => setGroupBy(g)}>
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
      <div className="mt-3 space-y-2">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-3 text-sm text-destructive">
        加载失败：{error}{' '}
        <button className="underline" onClick={reload}>重试</button>
      </div>
    );
  }
  if (!data || data.length === 0) {
    return <div className="mt-3 text-sm text-muted-foreground">暂无数据</div>;
  }
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="mt-3 space-y-1.5">
      {data.map((d, i) => {
        const label = groupBy === 'track-type' ? (TRACK_TYPE_LABEL[d.key] ?? d.key) : d.key;
        const widthIdx = Math.min(10, Math.floor((d.count / max) * 10));
        return (
          <div key={i} className="flex items-center gap-3 text-sm">
            <div className="w-40 shrink-0 truncate text-muted-foreground" title={label}>
              <span className="mr-1 tabular-nums">#{i + 1}</span>{label}
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
