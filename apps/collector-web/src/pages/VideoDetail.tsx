import { useEffect, useState } from 'react';
import { getVideo, getVersion } from '../api';
import { TrackSwitcher } from '../components/TrackSwitcher';
import { VersionSwitcher } from '../components/VersionSwitcher';
import { SubtitleView, type SubtitleLine } from '../components/SubtitleView';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { VideoDetail as VD } from '../types';

function fmtDuration(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function VideoDetail({ source, sourceVid, onBack }: { source: string; sourceVid: string; onBack: () => void }) {
  const [detail, setDetail] = useState<VD | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [body, setBody] = useState<SubtitleLine[]>([]);

  useEffect(() => {
    setDetail(null); setError(null);
    getVideo(source, sourceVid)
      .then(d => {
        setDetail(d);
        const def = d.tracks.find(t => t.is_default) ?? d.tracks[0];
        if (def) { setSelectedTrack(def.id); const dv = def.versions.find(v => v.is_default) ?? def.versions[0]; if (dv) setSelectedVersion(dv.id); }
      })
      .catch(e => setError(e?.message ?? '加载失败'));
  }, [source, sourceVid]);

  useEffect(() => {
    if (!selectedVersion) return;
    getVersion(selectedVersion)
      .then(r => setBody(r.version?.payload?.body ?? []))
      .catch(() => setBody([]));
  }, [selectedVersion]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}>← 返回</Button>
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">加载失败：{error}</CardContent>
        </Card>
      </div>
    );
  }
  if (!detail) return <div className="p-4">加载中...</div>;
  const v = detail.video;
  const track = detail.tracks.find(t => t.id === selectedTrack);
  const duration = fmtDuration(v.duration);

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}>← 返回</Button>
      <h1 className="text-2xl font-semibold tracking-tight">{v.title}</h1>
      <Card className="bg-muted/30">
        <CardContent className="grid grid-cols-2 gap-2 p-4 text-sm text-muted-foreground sm:grid-cols-4">
          <div>
            <div className="text-xs">作者</div>
            <div className="truncate">{v.creator_name ?? '-'}</div>
          </div>
          <div>
            <div className="text-xs">时长</div>
            <div>{duration ?? '-'}</div>
          </div>
          <div>
            <div className="text-xs">来源ID</div>
            <div className="truncate font-mono">{sourceVid}</div>
          </div>
          <div>
            <div className="text-xs">封面</div>
            <div>{v.extra?.pic ? <a href={v.extra.pic} target="_blank" rel="noreferrer" className="underline">查看</a> : '-'}</div>
          </div>
        </CardContent>
      </Card>
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">字幕轨</h3>
        <TrackSwitcher tracks={detail.tracks} selected={selectedTrack} onSelect={(id) => { setSelectedTrack(id); const t = detail.tracks.find(x => x.id === id); if (t) { const dv = t.versions.find(x => x.is_default) ?? t.versions[0]; setSelectedVersion(dv?.id ?? null); } }} />
      </section>
      {track && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">版本</h3>
          <VersionSwitcher versions={track.versions} selected={selectedVersion} onSelect={setSelectedVersion} />
        </section>
      )}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">字幕正文</h3>
        <SubtitleView body={body} />
      </section>
    </div>
  );
}
