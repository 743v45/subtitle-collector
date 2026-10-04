// ── 搜索采集（CLI collect search 的 web 形态；server 进程编排，经扩展拉平台搜索结果）──
// 平台 + 关键词搜索 → 候选列表（已采/已入库无字幕徽章 + 勾选）→ 批量建采集任务。
// B 站高级项：分区 tid（可选）；YouTube 高级项：排序 / 翻页数 1..5 / 近 N 天 1..365。
// 搜索态不进 URL（临时性探索操作，与清单筛选的深链语义不同）；503=扩展离线统一文案。
import { useState } from 'react';
import { CollectFindPanel } from './CollectFindPanel';
import { collectSearch } from '../api-extra';
import type { CollectSearchCandidate } from '../api-extra';
import { createCollectTasksBatch } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Loader2, Search } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { collectErrorText } from '../lib/collectErrors';

type SearchSource = 'bilibili' | 'youtube';

// 候选唯一键与采集 vid：bilibili 用 bvid，youtube 用 vid
const candKey = (c: CollectSearchCandidate): string => c.bvid ?? c.vid ?? '';

// 已采/入库徽章：has_subtitle=已采（绿）；入库无字幕=灰；未采不标
function CandBadge({ c }: { c: CollectSearchCandidate }) {
  if (c.has_subtitle) return <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">已采</span>;
  if (c.exists) return <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">已入库·无字幕</span>;
  return null;
}

// 候选行：勾选 + 标题/作者/播放·时长 + 徽章
function CandRow({ c, checked, onToggle }: { c: CollectSearchCandidate; checked: boolean; onToggle: () => void }) {
  const meta = [
    c.play != null ? `${c.play.toLocaleString('zh-CN')} 播放` : '',
    c.duration != null || c.length != null ? `时长 ${c.length ?? fmtDur(c.duration ?? 0)}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <label className={cn('flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm transition-colors', checked ? 'bg-primary/10' : 'hover:bg-muted/60')}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="size-3.5 shrink-0 accent-primary" aria-label={`选择 ${c.title ?? candKey(c)}`} />
      <span className="min-w-0 flex-1 truncate" title={c.title}>{c.title ?? candKey(c)}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{[c.up, meta].filter(Boolean).join(' · ')}</span>
      <CandBadge c={c} />
    </label>
  );
}

// 秒 → mm:ss（bilibili duration 为秒；youtube length 服务端已格式化，直接透出）
function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function CollectSearchSection({ onTasksChanged }: { onTasksChanged: () => void }) {
  const toast = useToast();
  // 采集模式：quick=快速搜索（现有直连形态）；find=条件采集（CLI collect find 的 job 化形态）
  const [mode, setMode] = useState<'quick' | 'find'>('quick');
  const [source, setSource] = useState<SearchSource>('bilibili');
  const [keyword, setKeyword] = useState('');
  // YouTube 高级项：order 缺省 relevance；pages 1..5；sinceDays 0=不限（不发 since_days）
  const [order, setOrder] = useState<'relevance' | 'newest' | 'views'>('relevance');
  const [pages, setPages] = useState(1);
  const [sinceDays, setSinceDays] = useState(0);
  // B 站高级项：分区 tid（空串=不限）
  const [tid, setTid] = useState('');
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CollectSearchCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const doSearch = async () => {
    const kw = keyword.trim();
    if (!kw || searching) return;
    setSearching(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await collectSearch({
        source,
        keyword: kw,
        ...(source === 'youtube' ? { order, pages, sinceDays: sinceDays > 0 ? sinceDays : undefined } : { tid: Number(tid) > 0 ? Number(tid) : undefined }),
      });
      setResult(r.items);
      setSelected(new Set());
    } catch (e: unknown) {
      setErr(collectErrorText(e));
      setResult(null);
    } finally {
      setSearching(false);
    }
  };

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const submitBatch = async () => {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    setMsg(null);
    try {
      const r = await createCollectTasksBatch([...selected], source);
      const parts = [`已创建 ${r.created} 个任务`];
      if (r.skipped) parts.push(`跳过 ${r.skipped} 个（已在队列）`);
      if (r.skippedCollected) parts.push(`已采跳过 ${r.skippedCollected} 个`);
      const text = parts.join('，');
      setMsg({ ok: true, text });
      toast(text, 'success');
      setSelected(new Set());
      onTasksChanged();
    } catch (e: unknown) {
      const text = collectErrorText(e);
      setMsg({ ok: false, text });
      toast(`批量提交失败：${text}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        {/* 标题行右侧模式切换：快速搜索（直连）/ 条件采集（collect-find job）互斥 */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-sm font-medium">搜索采集</div>
          <Select value={mode} onValueChange={(v) => setMode(v as 'quick' | 'find')}>
            <SelectTrigger className="h-8 w-28" aria-label="采集模式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="quick">快速搜索</SelectItem>
              <SelectItem value="find">条件采集</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {mode === 'find' ? (
          <CollectFindPanel />
        ) : (
          <>
        <div className="flex gap-2">
          <Select value={source} onValueChange={(v) => { setSource(v as SearchSource); setResult(null); setErr(null); }}>
            <SelectTrigger className="h-10 w-28" aria-label="搜索平台">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bilibili">B 站</SelectItem>
              <SelectItem value="youtube">YouTube</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="h-10 flex-1"
            placeholder={source === 'bilibili' ? 'B 站搜索关键词（需桌面扩展在线）' : 'YouTube 搜索关键词（需桌面扩展在线）'}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }}
          />
          <Button className="h-10 px-4" disabled={searching || !keyword.trim()} onClick={() => void doSearch()}>
            {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            搜索
          </Button>
        </div>

        {/* 高级项随平台切换：YouTube=排序/页数/时间窗；B 站=分区 tid */}
        {source === 'youtube' ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Select value={order} onValueChange={(v) => setOrder(v as typeof order)}>
              <SelectTrigger className="h-8 w-28" aria-label="排序">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="relevance">相关性优先</SelectItem>
                <SelectItem value="newest">最新发布</SelectItem>
                <SelectItem value="views">最多播放</SelectItem>
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1">
              页数
              <Select value={String(pages)} onValueChange={(v) => setPages(Number(v))}>
                <SelectTrigger className="h-8 w-16" aria-label="翻页数">
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
              近
              <Input
                type="number" min={1} max={365} className="h-8 w-20"
                aria-label="近几天内发布（1-365，留空不限）"
                value={sinceDays > 0 ? String(sinceDays) : ''}
                onChange={(e) => setSinceDays(Math.min(365, Math.max(0, Number(e.target.value) || 0)))}
              />
              天内
            </label>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-1">
              分区 tid
              <Input
                type="number" min={1} className="h-8 w-24" placeholder="不限"
                aria-label="B 站分区 tid（可选）"
                value={tid}
                onChange={(e) => setTid(e.target.value)}
              />
            </label>
          </div>
        )}

        {err && <div className="text-sm text-destructive">{err}</div>}

        {result && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              共 <span className="tabular-nums text-foreground">{result.length}</span> 条结果，勾选后批量建采集任务
            </div>
            <div className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
              {result.map((c) => (
                <CandRow key={candKey(c)} c={c} checked={selected.has(candKey(c))} onToggle={() => toggle(candKey(c))} />
              ))}
              {result.length === 0 && <div className="py-4 text-center text-sm text-muted-foreground">无搜索结果</div>}
            </div>
            {msg && <div role="status" className={cn('text-sm', msg.ok ? 'text-emerald-700' : 'text-destructive')}>{msg.text}</div>}
            <div className="flex items-center justify-end">
              <Button size="sm" disabled={selected.size === 0 || submitting} onClick={() => void submitBatch()}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                采集勾选 ({selected.size})
              </Button>
            </div>
          </div>
        )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
