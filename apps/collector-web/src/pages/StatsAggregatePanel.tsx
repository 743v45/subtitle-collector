// 看板聚合面板（2026-10-05 自 StatsPage.tsx 抽出，偿还行数台账；Q7 Top10+其他 同批落地）。
// - track-type / source 的 key 翻译；条形宽度用静态字面量数组（Tailwind JIT 扫描源码字面量
//   识别 w-[X%] 任意值类，避免运行时拼接漏生成；也符合「禁 style={{}} 内联」政策）。
// - Q7：按分区（tname）且条目超过 TOP_N 时，Top 10 之外的余量聚合为
//   「其他（M 个分区 · K 个视频）」行（无排名号；条宽与 Top 行同尺度，避免视觉跳变）。
//   注意：server 聚合默认 topN=20，本聚合作用于响应内余量（第 11 行起的尾部），非全量分区。
import { Skeleton } from '@/components/ui/skeleton';
import { PlatformIcon, platformIconClass } from '@/components/PlatformIcon';
import { cn } from '@/lib/utils';
import type { StatsGroupBy, KeyValue } from '../types';

// server 聚合对未分区视频的 COALESCE 占位 key（db/advanced.ts）；StatsPage 用它算已分区覆盖率
export const UNKNOWN_KEY = '(unknown)';

// Q7：按分区时最多直出的条数，其余聚合进「其他」行
const TOP_N = 10;

const TRACK_TYPE_LABEL: Record<string, string> = { '1': 'AI 字幕', '2': 'CC 字幕' };
const SOURCE_LABEL: Record<string, string> = { bilibili: '哔哩哔哩', youtube: 'YouTube', douyin: '抖音' };

// 条形宽度：Math.floor(count / max * 10) 落在 0..10，对应下面 11 档
const WIDTH_CLASSES = [
  'w-[0%]', 'w-[10%]', 'w-[20%]', 'w-[30%]', 'w-[40%]',
  'w-[50%]', 'w-[60%]', 'w-[70%]', 'w-[80%]', 'w-[90%]', 'w-[100%]',
];

function aggLabel(groupBy: StatsGroupBy, key: string): string {
  if (groupBy === 'track-type') return TRACK_TYPE_LABEL[key] ?? key;
  if (groupBy === 'source') return SOURCE_LABEL[key] ?? key;
  return key;
}

function AggRow({ rank, label, sourceKey, count, max }: {
  rank: number | null;   // null = 「其他」聚合行（无排名号）
  label: string;
  sourceKey: string | null; // groupBy=source 时传 key 渲染平台图标
  count: number;
  max: number;
}) {
  const widthIdx = Math.min(10, Math.floor((count / max) * 10));
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="flex w-40 shrink-0 items-center gap-1 truncate text-muted-foreground" title={label}>
        {rank != null && <span className="mr-1 tabular-nums">#{rank}</span>}
        {sourceKey && <PlatformIcon source={sourceKey} className={cn('h-3.5 w-3.5', platformIconClass(sourceKey))} />}
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
        <div className={cn('h-full rounded bg-primary/40 transition-all', WIDTH_CLASSES[widthIdx])} />
      </div>
      <div className="w-12 shrink-0 text-right tabular-nums">{count}</div>
    </div>
  );
}

export function StatsAggregatePanel({
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
  // Q7 Top10 切片（仅 tname）：max 用全量数据算，「其他」行条宽与 Top 行同一尺度
  let visible = data;
  let rest: { groups: number; videos: number } | null = null;
  if (groupBy === 'tname' && data.length > TOP_N) {
    visible = data.slice(0, TOP_N);
    rest = { groups: data.length - TOP_N, videos: data.slice(TOP_N).reduce((s, d) => s + d.count, 0) };
  }
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="mt-3 space-y-1.5">
      {visible.map((d, i) => (
        <AggRow
          key={`${d.key}-${i}`}
          rank={i + 1}
          label={aggLabel(groupBy, d.key)}
          sourceKey={groupBy === 'source' ? d.key : null}
          count={d.count}
          max={max}
        />
      ))}
      {rest && (
        <AggRow
          rank={null}
          label={`其他（${rest.groups} 个分区 · ${rest.videos} 个视频）`}
          sourceKey={null}
          count={rest.videos}
          max={max}
        />
      )}
    </div>
  );
}
