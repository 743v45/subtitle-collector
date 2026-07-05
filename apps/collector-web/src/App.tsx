import { useState } from 'react';
import { VideoList } from './pages/VideoList';
import { VideoDetail } from './pages/VideoDetail';
import { StatsPage } from './pages/StatsPage';
import { ClientsPage } from './pages/ClientsPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { CreatorsPage } from './pages/CreatorsPage';
import { CreatorDetailPage } from './pages/CreatorDetailPage';
import { Button } from '@/components/ui/button';

type Tab = 'videos' | 'stats' | 'clients' | 'categories' | 'creators';

const TABS: { key: Tab; label: string }[] = [
  { key: 'videos', label: '视频' },
  { key: 'stats', label: '看板' },
  { key: 'creators', label: 'UP 主' },
  { key: 'categories', label: '分类' },
  { key: 'clients', label: '客户端' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('videos');
  const [videoView, setVideoView] = useState<{ source: string; sourceVid: string } | null>(null);
  const [creatorView, setCreatorView] = useState<number | null>(null);

  const switchTab = (t: Tab) => { setTab(t); setVideoView(null); setCreatorView(null); };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
          <h1 className="text-base font-semibold">B站字幕收集</h1>
          <nav className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <Button key={t.key} variant={tab === t.key ? 'default' : 'ghost'} size="sm" onClick={() => switchTab(t.key)}>
                {t.label}
              </Button>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 md:p-6">
        {tab === 'stats' ? (
          <StatsPage />
        ) : tab === 'clients' ? (
          <ClientsPage />
        ) : tab === 'categories' ? (
          <CategoriesPage />
        ) : tab === 'creators' ? (
          creatorView != null
            ? <CreatorDetailPage
                id={creatorView}
                onBack={() => setCreatorView(null)}
                onOpenVideo={(s, v) => { setVideoView({ source: s, sourceVid: v }); setTab('videos'); }}
              />
            : <CreatorsPage onOpen={(id) => setCreatorView(id)} />
        ) : videoView ? (
          <VideoDetail source={videoView.source} sourceVid={videoView.sourceVid} onBack={() => setVideoView(null)} />
        ) : (
          <VideoList onOpen={(s, v) => setVideoView({ source: s, sourceVid: v })} />
        )}
      </main>
    </div>
  );
}
