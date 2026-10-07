// 弹幕卡（2026-10-07 弹幕采集树进 popup；用户现场指令「popup 也要同步支持复制」）。
// 独立成文件：Popup.tsx 是静态台账在册超标文件（maxLines），新组件按 ClientIdFoot 先例拆出偿还。
// 仅 bilibili 源展示（danmaku 表以 bvid 为键），由 Popup 以 isBili 控制挂载。
// 措辞红线：本卡是时间轴弹幕（danmaku），与字幕（subtitle，SubtitleCard）互不相干。
// 展示分支（状态语义见 hooks-danmaku.ts useDanmaku）：
//   数据未就绪（首拉 loading / server 不可达 error）→ 不渲染，无噪音（对齐 server-down 静默惯例）；
//   rows > 0 → 「弹幕 + N 条 + 复制」；复制成功反馈「已复制 N 条」2s、失败「复制失败」2s 后复原
//     （复制文本由根目录纯模块 popup-danmaku.mjs 产出：[MM:SS] 内容 每条一行）；
//   rows = 0（含 server 404 视频不在库，hook 已归一 0 条）→ 灰字「弹幕未采集」。
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { copyText } from './ClientIdFoot';
import { useDanmaku } from './hooks-danmaku';
import { danmakuCopyStats, formatDanmakuCopy } from '../../popup-danmaku.mjs';

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
      {/* 行形态对齐 SubtitleCard 头部（text-xs + font-medium 主词 + tabular-nums 计数），
          复制按钮三态配色对齐 SubtitleCard 的复制按钮（brand/secondary/destructive） */}
      <CardContent className="flex items-center gap-2 p-3 text-xs">
        <span className="font-medium text-foreground">弹幕</span>
        <span className="tabular-nums text-muted-foreground">{data.rows} 条</span>
        <button
          type="button"
          onClick={() => void onCopy()}
          className={cn(
            'ml-auto shrink-0 rounded px-2 py-0.5 transition-colors',
            copyFailed
              ? 'bg-destructive text-destructive-foreground'
              : copiedCount != null
                ? 'bg-secondary text-secondary-foreground'
                : 'bg-brand text-brand-foreground hover:bg-brand/90'
          )}
        >
          {copyFailed ? '复制失败' : copiedCount != null ? `已复制 ${copiedCount} 条` : '复制'}
        </button>
      </CardContent>
    </Card>
  );
}
