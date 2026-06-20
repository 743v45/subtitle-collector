import { useState } from 'react';
import { VideoList } from './pages/VideoList';
import { VideoDetail } from './pages/VideoDetail';

export default function App() {
  const [view, setView] = useState<{ source: string; sourceVid: string } | null>(null);
  return view
    ? <VideoDetail source={view.source} sourceVid={view.sourceVid} onBack={() => setView(null)} />
    : <VideoList onOpen={(s, v) => setView({ source: s, sourceVid: v })} />;
}
