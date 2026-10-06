import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/components/ui/toast';
import { getCreatorDetail, listCategories, setCreatorCategory, refreshCreatorProfile, listVideos } from '@/api';
import { creatorUrl, videoUrl } from '../lib/externalLinks';
import { PlatformIcon, platformIconClass } from '@/components/PlatformIcon';
import { cn } from '@/lib/utils';
import { ExtLink } from '@/components/ExtLink';
import { ArrowLeft, RefreshCw, UserRound } from 'lucide-react';
import { CreatorCategoryCell } from './CreatorCategoryCell';
import { CreatorDetailSkeleton } from './CreatorDetailSkeleton';
import type { CreatorDetail, VideoListItem } from '@/types';

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN');
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
  // 一套共享分类值:拉一次,Agent/人工两个下拉共用(分开选,各写各的槽位)
  const { data: cats } = useAsync(() => listCategories(), []);
  // 该 UP 已采集视频（按发布时间倒序，最多 100 条）
  const { data: videosData, loading: videosLoading } = useAsync(
    () => listVideos({ creator_id: id, size: 100, sort: 'published_at', desc: true }),
    [id],
  );
  const videos: VideoListItem[] = videosData?.items ?? [];
  const videoTotal = videosData?.total ?? 0;
  const [busyScope, setBusyScope] = useState<'agent' | 'human' | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function changeCategory(scope: 'agent' | 'human', name: string) {
    if (!creator) return;
    setBusyScope(scope);
    try {
      // 平台段必传：uid 两平台命名空间独立，不带会写错行
      await setCreatorCategory(creator.source, creator.source_uid, scope, name);
      toast('已更新', 'success');
      reload();
    } catch (e: unknown) {
      toast(`失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusyScope(null);
    }
  }

  // Q6b 刷新资料：重拉空间资料（昵称/头像/粉丝数等）；成功 reload，失败 toast 带上下文
  async function refreshProfile() {
    if (!creator) return;
    setRefreshing(true);
    try {
      await refreshCreatorProfile(creator.id);
      toast(`资料已刷新：${creator.name ?? creator.source_uid}`, 'success');
      reload();
    } catch (e: unknown) {
      toast(`刷新资料失败：${e instanceof Error ? e.message : String(e)}（id=${creator.id} ${creator.source_uid}）`, 'error');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-4" aria-hidden="true" />
        返回
      </Button>

      {error ? (
        <Card className="border-destructive">
          <CardContent className="flex items-center justify-between p-4 text-sm text-destructive">
            <span>加载失败：{error}</span>
            <Button variant="outline" size="sm" onClick={reload}>重试</Button>
          </CardContent>
        </Card>
      ) : loading || !creator ? (
        <CreatorDetailSkeleton />
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
                  // 头像站会按 Referer 反防盗链（B 站 i.whgt/YouTube i.ytimg 均命中过），剥掉再加载
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <UserRound className="size-6" aria-hidden="true" />
                </div>
              )}
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-1.5 text-xl font-semibold">
                  <span className="inline-flex truncate">
                    {/* 平台徽章（2026-08-24）：与创作者列表行一致 */}
                    <PlatformIcon source={creator.source} className={cn('mr-1 mt-0.5 h-3.5 w-3.5', platformIconClass(creator.source))} />
                    <span className="truncate">{creator.name ?? '(未知)'}</span>
                  </span>
                  <ExtLink href={creatorUrl(creator.source, creator.source_uid)} label={`在原站打开 ${creator.name ?? creator.source_uid} 的空间`} />
                </div>
                <div className="text-sm text-muted-foreground">
                  ID: <span className="font-mono">{creator.source_uid}</span>
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
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">资料</CardTitle>
                {/* Q6b 刷新资料：仅 bilibili 渲染（refreshCreatorProfile 只实现 B 站链路）；busy 禁点防连点 */}
                {creator.source === 'bilibili' && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={refreshing}
                    aria-label="刷新资料"
                    title="重新拉取昵称/头像/粉丝数等空间资料"
                    onClick={refreshProfile}
                  >
                    <RefreshCw className="mr-1 size-3.5" aria-hidden="true" />
                    {refreshing ? '刷新中…' : '刷新资料'}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                <Field label="签名" value={creator.sign} />
                {creator.source === 'bilibili' && <Field label="等级" value={creator.level != null ? String(creator.level) : null} />}
                {creator.source === 'bilibili' && <Field label="性别" value={creator.sex} />}
                {creator.source === 'bilibili' && <Field label="认证" value={creator.official_title} />}
                <Field label="粉丝" value={creator.fans != null ? creator.fans.toLocaleString('zh-CN') : null} />
                <Field label="关注" value={creator.following != null ? creator.following.toLocaleString('zh-CN') : null} />
                <Field label="首见时间" value={fmtTime(creator.first_seen_at)} />
              </CardContent>
            </Card>

            {/* 分类编辑：agent / human 各一个 Select */}
            <Card>
              <CardHeader><CardTitle className="text-base">分类</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <div className="text-sm font-medium">Agent 分类</div>
                  <CreatorCategoryCell
                    value={creator.category_agent_name}
                    cats={cats}
                    disabled={busyScope === 'agent'}
                    placeholder="选择分类"
                    triggerClass="w-52"
                    onPick={(name) => changeCategory('agent', name)}
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="text-sm font-medium">人工分类</div>
                  <CreatorCategoryCell
                    value={creator.category_human_name}
                    cats={cats}
                    disabled={busyScope === 'human'}
                    placeholder="选择分类"
                    triggerClass="w-52"
                    onPick={(name) => changeCategory('human', name)}
                  />
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
                <div className="py-2 text-sm text-muted-foreground">该 UP 暂无已采集视频——可在采集页提交其视频链接</div>
              )}
              {!videosLoading && videos.map((v) => (
                <div
                  key={v.id}
                  onClick={() => onOpenVideo(v.source, v.source_vid)}
                  className="cursor-pointer rounded-md p-2 transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="line-clamp-1 flex items-center gap-1 text-sm font-medium">
                    <span className="min-w-0 truncate">{v.title}</span>
                    <ExtLink href={videoUrl(v.source, v.source_vid)} label="在原站打开视频" />
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
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
