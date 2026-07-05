import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/components/ui/toast';
import { getCreatorDetail, listCategories, setCreatorCategory, listVideos } from '@/api';
import type { CreatorDetail, VideoListItem } from '@/types';

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}
function fmtView(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 10000) return String(n);
  if (n < 100000000) return `${(n / 10000).toFixed(1)}万`;
  return `${(n / 100000000).toFixed(1)}亿`;
}
function fmtDur(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// 资料卡里的「label + 值」行；空值统一渲染为 —。
function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2 text-sm">
      <div className="w-20 shrink-0 text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words">{value ?? '—'}</div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex items-center gap-4 p-4">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-24" />
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><Skeleton className="h-4 w-16" /></CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><Skeleton className="h-4 w-16" /></CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-9 w-52" />
            <Skeleton className="h-9 w-52" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function CreatorDetailPage({
  id,
  onBack,
  onOpenVideo,
}: {
  id: number;
  onBack: () => void;
  onOpenVideo: (source: string, sourceVid: string) => void;
}) {
  const toast = useToast();
  const { data: creator, loading, error, reload } = useAsync<CreatorDetail>(
    () => getCreatorDetail(id),
    [id],
  );
  const { data: agentCats } = useAsync(() => listCategories('agent'), []);
  const { data: humanCats } = useAsync(() => listCategories('human'), []);
  // 该 UP 已采集视频（按发布时间倒序，最多 100 条）
  const { data: videosData, loading: videosLoading } = useAsync(
    () => listVideos({ creator_id: id, size: 100, sort: 'published_at', desc: true }),
    [id],
  );
  const videos: VideoListItem[] = videosData?.items ?? [];
  const videoTotal = videosData?.total ?? 0;
  const [busyScope, setBusyScope] = useState<'agent' | 'human' | null>(null);

  async function changeCategory(scope: 'agent' | 'human', name: string) {
    if (!creator) return;
    setBusyScope(scope);
    try {
      await setCreatorCategory(creator.source_uid, scope, name);
      toast('已更新', 'success');
      reload();
    } catch (e: unknown) {
      toast(`失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusyScope(null);
    }
  }

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>← 返回</Button>

      {error ? (
        <Card className="border-destructive">
          <CardContent className="flex items-center justify-between p-4 text-sm text-destructive">
            <span>加载失败：{error}</span>
            <Button variant="outline" size="sm" onClick={reload}>重试</Button>
          </CardContent>
        </Card>
      ) : loading || !creator ? (
        <DetailSkeleton />
      ) : (
        <>
          {/* 概览：头像 / 名称 / mid / 当前分类 Badge（一眼可见当前归属） */}
          <Card>
            <CardContent className="flex items-center gap-4 p-4">
              {creator.avatar ? (
                <img
                  src={creator.avatar}
                  alt={creator.name ?? 'avatar'}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                  无头像
                </div>
              )}
              <div className="min-w-0 space-y-1">
                <div className="text-xl font-semibold">{creator.name ?? '(未知)'}</div>
                <div className="text-sm text-muted-foreground">
                  mid: <span className="font-mono">{creator.source_uid}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {creator.category_agent_name && <Badge>Agent: {creator.category_agent_name}</Badge>}
                  {creator.category_human_name && <Badge>人工: {creator.category_human_name}</Badge>}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            {/* 资料 */}
            <Card>
              <CardHeader><CardTitle className="text-base">资料</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <Field label="签名" value={creator.sign} />
                <Field label="等级" value={creator.level != null ? String(creator.level) : null} />
                <Field label="性别" value={creator.sex} />
                <Field label="认证" value={creator.official_title} />
                <Field label="粉丝" value={creator.fans != null ? creator.fans.toLocaleString() : null} />
                <Field label="关注" value={creator.following != null ? creator.following.toLocaleString() : null} />
                <Field label="首见时间" value={fmtTime(creator.first_seen_at)} />
              </CardContent>
            </Card>

            {/* 分类编辑：agent / human 各一个 Select */}
            <Card>
              <CardHeader><CardTitle className="text-base">分类</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <div className="text-sm font-medium">Agent 分类</div>
                  <Select
                    value={creator.category_agent_name ?? undefined}
                    onValueChange={(v) => changeCategory('agent', v)}
                    disabled={busyScope === 'agent'}
                  >
                    <SelectTrigger className="w-52">
                      <SelectValue placeholder="选择分类" />
                    </SelectTrigger>
                    <SelectContent>
                      {(agentCats ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <div className="text-sm font-medium">人工分类</div>
                  <Select
                    value={creator.category_human_name ?? undefined}
                    onValueChange={(v) => changeCategory('human', v)}
                    disabled={busyScope === 'human'}
                  >
                    <SelectTrigger className="w-52">
                      <SelectValue placeholder="选择分类" />
                    </SelectTrigger>
                    <SelectContent>
                      {(humanCats ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* 该 UP 已采集视频列表（按发布时间倒序） */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">已采集视频（{videoTotal}{videoTotal > videos.length ? `，仅显示前 ${videos.length}` : ''}）</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {videosLoading && <Skeleton className="h-14 w-full" />}
              {!videosLoading && videos.length === 0 && (
                <div className="py-2 text-sm text-muted-foreground">暂无已采集视频</div>
              )}
              {!videosLoading && videos.map((v) => (
                <div
                  key={v.id}
                  onClick={() => onOpenVideo(v.source, v.source_vid)}
                  className="cursor-pointer rounded-md p-2 transition-colors hover:bg-accent"
                >
                  <div className="line-clamp-1 text-sm font-medium">{v.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {v.view != null && <span>播放 {fmtView(v.view)}</span>}
                    {v.view != null && fmtDur(v.duration) && ' · '}
                    {fmtDur(v.duration)}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
