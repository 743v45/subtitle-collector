import { useEffect, useState } from 'react';
import { getVideo, getVersion } from '../api';
import { useAsync } from '@/lib/useAsync';
import { TrackSwitcher } from '@/components/TrackSwitcher';
import { VersionSwitcher } from '@/components/VersionSwitcher';
import { SubtitleView, type SubtitleLine } from '@/components/SubtitleView';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { VideoStat } from '../types';

function fmtDuration(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtTime(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  return new Date(ms).toLocaleString();
}
function fmtNum(n: number | undefined): string {
  return n != null ? n.toLocaleString() : '-';
}
function copyrightLabel(c: number | undefined): string | null {
  if (c == null) return null;
  if (c === 1) return '自制';
  if (c === 2) return '转载';
  return String(c);
}

export function VideoDetail({ source, sourceVid, onBack }: { source: string; sourceVid: string; onBack: () => void }) {
  const detailQ = useAsync(() => getVideo(source, sourceVid), [source, sourceVid]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // selectedVersion 为 null 时 resolve(null)（无版本可加载），useAsync 走完 loading→data:null
  const bodyQ = useAsync(
    () => selectedVersion != null ? getVersion(selectedVersion) : Promise.resolve(null),
    [selectedVersion],
  );

  // 详情就绪后选中默认轨 + 默认版本
  useEffect(() => {
    if (!detailQ.data) return;
    const def = detailQ.data.tracks.find((t) => t.is_default) ?? detailQ.data.tracks[0];
    if (def) {
      setSelectedTrack(def.id);
      const dv = def.versions.find((x) => x.is_default) ?? def.versions[0];
      setSelectedVersion(dv?.id ?? null);
    }
  }, [detailQ.data]);

  if (detailQ.loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}>← 返回</Button>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (detailQ.error) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}>← 返回</Button>
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">
            加载失败：{detailQ.error}{' '}
            <button className="underline" onClick={detailQ.reload}>重试</button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!detailQ.data) return null;

  const v = detailQ.data.video;
  const tracks = detailQ.data.tracks;
  const track = tracks.find((t) => t.id === selectedTrack);
  const duration = fmtDuration(v.duration);
  const e = v.extra;
  const stat: VideoStat | undefined = e?.stat;
  const tags = e?.tags ?? [];
  const published = fmtTime(v.published_at);

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}>← 返回</Button>
      <h1 className="text-2xl font-semibold tracking-tight">{v.title}</h1>

      {/* 基础元信息 */}
      <Card className="bg-muted/30">
        <CardContent className="grid grid-cols-2 gap-3 p-4 text-sm sm:grid-cols-3 md:grid-cols-4">
          <Field label="作者" value={v.creator_name ?? '-'} />
          <Field label="时长" value={duration ?? '-'} />
          <Field label="来源ID" value={sourceVid} mono />
          <Field label="发布时间" value={published ?? '-'} />
          <Field label="分区" value={e?.tname ?? '-'} />
          <Field label="版权" value={copyrightLabel(e?.copyright) ?? '-'} />
          <Field label="P 数" value={e?.pages?.length != null ? String(e.pages.length) : '-'} />
          <Field label="状态" value={v.status ?? '-'} />
          <div className="col-span-2 sm:col-span-3 md:col-span-4">
            <div className="text-xs text-muted-foreground">封面</div>
            <div>{e?.pic ? <a href={e.pic} target="_blank" rel="noreferrer" className="underline">查看</a> : '-'}</div>
          </div>
        </CardContent>
      </Card>

      {/* 标签 */}
      {tags.length > 0 && (
        <Card>
          <CardContent className="flex flex-wrap gap-1.5 p-4">
            {tags.map((t, i) => <Badge key={i} variant="secondary">{t.tag_name}</Badge>)}
          </CardContent>
        </Card>
      )}

      {/* 统计 */}
      {stat && (
        <Card>
          <CardContent className="grid grid-cols-3 gap-2 p-4 text-sm sm:grid-cols-4 md:grid-cols-7">
            <Stat label="播放" value={fmtNum(stat.view)} />
            <Stat label="点赞" value={fmtNum(stat.like)} />
            <Stat label="投币" value={fmtNum(stat.coin)} />
            <Stat label="收藏" value={fmtNum(stat.favorite)} />
            <Stat label="转发" value={fmtNum(stat.share)} />
            <Stat label="弹幕" value={fmtNum(stat.danmaku)} />
            <Stat label="回复" value={fmtNum(stat.reply)} />
          </CardContent>
        </Card>
      )}

      {/* 简介 */}
      {e?.desc && (
        <Card>
          <CardContent className="whitespace-pre-wrap p-4 text-sm text-muted-foreground">{e.desc}</CardContent>
        </Card>
      )}

      {/* 字幕轨 / 版本 / 正文 */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">字幕轨</h3>
        <TrackSwitcher
          tracks={tracks}
          selected={selectedTrack}
          onSelect={(id) => {
            setSelectedTrack(id);
            const t = tracks.find((x) => x.id === id);
            if (t) {
              const dv = t.versions.find((x) => x.is_default) ?? t.versions[0];
              setSelectedVersion(dv?.id ?? null);
            }
          }}
        />
      </section>
      {track && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">版本</h3>
          <VersionSwitcher versions={track.versions} selected={selectedVersion} onSelect={setSelectedVersion} />
        </section>
      )}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">字幕正文</h3>
        {bodyQ.loading && <Skeleton className="h-40" />}
        {bodyQ.error && (
          <div className="text-sm text-destructive">
            字幕加载失败：{bodyQ.error}{' '}
            <button className="underline" onClick={bodyQ.reload}>重试</button>
          </div>
        )}
        {!bodyQ.loading && !bodyQ.error && (
          <SubtitleView body={(bodyQ.data?.version?.payload?.body ?? []) as SubtitleLine[]} />
        )}
      </section>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={mono ? 'truncate font-mono' : 'truncate'}>{value}</div>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}
