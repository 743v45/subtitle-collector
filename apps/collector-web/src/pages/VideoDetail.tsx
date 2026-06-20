import { useEffect, useState } from 'react';
import { getVideo, getVersion } from '../api';
import { TrackSwitcher } from '../components/TrackSwitcher';
import { VersionSwitcher } from '../components/VersionSwitcher';
import { SubtitleView, type SubtitleLine } from '../components/SubtitleView';
import { Button } from '@/components/ui/button';
import type { VideoDetail as VD } from '../types';

export function VideoDetail({ source, sourceVid, onBack }: { source: string; sourceVid: string; onBack: () => void }) {
  const [detail, setDetail] = useState<VD | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [body, setBody] = useState<SubtitleLine[]>([]);

  useEffect(() => { getVideo(source, sourceVid).then(d => {
    setDetail(d);
    const def = d.tracks.find(t => t.is_default) ?? d.tracks[0];
    if (def) { setSelectedTrack(def.id); const dv = def.versions.find(v => v.is_default) ?? def.versions[0]; if (dv) setSelectedVersion(dv.id); }
  }); }, [source, sourceVid]);

  useEffect(() => {
    if (!selectedVersion) return;
    getVersion(selectedVersion).then(r => setBody(r.version?.payload?.body ?? []));
  }, [selectedVersion]);

  if (!detail) return <div className="p-4">加载中...</div>;
  const v: any = detail.video;
  const track = detail.tracks.find(t => t.id === selectedTrack);

  return (
    <div className="max-w-3xl space-y-3 p-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-3">← 返回</Button>
      <h2 className="text-xl font-semibold">{v.title}</h2>
      <div className="text-sm text-muted-foreground">{v.creator_name ?? '-'} · {v.extra?.pic && <a href={v.extra.pic} target="_blank" rel="noreferrer" className="underline">封面</a>}</div>
      <TrackSwitcher tracks={detail.tracks} selected={selectedTrack} onSelect={(id) => { setSelectedTrack(id); const t = detail.tracks.find(x => x.id === id); if (t) { const dv = t.versions.find(x => x.is_default) ?? t.versions[0]; setSelectedVersion(dv?.id ?? null); } }} />
      {track && <VersionSwitcher versions={track.versions} selected={selectedVersion} onSelect={setSelectedVersion} />}
      <SubtitleView body={body} />
    </div>
  );
}
