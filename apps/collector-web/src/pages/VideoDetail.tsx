import { useEffect, useState } from 'react';
import { getVideo, getVersion, videoApplyTags, videoRemoveTags } from '../api';
import { useAsync } from '@/lib/useAsync';
import { TrackSwitcher } from '@/components/TrackSwitcher';
import { VersionSwitcher } from '@/components/VersionSwitcher';
import { SubtitleView, type SubtitleLine } from '@/components/SubtitleView';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useQueryUpdater, useRoute } from '../router';
import { TAG_SOURCE_CLASS, TAG_SOURCE_LABEL, type TagSource } from '@/lib/tagSources';
import { creatorUrl, videoUrl } from '../lib/externalLinks';
import { ExtLink } from '@/components/ExtLink';
import { ArrowLeft, ExternalLink, Loader2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { VideoStat } from '../types';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtDuration(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtTime(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  return new Date(ms).toLocaleString('zh-CN');
}
function fmtNum(n: number | undefined): string {
  return n != null ? n.toLocaleString('zh-CN') : '-';
}
function copyrightLabel(c: number | undefined): string | null {
  if (c == null) return null;
  if (c === 1) return '自制';
  if (c === 2) return '转载';
  return String(c);
}

export function VideoDetail({ source, sourceVid, onBack }: { source: string; sourceVid: string; onBack: () => void }) {
  const toast = useToast();
  // URL 复现：非默认轨/版本选择进 query（#/videos/bilibili/BV…?track=12&ver=45，与带入的
  // 列表筛选参数共存同一 query），刷新/分享/后退还原；无参数回落默认轨+默认版本（默认值省略
  // 不写 URL）。UI 选择只写 query（单向数据流），state 一律由下方 effect 从 query 派生。
  const route = useRoute();
  const updateQuery = useQueryUpdater();
  const detailQ = useAsync(() => getVideo(source, sourceVid), [source, sourceVid]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // selectedVersion 为 null 时 resolve(null)（无版本可加载），useAsync 走完 loading→data:null
  const bodyQ = useAsync(
    () => selectedVersion != null ? getVersion(selectedVersion) : Promise.resolve(null),
    [selectedVersion],
  );

  const trackParam = route.query.get('track');
  const verParam = route.query.get('ver');
  const trackRaw = trackParam != null ? Number(trackParam) : NaN;
  const verRaw = verParam != null ? Number(verParam) : NaN;

  // 详情就绪后按 query 选轨/版本；无/非法参数选默认。打标 reload（data 新对象、id 不变）时
  // 已有选择仍有效则保持，不重置用户选择。
  useEffect(() => {
    if (!detailQ.data) return;
    const tracks = detailQ.data.tracks;
    // track 参数命中已加载轨 → 选中它；ver 参数在该轨下有效 → 该版本，否则该轨默认版本
    const urlTrack = Number.isInteger(trackRaw) ? tracks.find((t) => t.id === trackRaw) : undefined;
    if (urlTrack) {
      setSelectedTrack(urlTrack.id);
      if (Number.isInteger(verRaw) && urlTrack.versions.some((x) => x.id === verRaw)) {
        setSelectedVersion(verRaw);
      } else {
        const dv = urlTrack.versions.find((x) => x.is_default) ?? urlTrack.versions[0];
        setSelectedVersion(dv?.id ?? null);
      }
      return;
    }
    if (selectedTrack != null && tracks.some((t) => t.id === selectedTrack)) return;
    const def = tracks.find((t) => t.is_default) ?? tracks[0];
    if (def) {
      setSelectedTrack(def.id);
      const dv = def.versions.find((x) => x.is_default) ?? def.versions[0];
      setSelectedVersion(dv?.id ?? null);
    }
  }, [detailQ.data, trackRaw, verRaw]); // eslint-disable-line react-hooks/exhaustive-deps -- selectedTrack 仅作「已有有效选择不重置」判断,进 deps 会自激

  // 打标表单：新标签名（逗号分隔多个）；removingTag 标记正在移除的 `source:name`
  const [newTagNames, setNewTagNames] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingTag, setRemovingTag] = useState<string | null>(null);

  // 添加标签（手动档，逗号分隔多个）
  async function onAddTags() {
    const names = newTagNames.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return;
    setAdding(true);
    try {
      await videoApplyTags(source, sourceVid, names, 'manual');
      toast('已添加标签', 'success');
      setNewTagNames('');
      detailQ.reload();
    } catch (e: unknown) {
      toast(`添加标签失败：${errMsg(e)}`, 'error');
    } finally {
      setAdding(false);
    }
  }

  // 移除单个标签（按对应档位；bili 档视频自带、不可移除）
  async function onRemoveTag(name: string, tagSource: TagSource) {
    setRemovingTag(`${tagSource}:${name}`);
    try {
      await videoRemoveTags(source, sourceVid, name, tagSource);
      toast('已移除标签', 'success');
      detailQ.reload();
    } catch (e: unknown) {
      toast(`移除标签失败：${errMsg(e)}`, 'error');
    } finally {
      setRemovingTag(null);
    }
  }

  if (detailQ.loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3" aria-busy="true">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          返回
        </Button>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (detailQ.error) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          返回
        </Button>
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">
            加载失败：{detailQ.error}{' '}
            <button className="cursor-pointer underline" onClick={detailQ.reload}>重试</button>
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
  const tagDetails = detailQ.data.tag_details ?? [];
  const published = fmtTime(v.published_at);

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-4" aria-hidden="true" />
        返回
      </Button>
      <div className="flex items-start justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{v.title}</h1>
        {/* 原站外链：asChild 把 button 样式落到 a 上，新标签打开视频页 */}
        <Button variant="outline" size="sm" asChild className="shrink-0 gap-1">
          <a href={videoUrl(source, sourceVid)} target="_blank" rel="noopener noreferrer">
            原站打开
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </Button>
      </div>

      {/* 基础元信息 */}
      <Card className="bg-muted/30">
        <CardContent className="grid grid-cols-2 gap-3 p-4 text-sm sm:grid-cols-3 md:grid-cols-4">
          <Field label="作者" value={v.creator_name ?? '-'}>
            {v.creator_name && v.creator_source_uid
              ? <ExtLink href={creatorUrl(source, v.creator_source_uid)} label={`在原站打开 ${v.creator_name} 的空间`}>{v.creator_name}</ExtLink>
              : (v.creator_name ?? '-')}
          </Field>
          <Field label="时长" value={duration ?? '-'} />
          <Field label="来源ID" value={sourceVid} mono />
          <Field label="发布时间" value={published ?? '-'} />
          {source === 'bilibili' && <Field label="分区" value={e?.tname ?? '-'} />}
          {source === 'bilibili' && <Field label="版权" value={copyrightLabel(e?.copyright) ?? '-'} />}
          {source === 'bilibili' && <Field label="P 数" value={e?.pages?.length != null ? String(e.pages.length) : '-'} />}
        </CardContent>
      </Card>

      {/* 标签（五档带色全展示不去重；manual/batch/ai 可增删，bili/season 为视频自带只读） */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {tagDetails.length === 0 && (
              <span className="text-sm text-muted-foreground">暂无标签——在下方输入框添加，多个用逗号分隔</span>
            )}
            {tagDetails.map((t, i) => {
              const busy = removingTag === `${t.source}:${t.name}`;
              return (
                <Badge
                  key={`${t.source}:${t.name}:${i}`}
                  variant="outline"
                  title={`${TAG_SOURCE_LABEL[t.source]}标签`}
                  className={TAG_SOURCE_CLASS[t.source]}
                >
                  {t.name}
                  {t.source !== 'bili' && t.source !== 'season' && (
                    <button
                      type="button"
                      aria-label={`移除标签 ${t.name}`}
                      title={`移除标签 ${t.name}`}
                      className="ml-1 flex size-3.5 cursor-pointer items-center justify-center rounded-full leading-none opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={busy || adding}
                      onClick={() => onRemoveTag(t.name, t.source)}
                    >
                      {busy ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
                    </button>
                  )}
                </Badge>
              );
            })}
          </div>
          <div className="flex gap-2">
            <Input
              className="max-w-xs"
              placeholder="新标签名，多个用逗号分隔（记为手动档）"
              value={newTagNames}
              onChange={(ev) => setNewTagNames(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === 'Enter') onAddTags(); }}
              disabled={adding}
            />
            <Button size="sm" onClick={onAddTags} disabled={adding || !newTagNames.trim()}>
              {adding ? '添加中…' : '添加'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 统计 */}
      {stat && (
        <Card>
          <CardContent className="grid grid-cols-3 gap-2 p-4 text-sm sm:grid-cols-4 md:grid-cols-7">
            <Stat label="播放" value={fmtNum(stat.view)} />
            <Stat label="点赞" value={fmtNum(stat.like)} />
            {source === 'bilibili' && <Stat label="投币" value={fmtNum(stat.coin)} />}
            {source === 'bilibili' && <Stat label="收藏" value={fmtNum(stat.favorite)} />}
            {source === 'bilibili' && <Stat label="转发" value={fmtNum(stat.share)} />}
            {source === 'bilibili' && <Stat label="弹幕" value={fmtNum(stat.danmaku)} />}
            {source === 'bilibili' && <Stat label="回复" value={fmtNum(stat.reply)} />}
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
            // 换轨写 query（state 由 effect 从 query 派生）；版本回落该轨默认（ver 省略写 null）
            const t = tracks.find((x) => x.id === id);
            const dv = t ? (t.versions.find((x) => x.is_default) ?? t.versions[0]) : undefined;
            updateQuery({ track: String(id), ver: dv ? String(dv.id) : null });
          }}
        />
      </section>
      {track && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">版本</h3>
          <VersionSwitcher versions={track.versions} selected={selectedVersion} onSelect={(id) => updateQuery({ ver: String(id) })} />
        </section>
      )}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">字幕正文</h3>
        {bodyQ.loading && <Skeleton className="h-40" />}
        {bodyQ.error && (
          <div className="text-sm text-destructive">
            字幕加载失败：{bodyQ.error}{' '}
            <button className="cursor-pointer underline" onClick={bodyQ.reload}>重试</button>
          </div>
        )}
        {!bodyQ.loading && !bodyQ.error && (
          <SubtitleView body={(bodyQ.data?.version?.payload?.body ?? []) as SubtitleLine[]} sourceVid={sourceVid} />
        )}
      </section>
    </div>
  );
}

function Field({ label, value, mono, children }: { label: string; value: string; mono?: boolean; children?: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={mono ? 'truncate font-mono' : 'truncate'}>{children ?? value}</div>
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
