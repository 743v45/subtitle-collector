// 数据看板：overview 数字卡 + 分组聚合 Top 榜。
// 2026-10-05 聚合面板抽至 StatsAggregatePanel.tsx 偿还行数台账；Q7 两项同批落地：
// - 采集时间范围缺失端不再渲染裸 "-"（旧行首 "- ~ 2026-…"），改「最早未知 / 最晚未知」
// - 按分区时展示「已分区覆盖率」徽标 = (1 - 未分区视频数 / 聚合总数) × 100%（1 位小数）
import { getStatsOverview, getStatsAggregate } from '../api';
import { useAsync } from '@/lib/useAsync';
import { useQueryUpdater, useRoute } from '../router';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PlatformSelect } from '@/components/PlatformSelect';
import { parseSourceFilter } from '@/lib/platformSource';
import { StatsAggregatePanel, UNKNOWN_KEY } from './StatsAggregatePanel';
import type { KeyValue, StatsGroupBy, StatsOverview } from '../types';

const GROUP_LABEL: Record<StatsGroupBy, string> = {
  tname: '分区',
  creator: '创作者',
  lang: '语言',
  'track-type': '轨类型',
  tag: '标签',
  source: '平台',
};

// Q7：时间范围端点缺失文案（ms 为 null/0 时）
function fmtRangePoint(ms: number | null, missing: string): string {
  if (!ms) return missing;
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

// overview 区块（数字卡 + 采集时间范围 + 已分区覆盖率徽标，2026-10-05 抽组件偿还 StatsPage
// 圈复杂度台账）。覆盖率只在按分区且聚合非空时算：未分区 = server COALESCE 占位 key（UNKNOWN_KEY）。
function StatsOverviewPanel({
  overview, o, groupBy, agg,
}: {
  overview: { loading: boolean; error: string | null; reload: () => void };
  o: StatsOverview | null;
  groupBy: StatsGroupBy;
  agg: { loading: boolean; error: string | null; data: KeyValue[] | null };
}) {
  const aggItems = groupBy === 'tname' && agg.data && agg.data.length > 0 ? agg.data : null;
  const aggTotal = aggItems ? aggItems.reduce((s, d) => s + d.count, 0) : 0;
  const unknownCount = aggItems ? (aggItems.find((d) => d.key === UNKNOWN_KEY)?.count ?? 0) : 0;
  const coveragePct = aggItems && aggTotal > 0 ? ((1 - unknownCount / aggTotal) * 100).toFixed(1) : null;
  return (
    <>
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
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              采集时间范围：{fmtRangePoint(o.first_seen_min, '最早未知')} ~ {fmtRangePoint(o.first_seen_max, '最晚未知')}
            </span>
            {coveragePct !== null && (
              <Badge
                variant="outline"
                className="tabular-nums"
                title={`未分区 ${unknownCount} / 共 ${aggTotal} 个视频（按当前平台筛选与聚合口径）`}
              >
                已分区覆盖率 {coveragePct}%
              </Badge>
            )}
          </div>
        </>
      )}
    </>
  );
}

export function StatsPage() {
  // overview 一次取回 total + by_source，平台筛选本地切换（不发第二次请求）
  const overview = useAsync(() => getStatsOverview(), []);
  // 平台筛选 + 分组维度都进 URL（#/stats?source=bilibili&groupBy=lang），非默认不写
  const route = useRoute();
  const updateQuery = useQueryUpdater();
  const sourceRaw = route.query.get('source');
  const source = parseSourceFilter(sourceRaw);
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

      {/* overview 数字卡（随平台筛选联动；覆盖率徽标在面板内） */}
      <StatsOverviewPanel overview={overview} o={o} groupBy={groupBy} agg={agg} />
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
      <StatsAggregatePanel
        groupBy={groupBy}
        loading={agg.loading}
        error={agg.error}
        data={agg.data}
        reload={agg.reload}
      />
    </div>
  );
}
