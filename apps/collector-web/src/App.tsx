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
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { navigate, useRoute, type Tab } from './router';
import {
  BarChart3, Film, FolderTree, History, Inbox, MonitorSmartphone, MoreHorizontal, ScrollText, Settings, Tags, Users,
  type LucideIcon,
} from 'lucide-react';

// 导航分级：移动端底部 bar 只放高频 3 格,低频格收进「更多」弹层;桌面顶部单行全量。
const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'collect', label: '采集', icon: Inbox },
  { key: 'history', label: '历史', icon: History },
  { key: 'videos', label: '视频', icon: Film },
  { key: 'stats', label: '看板', icon: BarChart3 },
  { key: 'creators', label: '创作者', icon: Users },
  { key: 'categories', label: '分类', icon: FolderTree },
  { key: 'tags', label: '标签', icon: Tags },
  { key: 'clients', label: '客户端', icon: MonitorSmartphone },
  { key: 'changes', label: '日志', icon: ScrollText },
  { key: 'settings', label: '设置', icon: Settings },
];
const PRIMARY_KEYS: ReadonlySet<Tab> = new Set(['collect', 'videos', 'stats']);
const PRIMARY_TABS = TABS.filter((t) => PRIMARY_KEYS.has(t.key));
const SECONDARY_TABS = TABS.filter((t) => !PRIMARY_KEYS.has(t.key));

export default function App() {
  // 路由即状态：tab / 视频详情 / 创作者详情全来自 URL hash,刷新/分享/后退天然还原
  const route = useRoute();
  const { tab, videoView, creatorView } = route;
  const [moreOpen, setMoreOpen] = useState(false);

  const switchTab = (t: Tab) => navigate(`/${t}`);

  // 视频详情的 query 即进入前的列表筛选（onOpen 时附加）→ 返回列表原样还原
  const listQs = route.query.toString();

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
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <h1 className="text-base font-semibold">B站字幕收集</h1>
          {/* 桌面：顶部单行全量 tab（移动端藏,由底部 bar 接管） */}
          <nav className="hidden flex-wrap gap-1 md:flex">
            {TABS.map((t) => (
              <Button key={t.key} variant={tab === t.key ? 'default' : 'ghost'} size="sm" onClick={() => switchTab(t.key)}>
                {t.label}
              </Button>
            ))}
          </nav>
        </div>
      </header>
      {/* pb-24 给底部 bar + iPhone 安全区让位;md 起恢复常规留白 */}
      <main className="mx-auto max-w-6xl p-4 pb-24 md:p-6 md:pb-6">{page}</main>

      {/* 移动端底部导航：高频 3 格 + 更多 */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background md:hidden">
        <div className="mx-auto flex max-w-md">
          {PRIMARY_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => switchTab(t.key)}
              className={cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px]',
                tab === t.key ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <t.icon className="h-5 w-5" />
              {t.label}
            </button>
          ))}
          <button
            onClick={() => setMoreOpen(true)}
            aria-label="更多入口"
            className={cn(
              'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px]',
              SECONDARY_TABS.some((t) => t.key === tab) ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <MoreHorizontal className="h-5 w-5" />
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
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs',
                  tab === t.key ? 'border-primary text-primary' : 'text-muted-foreground',
                )}
              >
                <t.icon className="h-5 w-5" />
                {t.label}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
