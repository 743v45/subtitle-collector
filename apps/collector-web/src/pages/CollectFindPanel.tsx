// ── 条件采集面板（CLI collect find 的 web 形态，Phase 4 job 化；B 站专属）──
// 关键词多页搜索 → 发布时间/粉丝过滤 →（可选）命中候选自动建采集任务；整体作为 collect-find job
// 在 server 后台执行（需桌面扩展在线），本面板只负责组参提交 + JobCard 轮询进度。
// fans 过滤只读 server 库缓存：无缓存行的候选保守保留并计 unknown_fans，web 端人工复核。
// 可选数值旋钮（min/max 粉丝、时间窗、tid）仅 >0 才进 body——留空与 0 同义「不限」，缺省键位即契约。
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { JobCard } from '@/components/JobCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { createJob } from '../api-jobs';
import type { CollectFindParams, JobType } from '../api-jobs';
import { requestTaskNotifyPermission } from '../lib/taskNotify';

// 表单态 → 提交参数：keyword 去空白必填；可选数值仅 >0 才发；collect 勾选才发 true
export function buildFindParams(form: {
  keyword: string; pages: number; minFans: string; maxFans: string; sinceDays: string; tid: string; collect: boolean;
}): CollectFindParams {
  const num = (s: string): number => Math.trunc(Number(s));
  return {
    keyword: form.keyword.trim(),
    pages: form.pages,
    ...(form.minFans.trim() !== '' && num(form.minFans) > 0 ? { min_fans: num(form.minFans) } : {}),
    ...(form.maxFans.trim() !== '' && num(form.maxFans) > 0 ? { max_fans: num(form.maxFans) } : {}),
    ...(form.sinceDays.trim() !== '' && num(form.sinceDays) > 0 ? { since_days: num(form.sinceDays) } : {}),
    ...(form.tid.trim() !== '' && num(form.tid) > 0 ? { tid: num(form.tid) } : {}),
    ...(form.collect ? { collect: true } : {}),
  };
}

export function CollectFindPanel() {
  const toast = useToast();
  const [keyword, setKeyword] = useState('');
  const [pages, setPages] = useState(1);
  const [minFans, setMinFans] = useState('');
  const [maxFans, setMaxFans] = useState('');
  const [sinceDays, setSinceDays] = useState('');
  const [tid, setTid] = useState('');
  const [collect, setCollect] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const doSubmit = async (): Promise<void> => {
    if (submitting || !keyword.trim()) return;
    setSubmitting(true);
    setErr(null);
    try {
      requestTaskNotifyPermission(); // 用户手势内请求通知授权（find 跑完弹系统提醒）
      const r = await createJob('collect-find' as JobType, buildFindParams({ keyword, pages, minFans, maxFans, sinceDays, tid, collect }));
      setJobId(r.job.id);
      toast(`已提交条件采集任务 #${r.job.id}`, 'success');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        B 站专属：关键词多页搜索 → 发布时间/粉丝过滤 →（可选）自动建采集任务；server 后台执行，需桌面扩展在线。
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Input
          className="h-8 w-44" placeholder="关键词"
          aria-label="条件采集关键词"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <label className="flex items-center gap-1">
          页数
          <Select value={String(pages)} onValueChange={(v) => setPages(Number(v))}>
            <SelectTrigger className="h-8 w-16" aria-label="搜索页数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5].map((n) => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex items-center gap-1">
          粉丝 ≥
          <Input type="number" min={0} className="h-8 w-24" placeholder="不限" aria-label="最少粉丝数（留空不限）" value={minFans} onChange={(e) => setMinFans(e.target.value)} />
        </label>
        <label className="flex items-center gap-1">
          粉丝 ≤
          <Input type="number" min={0} className="h-8 w-24" placeholder="不限" aria-label="最多粉丝数（留空不限）" value={maxFans} onChange={(e) => setMaxFans(e.target.value)} />
        </label>
        <label className="flex items-center gap-1">
          近
          <Input type="number" min={1} max={365} className="h-8 w-20" placeholder="不限" aria-label="近几天内发布（1-365，留空不限）" value={sinceDays} onChange={(e) => setSinceDays(e.target.value)} />
          天内发布
        </label>
        <label className="flex items-center gap-1">
          分区 tid
          <Input type="number" min={1} className="h-8 w-24" placeholder="不限" aria-label="B 站分区 tid（可选）" value={tid} onChange={(e) => setTid(e.target.value)} />
        </label>
      </div>

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox" className="size-3.5 accent-primary"
          aria-label="命中候选自动建采集任务"
          checked={collect}
          onChange={(e) => setCollect(e.target.checked)}
        />
        命中候选自动建采集任务（已在队列/已有字幕自动跳过）
      </label>

      {err && <div className="text-sm text-destructive">{err}</div>}

      <div className="flex justify-end">
        <Button size="sm" className="h-8 px-4" disabled={!keyword.trim() || submitting} onClick={() => { void doSubmit(); }}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          提交
        </Button>
      </div>

      {jobId != null && <JobCard jobId={jobId} />}
    </div>
  );
}
