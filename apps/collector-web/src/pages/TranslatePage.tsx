// ── 补翻页（#/translate；CLI translate pending/source 的 web 形态，Phase 1 只读）──
// 一条路由两个视图：query 带 vid 即工作台（#/translate?vid=<source>:<source_vid>&from=<lan>），
// 否则是 pending 清单（#/translate?source=&from=&page=）。URL 唯一真相，刷新/后退还原。
// 视图实现各自成文件（静态台账偿还拆分）：清单 TranslatePendingList、工作台 TranslateWorkbench。
import { useRoute } from '../router';
import { AsrBackfillCard } from './AsrBackfillCard';
import { TranslatePendingList } from './TranslatePendingList';
import { TranslateWorkbench } from './TranslateWorkbench';
import { RecentJobs } from '@/components/RecentJobs';

export function TranslatePage() {
  const route = useRoute();
  const vid = route.query.get('vid');
  return vid ? (
    <TranslateWorkbench vid={vid} from={route.query.get('from') ?? ''} />
  ) : (
    // 清单分支 = 提交卡（ASR 兜底）+ 最近 jobs 台账 + 既有 pending 清单；工作台视图不受影响
    <div className="space-y-4">
      <AsrBackfillCard />
      <RecentJobs />
      <TranslatePendingList />
    </div>
  );
}
