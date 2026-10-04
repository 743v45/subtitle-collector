// ── 按轨导出条（CLI export subtitle 的 web 形态，挂 VideoDetail 字幕正文区、SubtitleView 之后的同级子组件）──
// 轨选择（全部轨，label = lan_doc + lan + 默认标记）+ 格式选择（srt/vtt/txt/json）+ 导出按钮。
// server 缺省：version 不传 = 该轨默认版本；track 显式传（选中的轨）。下载统一走 downloadUrl → toast 反馈。
// 独立子组件原因：VideoDetail 复杂度已在台账线（45），新交互一律进子组件、不改 SubtitleView 内部；
// 无轨（tracks 为空）时不渲染任何东西，由本组件自行兜底（父级保持零分支）。
import { useState } from 'react';
import type { TrackInfo } from '../types';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { downloadUrl } from '../lib/download';
import { buildExportSubtitleUrl, type ExportSubtitleFormat } from '../api-export';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const FORMATS: readonly { value: ExportSubtitleFormat; label: string }[] = [
  { value: 'srt', label: 'SRT' },
  { value: 'vtt', label: 'VTT' },
  { value: 'txt', label: 'TXT' },
  { value: 'json', label: 'JSON' },
];

export function TrackExportBar({
  source,
  sourceVid,
  tracks,
}: {
  source: string;
  sourceVid: string;
  tracks: TrackInfo[];
}) {
  const toast = useToast();
  // 缺省选中默认轨（无默认标记者取第一轨）； tracks 为空时本组件整体不渲染
  const [trackId, setTrackId] = useState<number | undefined>(
    () => (tracks.find((t) => t.is_default) ?? tracks[0])?.id,
  );
  const [format, setFormat] = useState<ExportSubtitleFormat>('srt');
  const [busy, setBusy] = useState(false);

  if (tracks.length === 0) return null;

  const doExport = async () => {
    if (trackId == null || busy) return;
    setBusy(true);
    try {
      const r = await downloadUrl(
        buildExportSubtitleUrl(source, sourceVid, { track: trackId, format }),
        `${sourceVid}.${format}`,
      );
      toast(`已导出 ${r.filename}`, 'success');
    } catch (e) {
      toast(`导出失败：${errMsg(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">按轨导出：</span>
      <Select
        value={trackId != null ? String(trackId) : undefined}
        onValueChange={(v) => setTrackId(Number(v))}
        disabled={busy}
      >
        <SelectTrigger className="h-8 w-[200px]" aria-label="选择导出字幕轨">
          <SelectValue placeholder="字幕轨" />
        </SelectTrigger>
        <SelectContent>
          {tracks.map((t) => (
            <SelectItem key={t.id} value={String(t.id)}>
              {t.lan_doc ?? t.lan ?? `轨 ${t.id}`}
              {t.is_default ? '（默认）' : ''} · {t.lan}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={format} onValueChange={(v) => setFormat(v as ExportSubtitleFormat)} disabled={busy}>
        <SelectTrigger className="h-8 w-[90px]" aria-label="选择导出格式">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FORMATS.map((f) => (
            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" className="h-8" disabled={busy || trackId == null} onClick={() => void doExport()}>
        {busy ? '导出中…' : '导出'}
      </Button>
    </div>
  );
}
