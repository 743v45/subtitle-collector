// 库摘要行（自 CollectPage 抽出，Phase 3 腾行数给搜索卡）：总量 + 今日采集（点击进看板）。
import { Skeleton } from '@/components/ui/skeleton';
import { useAsync } from '@/lib/useAsync';
import { navigate } from '../router';
import { getStatsOverview } from '../api';

export function LibrarySummary({ refreshKey }: { refreshKey: number }) {
  // overview 返回 { total, by_source }（2026-08-24 分平台小节）；摘要行只看全库 total
  const { data } = useAsync(() => getStatsOverview(), [refreshKey]);
  const o = data?.total;
  if (!o) {
    return <Skeleton className="h-9 w-full" />;
  }
  return (
    <button
      onClick={() => navigate('/stats')}
      className="flex w-full cursor-pointer items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span>
        库内 <span className="font-medium tabular-nums text-foreground">{o.videos.toLocaleString('zh-CN')}</span> 视频
        · <span className="font-medium tabular-nums text-foreground">{o.tracks.toLocaleString('zh-CN')}</span> 字幕轨
      </span>
      <span>
        今日 +<span className="font-medium tabular-nums text-foreground">{o.today_videos.toLocaleString('zh-CN')}</span>
      </span>
    </button>
  );
}
