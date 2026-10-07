// 弹幕卡（2026-10-07 弹幕采集树进 popup；用户现场指令「popup 也要同步支持复制」）。
// 独立成文件：Popup.tsx 是静态台账在册超标文件（maxLines），新组件按 ClientIdFoot 先例拆出。
// 仅 bilibili 源展示（danmaku 表以 bvid 为键），由 Popup 以 isBili 控制挂载。
// 措辞红线：本卡是时间轴弹幕（danmaku），与字幕（subtitle，SubtitleCard）互不相干。
// 两态交互（2026-10-07 用户现场指令「popup 可以展开（默认折叠），定高可滚动」，
// 形态对齐「UP 全部视频」卡先例 Popup.tsx BatchCollectCard：Radix Collapsible +
// chevron 旋转（rotate-90=展开）+ aria-expanded 由 CollapsibleTrigger 自带）：
//   折叠态 = 一行（chevron + 弹幕 + N 条 + 复制按钮）；点行展开；
//   展开态 = 定高可滚动列表（max-h-80 overflow-y-auto，对齐 BatchCollectCard 列表体），
//     逐条 [MM:SS] 内容（条目由纯模块 popup-danmaku.mjs formatDanmakuLines 产出，
//     content null/空跳过、progress null/负显示 --:--）；顺序=接口顺序（时间轴序）不重排。
//   收起再展开不重新 fetch：数据在 useDanmaku（拉取时机=挂载，与 BatchCollectCard 同），
//     Collapsible 开合只控 UI 显隐。
// 复制=批量复制全部（formatDanmakuCopy 行为不变），折叠态即有复制按钮（不必展开）。
// 展示分支（状态语义见 hooks-danmaku.ts useDanmaku）：
//   数据未就绪（首拉 loading / server 不可达 error）→ 不渲染，无噪音（对齐 server-down 静默惯例）；
//   rows > 0 → 折叠行 + 可展开列表；复制成功反馈「已复制 N 条」2s、失败「复制失败」2s 后复原；
//   rows = 0（含 server 404 视频不在库，hook 已归一 0 条）→ 灰字「弹幕未采集」。
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { copyText } from './ClientIdFoot';
import { ChevronIcon } from './icons-meta';
import { useDanmaku } from './hooks-danmaku';
import { danmakuCopyStats, formatDanmakuCopy, formatDanmakuLines } from '../../popup-danmaku.mjs';

export function DanmakuCard({
  bvid,
  httpBase,
  enabled,
}: {
  bvid: string;
  httpBase: string;
  enabled: boolean;
}) {
  const { data } = useDanmaku(bvid, httpBase, enabled);
  const [open, setOpen] = useState(false); // 默认折叠
  const [copiedCount, setCopiedCount] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  // 首拉中 / server 不可达（无数据）→ 静默不渲染
  if (!data) return null;
  // 未采集（rows=0，含 404 视频不在库）：灰字提示，不渲染复制按钮
  if (data.rows === 0) {
    return (
      <Card>
        <CardContent className="p-3 text-xs text-muted-foreground">弹幕未采集</CardContent>
      </Card>
    );
  }
  // 展开列表条目（折叠/展开共用同一份，无独立请求）；极端态：rows>0 但内容全空 → 空态行
  const lines = formatDanmakuLines(data.danmakus);
  const onCopy = async () => {
    const text = formatDanmakuCopy(data.danmakus);
    if (await copyText(text)) {
      setCopiedCount(danmakuCopyStats(text));
      setTimeout(() => setCopiedCount(null), 2000);
    } else {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2000);
    }
  };
  return (
    <Card>
      <CardContent className="space-y-2 p-3 text-xs">
        {/* 行形态对齐 SubtitleCard 头部 + BatchCollectCard 摘要行（text-xs + font-medium 主词 +
            tabular-nums 计数）；复制按钮在 trigger 外（点复制不触发展开），三态配色对齐
            SubtitleCard 的复制按钮（brand/secondary/destructive） */}
        <Collapsible open={open} onOpenChange={setOpen}>
          <div className="flex items-center gap-1">
            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <ChevronIcon className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
              <span className="shrink-0 font-medium text-foreground">弹幕</span>
              <span className="shrink-0 tabular-nums">{data.rows} 条</span>
            </CollapsibleTrigger>
            <button
              type="button"
              onClick={() => void onCopy()}
              className={cn(
                'shrink-0 rounded px-2 py-0.5 transition-colors',
                copyFailed
                  ? 'bg-destructive text-destructive-foreground'
                  : copiedCount != null
                    ? 'bg-secondary text-secondary-foreground'
                    : 'bg-brand text-brand-foreground hover:bg-brand/90'
              )}
            >
              {copyFailed ? '复制失败' : copiedCount != null ? `已复制 ${copiedCount} 条` : '复制'}
            </button>
          </div>
          {/* 定高可滚动列表（max-h-80 对齐 BatchCollectCard）；时间戳小字灰、正文可断行 */}
          <CollapsibleContent className="pt-2">
            <div className="max-h-80 space-y-0.5 overflow-y-auto pr-0.5">
              {lines.map((l, i) => (
                <div key={i} className="flex items-start gap-1.5 text-xs">
                  <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">{l.clock}</span>
                  <span className="min-w-0 break-all">{l.content}</span>
                </div>
              ))}
              {lines.length === 0 && (
                <div className="py-2 text-center text-xs text-muted-foreground">无文本弹幕</div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
