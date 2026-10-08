// 评论卡（2026-10-08，用户现场指令「popup 新增评论展示卡，照抄弹幕卡先例」）。
// 独立成文件：Popup.tsx 是静态台账在册超标文件（maxLines），新组件按 DanmakuCard/ClientIdFoot 先例拆出。
// 仅 bilibili 源展示（comments 表以 bvid 为键），由 Popup 以 isBili 控制挂载。
// 措辞红线：本卡是评论（comment），与弹幕（danmaku）/字幕（subtitle）互不相干；卡标题「评论」。
// 形态对齐 DanmakuCard 两态交互（Radix Collapsible + chevron 旋转 rotate-90=展开 +
// aria-expanded 由 CollapsibleTrigger 自带；无复制按钮——批量复制是弹幕卡用户现场指令专属，评论卡未授意）：
//   折叠态 = 一行（chevron + 评论 + N 条，N=库内评论总数=已采口径）；点行展开；
//   展开态 = 定高可滚动列表（max-h-80 overflow-y-auto，对齐 DanmakuCard/BatchCollectCard）。
//   收起再展开不重新 fetch：数据在 useComments（拉取时机=挂载），Collapsible 开合只控 UI 显隐。
// 行展示（信息密度对齐 DanmakuCard 行：左侧小字灰列 + 正文列）：
//   【赞 N】@uname(UP主):message，口径逐字对齐 CLI renderTree/bundle md（cli/commands/comments.ts §6.3）：
//   置顶行首 [置顶]（server 已分区前置）、行尾 [已折叠]/[仅自己可见]（state=17，同 statusTags）、
//   图片评论行尾 [图]（has_picture 派生，不渲染图本体）、楼中楼缩进 pl-4 + 「回复 @X」前缀
//   （parent_reply_name 被回复者快照，悬空兜底语义见 bundle-comments.ts replyPrefix）。
// 展示分支（状态语义见 hooks-comments.ts useComments）：
//   数据未就绪（首拉 loading / server 不可达 error）→ 不渲染，无噪音（server-down 静默惯例）；
//   total_rows > 0 → 折叠行 + 可展开列表；truncated → 列表尾灰字截断提示（防误读为全量）；
//   total_rows = 0（含 server 404 视频不在库，hook 已归一 0 条）→ 灰字两段式：
//     主行「评论未采集」+ 副行采集指引 `collector-cli comments collect --bvid <本视频 BV>`
//     （对齐 DanmakuCard 未采集指引形态，bvid 取 prop 实值，纯文本展示）。
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ChevronIcon } from './icons-meta';
import { COMMENTS_LIST_LIMIT, useComments, type CommentItem } from './hooks-comments';

// 正文段纯函数（【赞 N】左列之外的正文；标注口径逐字对齐 cli/commands/comments.ts：
// uname 缺省 (未知用户)、is_up=1 → (UP主) 紧随昵称、被回复者 → 「 回复 @X」、message 缺省 (无正文)、
// 行尾状态标注带前导空格 [已折叠]/[仅自己可见]，置顶 [置顶] 置行首；has_picture=1 → 行尾 [图]）。
export function formatCommentContent(c: CommentItem): string {
  const seg: string[] = [];
  if (c.pin_kind) seg.push('[置顶]');
  seg.push(`@${c.uname ?? '(未知用户)'}${c.is_up === 1 ? '(UP主)' : ''}`);
  if (c.parent_reply_name) seg.push(` 回复 @${c.parent_reply_name}`);
  seg.push(`:${c.message ?? '(无正文)'}`);
  if (c.has_picture === 1) seg.push(' [图]');
  const tags: string[] = [];
  if (c.folded === 1) tags.push('[已折叠]');
  if (c.state === 17) tags.push('[仅自己可见]');
  if (tags.length > 0) seg.push(` ${tags.join(' ')}`);
  return seg.join('');
}

export function CommentsCard({
  bvid,
  httpBase,
  enabled,
}: {
  bvid: string;
  httpBase: string;
  enabled: boolean;
}) {
  const { data } = useComments(bvid, httpBase, enabled);
  const [open, setOpen] = useState(false); // 默认折叠
  // 首拉中 / server 不可达（无数据）→ 静默不渲染
  if (!data) return null;
  // 未采集（total_rows=0，含 404 视频不在库）：灰字两段式（主行状态 + 副行采集指引）
  if (data.total_rows === 0) {
    return (
      <Card>
        <CardContent className="space-y-1 p-3 text-xs text-muted-foreground">
          <div>评论未采集</div>
          {/* 副行指引：命令带本视频真实 bvid，可直接整行复制（纯文本展示，无复制按钮——对齐 DanmakuCard） */}
          <div className="text-[10px] text-muted-foreground/70">
            可执行 <code className="break-all font-mono">{`collector-cli comments collect --bvid ${bvid}`}</code> 采集
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="space-y-2 p-3 text-xs">
        {/* 头行形态对齐 DanmakuCard（chevron + 主词 + tabular-nums 计数）；N=库内评论总数（含楼） */}
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ChevronIcon className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
            <span className="shrink-0 font-medium text-foreground">评论</span>
            <span className="shrink-0 tabular-nums">{data.total_rows} 条</span>
          </CollapsibleTrigger>
          {/* 定高可滚动列表（max-h-80 对齐 DanmakuCard）；楼中楼缩进 pl-4；赞数小字灰列同弹幕时间戳位 */}
          <CollapsibleContent className="pt-2">
            <div className="max-h-80 space-y-0.5 overflow-y-auto pr-0.5">
              {data.comments.map((c) => (
                <div
                  key={c.rpid_str}
                  className={cn('flex items-start gap-1.5 text-xs', c.is_root === 0 && 'pl-4')}
                >
                  <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
                    {`【赞 ${c.like_count}】`}
                  </span>
                  <span className="min-w-0 break-all">{formatCommentContent(c)}</span>
                </div>
              ))}
              {/* 极端态：库内有行但无挂载根（全部根已删仅剩孤儿楼）→ 空态行（对齐 DanmakuCard 无文本弹幕） */}
              {data.comments.length === 0 && (
                <div className="py-2 text-center text-xs text-muted-foreground">无可展示评论</div>
              )}
              {/* 截断提示：根数超 limit 被截，灰字说明（诚实展示，防误读为全量） */}
              {data.truncated && (
                <div className="pt-1 text-[10px] text-muted-foreground/70">
                  {`仅显示前 ${COMMENTS_LIST_LIMIT} 根评论（共 ${data.total_roots} 根）`}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
