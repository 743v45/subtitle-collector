// ── 无字幕转写兜底（ASR）提交卡（CLI asr backfill 的 web 形态，Phase 4 job 化）──
// 表单（平台/每轮条数/时长上限）→「预览圈定」dry_run 同步直答不建 job；「提交转写」建后台 job →
// JobCard 轮询进度。转写成功即摘 no-subtitle 标，重跑自动只剩未完成的（断点续跑语义在 server）。
// bilibili 未配 cookie 不拦截提交：server 回包带 warning（need_login 必然）原样黄条透出，由用户裁量。
import { useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { JobCard } from '@/components/JobCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { createJob, dryRunAsrCircle } from '../api-jobs';
import type { AsrBackfillParams, AsrDryRunItem, JobType } from '../api-jobs';
import { requestTaskNotifyPermission } from '../lib/taskNotify';

// 秒 → m:ss（抖音 duration 库存已是秒；B 站详情 duration 同为秒）
function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 表单态 → 提交参数：size 空串/非法回落 5（server 口径 1..50）；max_duration 仅 >0 才发（留空不限）
export function buildAsrParams(source: string, sizeStr: string, maxDurStr: string): AsrBackfillParams {
  const size = Math.min(50, Math.max(1, Math.trunc(Number(sizeStr)) || 5));
  const md = Math.trunc(Number(maxDurStr));
  return {
    source: source === 'douyin' ? 'douyin' : 'bilibili',
    size,
    ...(maxDurStr.trim() !== '' && Number.isFinite(md) && md > 0 ? { max_duration: md } : {}),
  };
}

export function AsrBackfillCard() {
  const toast = useToast();
  const [source, setSource] = useState('bilibili');
  const [size, setSize] = useState('5');
  const [maxDur, setMaxDur] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<AsrDryRunItem[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const doPreview = async (): Promise<void> => {
    if (previewing) return;
    setPreviewing(true);
    setErr(null);
    try {
      setPreview(await dryRunAsrCircle(buildAsrParams(source, size, maxDur)));
    } catch (e) {
      setPreview(null);
      setErr((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const doSubmit = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setErr(null);
    setWarning(null);
    try {
      requestTaskNotifyPermission(); // 用户手势内请求通知授权（转写跑完弹系统提醒）
      const r = await createJob('asr-backfill' as JobType, buildAsrParams(source, size, maxDur));
      setJobId(r.job.id);
      setWarning(r.warning ?? null);
      toast(`已提交转写任务 #${r.job.id}`, 'success');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">无字幕转写兜底（ASR）</div>
          <div className="text-xs text-muted-foreground">
            圈定 no-subtitle 视频 → 服务端拉音/视频 → fireredasr 转写 → 写回 asr-zh 轨；成功即摘标，重跑自动续。
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Select value={source} onValueChange={(v) => setSource(v)}>
            <SelectTrigger className="h-8 w-24" aria-label="转写平台">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bilibili">B 站</SelectItem>
              <SelectItem value="douyin">抖音</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-1">
            每轮条数
            <Input
              type="number" min={1} max={50} className="h-8 w-20"
              aria-label="每轮条数（1-50）"
              value={size}
              onChange={(e) => setSize(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1">
            时长上限
            <Input
              type="number" min={1} className="h-8 w-24" placeholder="不限"
              aria-label="时长上限秒（留空不限）"
              value={maxDur}
              onChange={(e) => setMaxDur(e.target.value)}
            />
            秒
          </label>
          <Button variant="outline" size="sm" className="h-8 px-3" disabled={previewing} onClick={() => { void doPreview(); }}>
            {previewing ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            预览圈定
          </Button>
          <Button size="sm" className="h-8 px-3" disabled={submitting} onClick={() => { void doSubmit(); }}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            提交转写
          </Button>
        </div>

        {err && <div className="text-sm text-destructive">{err}</div>}
        {warning && (
          <div role="alert" className="rounded bg-amber-500/15 px-2 py-1.5 text-sm text-amber-400">
            {warning}
          </div>
        )}

        {preview != null && (
          <div className="space-y-1 rounded-md bg-muted/30 p-2">
            <div className="text-xs text-muted-foreground">
              圈定 <span className="tabular-nums text-foreground">{preview.length}</span> 个待转写视频
            </div>
            {preview.length === 0 ? (
              <div className="py-2 text-center text-sm text-muted-foreground">没有 no-subtitle 视频</div>
            ) : (
              <div className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
                {preview.map((it) => (
                  <div key={it.source_vid} className="flex items-center gap-2 text-sm">
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{it.source_vid}</span>
                    <span className="min-w-0 flex-1 truncate" title={it.title ?? it.source_vid}>{it.title ?? it.source_vid}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{it.duration != null ? fmtDur(it.duration) : '?'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {jobId != null && <JobCard jobId={jobId} />}
      </CardContent>
    </Card>
  );
}
