import { useState } from 'react';
import { CollectPage } from './pages/CollectPage';
import { VideoList } from './pages/VideoList';
import { VideoDetail } from './pages/VideoDetail';
import { StatsPage } from './pages/StatsPage';
import { ClientsPage } from './pages/ClientsPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { TagsPage } from './pages/TagsPage';
import { CreatorsPage } from './pages/CreatorsPage';
import { CreatorDetailPage } from './pages/CreatorDetailPage';
import { ChangesLog } from './pages/ChangesLog';
import { TasksHistoryPage } from './pages/TasksHistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { navigate, useRoute, type Tab } from './router';
import {
  BarChart3, Captions, Film, FolderTree, History, Inbox, MonitorSmartphone, MoreHorizontal, ScrollText, Settings, Tags, Users,
  type LucideIcon,
} from 'lucide-react';

// 导航分级（2026-08-22 大改造：暗色媒体库 + 侧边栏）：
// 桌面侧栏按 NAV_GROUPS 分组展示全量入口；移动端底部 bar 只放高频 3 格,低频格收进「更多」弹层。
const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'collect', label: '采集', icon: Inbox },
  { key: 'history', label: '历史', icon: History },
  { key: 'videos', label: '视频', icon: Film },
  { key: 'stats', label: '看板', icon: BarChart3 },
  { key: 'creators', label: '创作者', icon: Users },
  { key: 'categories', label: '创作者分类', icon: FolderTree },
  { key: 'tags', label: '标签', icon: Tags },
  { key: 'clients', label: '客户端', icon: MonitorSmartphone },
  { key: 'changes', label: '日志', icon: ScrollText },
  { key: 'settings', label: '设置', icon: Settings },
];
const PRIMARY_KEYS: ReadonlySet<Tab> = new Set(['collect', 'videos', 'stats']);
const PRIMARY_TABS = TABS.filter((t) => PRIMARY_KEYS.has(t.key));
const SECONDARY_TABS = TABS.filter((t) => !PRIMARY_KEYS.has(t.key));

// 桌面侧栏分组：工作流（日常操作）→ 内容组织（库的维度）→ 系统（运维）
const NAV_GROUPS: { title: string; keys: readonly Tab[] }[] = [
  { title: '工作流', keys: ['collect', 'history', 'videos'] },
  { title: '内容组织', keys: ['creators', 'categories', 'tags'] },
  { title: '系统', keys: ['stats', 'clients', 'changes', 'settings'] },
];
const NAV_BY_KEY = new Map(TABS.map((t) => [t.key, t]));

// 品牌头：主色 logo 方块 + 双行字（侧栏顶部 / 移动顶栏共用）
function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => navigate('/videos')}
      aria-label="回到视频库"
      className="flex cursor-pointer items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Captions className="size-[18px]" aria-hidden="true" />
      </span>
      <span className="flex flex-col items-start leading-none">
        <span className="text-[15px] font-bold tracking-tight">字幕采集</span>
        {!compact && <span className="mt-1 text-[10px] text-muted-foreground">Subtitle Collector</span>}
      </span>
    </button>
  );
}

export default function App() {
  // 路由即状态：tab / 视频详情 / 创作者详情全来自 URL hash,刷新/分享/后退天然还原
  const route = useRoute();
  const { tab, videoView, creatorView } = route;
  const [moreOpen, setMoreOpen] = useState(false);

  const switchTab = (t: Tab) => navigate(`/${t}`);

  // 视频详情的 query 即进入前的列表筛选（onOpen 时附加）→ 返回列表原样还原；
  // track/ver 是详情页的轨/版本选择参数（VideoDetail 写入），返回列表时剥离不带回去
  const backQuery = new URLSearchParams(route.query);
  backQuery.delete('track');
  backQuery.delete('ver');
  const listQs = backQuery.toString();

  const page = tab === 'history' ? (
    <TasksHistoryPage />
  ) : tab === 'collect' ? (
    <CollectPage />
  ) : tab === 'stats' ? (
    <StatsPage />
  ) : tab === 'clients' ? (
    <ClientsPage />
  ) : tab === 'categories' ? (
    <CategoriesPage />
  ) : tab === 'tags' ? (
    <TagsPage />
  ) : tab === 'changes' ? (
    <ChangesLog />
  ) : tab === 'settings' ? (
    <SettingsPage />
  ) : tab === 'creators' ? (
    creatorView != null
      ? <CreatorDetailPage
          id={creatorView}
          onBack={() => navigate('/creators')}
          onOpenVideo={(s, v) => navigate(`/videos/${s}/${encodeURIComponent(v)}`)}
        />
      : <CreatorsPage onOpen={(id) => navigate(`/creators/${id}`)} />
  ) : videoView ? (
    <VideoDetail source={videoView.source} sourceVid={videoView.sourceVid} onBack={() => navigate('/videos' + (listQs ? `?${listQs}` : ''))} />
  ) : (
    <VideoList />
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="flex">
        {/* 桌面侧边栏：全高 sticky,分组导航;移动端藏,由顶部品牌行+底部 bar 接管 */}
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r bg-card/60 md:flex">
          <div className="px-5 pb-4 pt-5">
            <Brand />
          </div>
          <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-6" aria-label="主导航">
            {NAV_GROUPS.map((g) => (
              <div key={g.title}>
                <div className="px-2.5 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {g.title}
                </div>
                <div className="space-y-0.5">
                  {g.keys.map((key) => {
                    const t = NAV_BY_KEY.get(key)!;
                    return (
                      <button
                        key={t.key}
                        onClick={() => switchTab(t.key)}
                        aria-current={tab === t.key ? 'page' : undefined}
                        className={cn(
                          'flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                          tab === t.key
                            ? 'bg-primary/15 font-medium text-primary'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <t.icon className="size-4 shrink-0" aria-hidden="true" />
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          {/* 移动顶栏：品牌单行（桌面品牌在侧栏,此栏隐藏） */}
          <header className="sticky top-0 z-40 border-b bg-card/85 backdrop-blur supports-[backdrop-filter]:bg-card/70 md:hidden">
            <div className="flex items-center px-4 py-3">
              <Brand compact />
            </div>
          </header>
          {/* pb-24 给底部 bar + iPhone 安全区让位;md 起恢复常规留白;侧栏布局下内容自适应剩余宽度 */}
          <main className="p-4 pb-24 md:p-6 md:pb-8">{page}</main>
        </div>
      </div>

      {/* 移动端底部导航：高频 3 格 + 更多 */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden" aria-label="主导航">
        <div className="mx-auto flex max-w-md">
          {PRIMARY_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => switchTab(t.key)}
              aria-current={tab === t.key ? 'page' : undefined}
              className={cn(
                'flex flex-1 cursor-pointer flex-col items-center gap-0.5 rounded-sm py-2 text-[10px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                tab === t.key ? 'font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <t.icon className="h-5 w-5" aria-hidden="true" />
              {t.label}
            </button>
          ))}
          <button
            onClick={() => setMoreOpen(true)}
            aria-label="更多入口"
            className={cn(
              'flex flex-1 cursor-pointer flex-col items-center gap-0.5 rounded-sm py-2 text-[10px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              SECONDARY_TABS.some((t) => t.key === tab) ? 'font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
            更多
          </button>
        </div>
        {/* viewport-fit=cover 下 iPhone 小黑条安全区 */}
        <div className="h-[env(safe-area-inset-bottom)]" />
      </nav>

      {/* 「更多」弹层：底部 sheet 样式,网格列出低频入口 */}
      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent className="top-auto bottom-0 max-w-none translate-x-0 translate-y-0 rounded-t-lg p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <DialogHeader>
            <DialogTitle>更多</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-3">
            {SECONDARY_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => { switchTab(t.key); setMoreOpen(false); }}
                aria-current={tab === t.key ? 'page' : undefined}
                className={cn(
                  'flex cursor-pointer flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  tab === t.key ? 'border-primary bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted',
                )}
              >
                <t.icon className="h-5 w-5" aria-hidden="true" />
                {t.label}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
