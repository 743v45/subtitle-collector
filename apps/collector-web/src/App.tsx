import { useState } from 'react';
import { VideoList } from './pages/VideoList';
import { VideoDetail } from './pages/VideoDetail';
import { ClientsPage } from './pages/ClientsPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { CreatorsPage } from './pages/CreatorsPage';
import { Button } from '@/components/ui/button';

export default function App() {
  const [tab, setTab] = useState<'videos' | 'clients' | 'categories' | 'creators'>('videos');
  const [view, setView] = useState<{ source: string; sourceVid: string } | null>(null);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
          <h1 className="text-base font-semibold">B站字幕收集</h1>
          <nav className="flex gap-1">
            <Button variant={tab === 'videos' ? 'default' : 'ghost'} size="sm" onClick={() => setTab('videos')}>视频</Button>
            <Button variant={tab === 'clients' ? 'default' : 'ghost'} size="sm" onClick={() => setTab('clients')}>客户端</Button>
            <Button variant={tab === 'categories' ? 'default' : 'ghost'} size="sm" onClick={() => setTab('categories')}>分类</Button>
            <Button variant={tab === 'creators' ? 'default' : 'ghost'} size="sm" onClick={() => setTab('creators')}>UP 主</Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 md:p-6">
        {tab === 'clients'
          ? <ClientsPage />
          : tab === 'categories'
            ? <CategoriesPage />
            : tab === 'creators'
              ? <CreatorsPage />
              : view
                ? <VideoDetail source={view.source} sourceVid={view.sourceVid} onBack={() => setView(null)} />
                : <VideoList onOpen={(s, v) => setView({ source: s, sourceVid: v })} />}
      </main>
    </div>
  );
}
