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
import { TAG_SOURCE_CLASS, TAG_SOURCE_LABEL, type TagSource } from '@/lib/tagSources';
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
  const toast = useToast();
  const detailQ = useAsync(() => getVideo(source, sourceVid), [source, sourceVid]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // selectedVersion 为 null 时 resolve(null)（无版本可加载），useAsync 走完 loading→data:null
  const bodyQ = useAsync(
    () => selectedVersion != null ? getVersion(selectedVersion) : Promise.resolve(null),
    [selectedVersion],
  );

  // 打标表单：新标签名（逗号分隔多个）；removingTag 标记正在移除的 `source:name`
  const [newTagNames, setNewTagNames] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingTag, setRemovingTag] = useState<string | null>(null);

  // 详情就绪后选中默认轨 + 默认版本；已有选择且仍有效时保持（打标后 reload 不重置用户选择）
  useEffect(() => {
    if (!detailQ.data) return;
    const trackIds = detailQ.data.tracks.map((t) => t.id);
    if (selectedTrack != null && trackIds.includes(selectedTrack)) return;
    const def = detailQ.data.tracks.find((t) => t.is_default) ?? detailQ.data.tracks[0];
    if (def) {
      setSelectedTrack(def.id);
      const dv = def.versions.find((x) => x.is_default) ?? def.versions[0];
      setSelectedVersion(dv?.id ?? null);
    }
  }, [detailQ.data]);

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
  const tagDetails = detailQ.data.tag_details ?? [];
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
          {source === 'bilibili' && <Field label="分区" value={e?.tname ?? '-'} />}
          {source === 'bilibili' && <Field label="版权" value={copyrightLabel(e?.copyright) ?? '-'} />}
          {source === 'bilibili' && <Field label="P 数" value={e?.pages?.length != null ? String(e.pages.length) : '-'} />}
          <Field label="状态" value={v.status ?? '-'} />
        </CardContent>
      </Card>

      {/* 标签（四档带色全展示不去重；manual/batch/ai 可增删，bili 为视频自带只读） */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {tagDetails.length === 0 && (
              <span className="text-sm text-muted-foreground">暂无标签</span>
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
                  {t.source !== 'bili' && (
                    <button
                      type="button"
                      aria-label={`移除标签 ${t.name}`}
                      className="ml-1 leading-none opacity-60 hover:opacity-100"
                      disabled={busy || adding}
                      onClick={() => onRemoveTag(t.name, t.source)}
                    >
                      {busy ? '…' : '×'}
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
          <SubtitleView body={(bodyQ.data?.version?.payload?.body ?? []) as SubtitleLine[]} sourceVid={sourceVid} />
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
