import { useState } from 'react';
import { VideoList } from './pages/VideoList';
import { VideoDetail } from './pages/VideoDetail';
import { ClientsPage } from './pages/ClientsPage';
import { Button } from '@/components/ui/button';

export default function App() {
  const [tab, setTab] = useState<'videos' | 'clients'>('videos');
  const [view, setView] = useState<{ source: string; sourceVid: string } | null>(null);

  return (
    <div className="min-h-screen bg-background">
      <div className="flex gap-1 p-2 border-b">
        <Button variant={tab === 'videos' ? 'default' : 'ghost'} size="sm" onClick={() => setTab('videos')}>视频</Button>
        <Button variant={tab === 'clients' ? 'default' : 'ghost'} size="sm" onClick={() => setTab('clients')}>客户端</Button>
      </div>
      {tab === 'clients'
        ? <ClientsPage />
        : view
          ? <VideoDetail source={view.source} sourceVid={view.sourceVid} onBack={() => setView(null)} />
          : <VideoList onOpen={(s, v) => setView({ source: s, sourceVid: v })} />}
    </div>
  );
}
