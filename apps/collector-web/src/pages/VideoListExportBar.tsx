// ── 视频库工具栏导出区（CLI export videos / export bundle 的 web 形态入口）──
// 「导出」下拉（CSV/NDJSON/JSON，选中即下载）+「原料包」按钮（开 ExportBundleDialog）。
// 下载统一走 lib/download.ts downloadUrl：!ok 抛错（带 server 文案）→ toast；成功 toast 带条数。
// 独立子组件原因：VideoList.tsx 在 maxLines/complexity 台账线上（533/52），新 UI 一律进子组件。
// 无 dropdown-menu.tsx，按任务许可用 Select 兼作动作菜单：值恒空串显占位符，选中即下载不复选。
import { useState } from 'react';
import type { VideoFilter } from '../types';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { downloadUrl } from '../lib/download';
import { buildExportBundleUrl, buildExportVideosUrl, type ExportVideosFormat } from '../api-export';
import { ExportBundleDialog } from './ExportBundleDialog';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const FMT_LABEL: Record<ExportVideosFormat, string> = { csv: 'CSV', ndjson: 'NDJSON', json: 'JSON' };
const FORMATS = Object.keys(FMT_LABEL) as ExportVideosFormat[];
// 动作菜单哨兵：Radix 仅在 value 为空串/undefined 时显示 placeholder（源码 shouldShowPlaceholder），
// 值恒为空串 → 触发器恒显占位文案（「导出」/「导出中…」），选中项不复位问题不存在
const MENU_NONE = '';

export function VideoListExportBar({ filter }: { filter: VideoFilter }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [bundleOpen, setBundleOpen] = useState(false);

  // format 省略时 server 缺省 json；这里三格式都显式传，文件名回落 videos-export.<fmt>
  const doExport = async (fmt: ExportVideosFormat) => {
    setBusy(true);
    try {
      const r = await downloadUrl(buildExportVideosUrl(filter, fmt), `videos-export.${fmt}`);
      toast(r.count != null ? `已导出 ${r.count} 条（${r.filename}）` : `已下载 ${r.filename}`, 'success');
    } catch (e) {
      toast(`导出失败：${errMsg(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Select
        value={MENU_NONE}
        onValueChange={(v) => { if (v !== MENU_NONE) void doExport(v as ExportVideosFormat); }}
        disabled={busy}
      >
        <SelectTrigger className="h-8 w-[104px]" aria-label="导出视频列表">
          <SelectValue placeholder={busy ? '导出中…' : '导出'} />
        </SelectTrigger>
        <SelectContent>
          {FORMATS.map((fmt) => (
            <SelectItem key={fmt} value={fmt}>{FMT_LABEL[fmt]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={() => setBundleOpen(true)}>
        原料包
      </Button>
      {/* 对话框开合状态由本组件（对话框的直接父级）管理，筛选经 props 下传 */}
      <ExportBundleDialog open={bundleOpen} onOpenChange={setBundleOpen} filter={filter} />
    </div>
  );
}
