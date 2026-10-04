// ── 原料包导出对话框（CLI export bundle 的 web 形态）──
// 按当前筛选打包分析原料 zip：manifest.json（视频清单 + 错误明细）、videos/*.txt（字幕正文）、
// ANALYZE.md（Claude Code 分析指引）。server 侧 limit 默认 500 / 上限 1000，前端同口径校验。
// 成功后对话框保持打开，内联展示 X-Bundle-* 三数（匹配/导出/错误）；错误>0 黄色提示缺字幕未导出。
// 开合状态由父级管理（open/onOpenChange），筛选经 props 下传；重开时清上次结果/错误（表单保留选择）。
import { useEffect, useState } from 'react';
import type { VideoFilter } from '../types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { downloadUrl, readCountHeader } from '../lib/download';
import { buildExportBundleUrl } from '../api-export';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// name_order 预设：server 校验组件域 id|name|time|author（逗号串）；默认与 CLI 一致 id,name
const NAME_ORDER_PRESETS = [
  { value: 'id,name', label: 'ID + 标题（默认）' },
  { value: 'id', label: '仅 ID' },
  { value: 'id,name,time', label: 'ID + 标题 + 发布时间' },
  { value: 'id,name,author', label: 'ID + 标题 + 作者' },
] as const;

interface BundleStats {
  filename: string;
  total: number;
  exported: number;
  errors: number;
}

export function ExportBundleDialog({
  open,
  onOpenChange,
  filter,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter: VideoFilter;
}) {
  const [limitInput, setLimitInput] = useState('500');
  const [nameOrder, setNameOrder] = useState<string>(NAME_ORDER_PRESETS[0].value);
  const [track, setTrack] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BundleStats | null>(null);

  // 重开清上次结果/错误；limit/name_order/track 保留上次选择（重复导出只改一处时少打字）
  useEffect(() => {
    if (open) {
      setError(null);
      setResult(null);
    }
  }, [open]);

  // 1..1000 整数（server 同口径 400）；不合法时禁用确认并给行内提示
  const limitNum = Number(limitInput);
  const limitValid = limitInput !== '' && Number.isInteger(limitNum) && limitNum >= 1 && limitNum <= 1000;

  const confirm = async () => {
    if (!limitValid || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await downloadUrl(
        buildExportBundleUrl(filter, { limit: limitNum, nameOrder, track: track || undefined }),
        'bundle.zip',
      );
      setResult({
        filename: r.filename,
        total: readCountHeader(r.headers.get('x-bundle-total')) ?? 0,
        exported: readCountHeader(r.headers.get('x-bundle-exported')) ?? 0,
        errors: readCountHeader(r.headers.get('x-bundle-errors')) ?? 0,
      });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && busy) return; onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>导出原料包</DialogTitle>
          <DialogDescription>
            按当前筛选打包分析原料：manifest.json（视频清单与错误明细）、videos/*.txt（各视频字幕正文）、ANALYZE.md（分析指引）。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="bundle-limit">打包上限（1–1000）</Label>
            <Input
              id="bundle-limit"
              type="number"
              min={1}
              max={1000}
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              disabled={busy}
            />
            {!limitValid && <p className="text-xs text-destructive">上限须为 1–1000 的整数</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bundle-name-order">文件名组成</Label>
            <Select value={nameOrder} onValueChange={setNameOrder} disabled={busy}>
              <SelectTrigger id="bundle-name-order" aria-label="文件名组成">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NAME_ORDER_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bundle-track">字幕轨语言（可选）</Label>
            <Input
              id="bundle-track"
              placeholder="留空=各视频默认轨，如 zh-CN / ai-ZH"
              value={track}
              onChange={(e) => setTrack(e.target.value)}
              disabled={busy}
            />
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
              导出失败：{error}
            </div>
          )}
          {result && (
            <div className="space-y-1.5 rounded-md border p-2 text-sm">
              <div>
                已下载 <span className="font-medium">{result.filename}</span>
              </div>
              <div className="text-muted-foreground tabular-nums">
                匹配 {result.total} · 导出 {result.exported} · 错误 {result.errors}
              </div>
              {result.errors > 0 && (
                <div className="rounded border border-amber-500/50 bg-amber-500/10 p-1.5 text-xs text-amber-600 dark:text-amber-400">
                  部分视频缺字幕未导出（{result.errors} 个），明细见包内 manifest.json
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button size="sm" disabled={busy || !limitValid} onClick={() => void confirm()}>
              {busy ? '打包中…' : '打包下载'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
