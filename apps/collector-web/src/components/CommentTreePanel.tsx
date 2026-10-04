// 评论树面板（P2-5 web 评论展示）：VideoDetail 统计卡下方的 B 站评论区树。
// 数据：GET /api/videos/:source/:vid/comments（server 与 CLI comments tree 共享
// db/comments-tree.ts shapeTree——根赞降序/楼中楼按根分组/depth ≤3 拍平/「回复 @」
// 指向/对象已删/孤儿组不丢弃/limit 只截根数，语义见该模块头注）。
// 交互：懒展开（收起不发请求）→ limit=20 首屏 → 「加载全部」setLimit(0) 触发重取
// （URL 省略 limit → server 缺省不限）。
import { useState } from 'react';
import { getVideoComments } from '../api';
import { useAsync } from '@/lib/useAsync';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ChevronDown, MessageSquare } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CommentBase, CommentFloorNode, CommentRootNode, VideoComments } from '../types';

// Tailwind JIT 只扫描静态字符串：缩进类必须整串静态映射，禁止动态拼接类名。
const DEPTH_CLASS: Record<number, string> = { 1: '', 2: 'ml-4', 3: 'ml-8' };

/** ctime_s（unix 秒）→ YYYY-MM-DD 本地时区；null/非有限 → 时间未知（对齐 CLI fmtDate）。 */
export function commentDate(ctimeS: number | null): string {
  if (!ctimeS || !Number.isFinite(ctimeS)) return '时间未知';
  const d = new Date(ctimeS * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 行尾状态徽章（对齐 CLI statusTags：置顶/已折叠/state=17 仅自己可见/其他 state 原样）。 */
function StatusBadges({ pinKind, folded, state }: { pinKind: string | null; folded: number; state: number }) {
  const badges: ReactNode[] = [];
  if (pinKind) badges.push(<Badge key="pin" variant="secondary">置顶:{pinKind}</Badge>);
  if (folded === 1) badges.push(<Badge key="fold" variant="secondary">已折叠</Badge>);
  if (state === 17) badges.push(<Badge key="hidden" variant="secondary">仅自己可见</Badge>);
  else if (state !== 0) badges.push(<Badge key="state" variant="secondary">state={state}</Badge>);
  if (badges.length === 0) return null;
  return <span className="ml-1 inline-flex items-center gap-1">{badges}</span>;
}

/** 楼中楼行（缩进 = depth 静态映射；「回复 @」指向/对象已删为 server 派生列）。 */
function FloorLine({ f }: { f: CommentFloorNode }) {
  return (
    <li className={DEPTH_CLASS[Math.min(f.depth, 3)]}>
      <span className="text-sm">
        【赞 {f.like_count}】@{f.uname ?? '(未知用户)'}{f.is_up === 1 ? '（UP主）' : ''}
        {f.reply_to != null && ` 回复 @${f.reply_to}`}
        ：{f.message ?? '(无正文)'}
      </span>
      {f.ip_location != null && <span className="ml-1 text-xs text-muted-foreground"> · IP属地:{f.ip_location}</span>}
      <span className="ml-1 text-xs text-muted-foreground">{commentDate(f.ctime_s)}</span>
      {f.parent_missing && <span className="ml-1 text-xs text-destructive">回复对象已删除</span>}
      <StatusBadges pinKind={f.pin_kind} folded={f.folded} state={f.state} />
    </li>
  );
}

/** 根评论组：头部行（赞数/作者/UP主标记/IP/日期/UP主已回复）+ 正文 + 所组楼中楼。 */
function RootBlock({ r }: { r: CommentRootNode }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">【赞 {r.like_count}】@{r.uname ?? '(未知用户)'}{r.is_up === 1 ? '（UP主）' : ''}</span>
        {r.ip_location != null && <span className="text-xs text-muted-foreground"> · IP属地:{r.ip_location}</span>}
        <span className="text-xs text-muted-foreground"> · {commentDate(r.ctime_s)}</span>
        {r.up_reply === 1 && <Badge variant="secondary">UP主已回复</Badge>}
        <StatusBadges pinKind={r.pin_kind} folded={r.folded} state={r.state} />
      </div>
      {r.message && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{r.message}</p>}
      {r.floors.length > 0 && (
        <ul className="space-y-1">
          {r.floors.map((f) => <FloorLine key={f.rpid_str} f={f} />)}
        </ul>
      )}
    </div>
  );
}

export function CommentTreePanel({ source, sourceVid }: { source: string; sourceVid: string }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(20);
  // 懒展开：收起不发请求（resolve null）；展开/limit 变化（含「加载全部」setLimit(0)）重取
  const q = useAsync(
    () => (open ? getVideoComments(source, sourceVid, limit) : Promise.resolve(null as VideoComments | null)),
    [open, source, sourceVid, limit],
  );
  const data = q.data;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <MessageSquare className="size-4" aria-hidden="true" />
          评论{data ? `（共 ${data.counts.rows} 条）` : ''}
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </Button>
        {q.error && (
          <div className="text-sm text-destructive">
            评论加载失败：{q.error}{' '}
            <button className="cursor-pointer underline" onClick={q.reload}>重试</button>
          </div>
        )}
        {q.loading && !q.error && !data && <Skeleton className="h-24" />}
        {data && data.counts.rows === 0 && (
          <p className="text-sm text-muted-foreground">该视频暂无评论</p>
        )}
        {data && data.counts.rows > 0 && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              评论区树：共 {data.counts.rows} 条（根 {data.counts.roots} / 楼中楼 {data.counts.floors}）
            </p>
            {data.roots.map((r) => <RootBlock key={r.rpid_str} r={r} />)}
            {data.orphans.length > 0 && (
              <div className="space-y-1">
                <h4 className="text-sm font-medium text-muted-foreground">根已删除的楼层（{data.orphans.length} 条）</h4>
                <ul className="space-y-1">
                  {data.orphans.map((f) => <FloorLine key={f.rpid_str} f={f} />)}
                </ul>
              </div>
            )}
            {data.truncated && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">仅显示点赞前 {data.limit} 根，共 {data.counts.roots} 根</p>
                <Button variant="outline" size="sm" onClick={() => setLimit(0)}>加载全部</Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
