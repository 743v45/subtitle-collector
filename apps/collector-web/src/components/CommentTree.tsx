import { useCallback, useEffect, useState } from 'react';
import { getVideoComments, type CommentNode } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

// ── B 站评论只读树（2026-10-05 Q5 视频详情评论区改造）──
// CommentTree：纯渲染（置顶徽标 / 昵称空回落「匿名」/ 正文保留换行 / 点赞 / 时间 / 楼中楼缩进）。
// CommentsSection：详情页元信息区「评论 N」徽标按钮 + 懒加载编排——首次展开才请求
// api.getVideoComments（GET /api/comments/tree?bvid=），收起再展开走缓存不重拉；
// 失败停错误态等手动重试（不自动重试打爆接口）。措辞红线：本项目里 B 站评论一律叫「评论」。

// 评论时间：unix 秒 → zh-CN 本地时间串（与详情页其他时间格式化同风格）；
// null（DB 列可空）显「—」占位——绝不走 new Date(null*1000) 渲染出 1970-01-01
const fmtCtime = (sec: number | null): string => (sec == null ? '—' : new Date(sec * 1000).toLocaleString('zh-CN'));

// 单条评论；楼中楼由外层容器缩进（border-l + pl），本组件自身不感知层级
function CommentItem({ node }: { node: CommentNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-sm">
        {node.pin_kind != null && <Badge variant="secondary">置顶</Badge>}
        <span className="min-w-0 truncate font-medium">{node.uname || '匿名'}</span>
        {node.like_count > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">👍 {node.like_count}</span>
        )}
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{fmtCtime(node.ctime_s)}</span>
      </div>
      {/* whitespace-pre-wrap：评论正文保留 UP 评/换行原貌；message null（DB 列可空）不渲染正文 */}
      {node.message != null && (
        <div className="whitespace-pre-wrap break-words text-sm text-foreground/90">{node.message}</div>
      )}
      {node.replies.length > 0 && (
        <div className="space-y-2 border-l-2 border-border pl-3">
          {node.replies.map((r) => <CommentItem key={r.rpid_str} node={r} />)}
        </div>
      )}
    </div>
  );
}

export function CommentTree({ tree }: { tree: CommentNode[] }) {
  return (
    <div className="space-y-3">
      {tree.map((n) => <CommentItem key={n.rpid_str} node={n} />)}
    </div>
  );
}

interface CommentsData { totalRows: number; totalRoots: number; tree: CommentNode[] }

// 详情页评论区入口：徽标按钮（加载前只显示「评论」，加载后「评论 N」N=totalRows）+ 展开面板
export function CommentsSection({ sourceVid }: { sourceVid: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CommentsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getVideoComments(sourceVid)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        // 日志规则：失败带 bvid 与错误详情，能直接定位「哪个视频的评论挂了、为什么」
        console.error('[CommentsSection] 评论树加载失败', { bvid: sourceVid, error: msg });
        setError(msg);
        setLoading(false);
      });
  }, [sourceVid]);

  // 懒加载编排：首次展开才请求；data 非空（含 0 评论）不重拉；loading 中不重复发；
  // error 非空停住等重试按钮，不自动重试。
  useEffect(() => {
    if (open && data === null && !loading && error === null) load();
  }, [open, data, loading, error, load]);

  return (
    <div className="col-span-full space-y-2">
      <Button
        variant="outline"
        size="sm"
        className="h-7 cursor-pointer rounded-full px-3 text-xs"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        评论{data ? ` ${data.totalRows}` : ''}
      </Button>
      {open && (
        <div className="max-h-[420px] space-y-2 overflow-y-auto rounded-md border bg-muted/20 p-3">
          {loading && (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}
          {error != null && (
            <div className="text-sm text-destructive">
              评论加载失败：{error}{' '}
              <button className="cursor-pointer underline" onClick={load}>重试</button>
            </div>
          )}
          {data != null && !loading && data.totalRows === 0 && (
            <div className="text-sm text-muted-foreground">库内暂无评论（未采集）</div>
          )}
          {data != null && !loading && data.totalRows > 0 && <CommentTree tree={data.tree} />}
        </div>
      )}
    </div>
  );
}
