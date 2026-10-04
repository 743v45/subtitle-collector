// ── 补翻工作台（#/translate?vid=<source>:<source_vid>&from=<lan>）──
// 左=行号+原文（只读），右=译文填写（Phase 3 写回）：textarea 每行一条译文（多行粘贴可），
// 实时行数校验（译文 N 行 / 原文 M 行，不符标红+禁写回），支持从文本文件载入；
// 提交 translateFill → 写入 zh-manual 轨（时间轴 server 从源轨拷贝）。
// vid 形态 <source>:<source_vid>（首个冒号切分，source_vid 本身可含冒号）。
import { useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { translateFill, translateSource } from '../api-extra';
import type { TranslateSourceResult } from '../api-extra';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/components/ui/toast';
import { ExtLink } from '@/components/ExtLink';
import { videoUrl } from '../lib/externalLinks';
import { useQueryUpdater } from '../router';
import { ArrowLeft } from 'lucide-react';

// 译文草稿 → 行数组：空草稿=0 行；容忍 \r\n / \r；结尾单个换行不算多一行
// （多行粘贴尾随换行是常态，不算行数不符；中间空行保留占位——fill 契约空行合法）
export function splitFillLines(draft: string): string[] {
  if (draft.trim() === '') return [];
  return draft.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '').split('\n');
}

export function TranslateWorkbench({ vid, from }: { vid: string; from: string }) {
  const updateQuery = useQueryUpdater();
  const ci = vid.indexOf(':');
  const source = ci > 0 ? vid.slice(0, ci) : '';
  const sourceVid = ci > 0 ? vid.slice(ci + 1) : '';

  const { data, loading, error, reload } = useAsync<TranslateSourceResult | null>(
    () => (source && sourceVid ? translateSource(source, sourceVid, from || undefined) : Promise.resolve(null)),
    [vid, from],
  );

  // 返回清单：vid 与 from（查看语言）一并清除；其余 query（如清单筛选 source）原样保留
  const back = () => updateQuery({ vid: null, from: null });

  const header = <WorkbenchHeader onBack={back} />;

  if (!source || !sourceVid) {
    return (
      <div className="space-y-4">
        {header}
        <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
          无效的 vid 参数（应为 source:source_vid 形态）
        </div>
      </div>
    );
  }

  // 三态互斥：骨架 → 错误（文案+重试+返回清单）→ 源文渲染
  let body: ReactNode = null;
  if (loading) {
    body = (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  } else if (error) {
    body = (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4">
        <div className="text-sm text-destructive">拉取源文失败：{error}</div>
        <div className="mt-2 flex gap-2">
          <Button variant="outline" size="sm" onClick={reload}>
            重试
          </Button>
          <Button variant="ghost" size="sm" onClick={back}>
            返回清单
          </Button>
        </div>
      </div>
    );
  } else if (data) {
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{data.source}:{data.source_vid}</span>
          <Badge variant="outline" className="font-normal">{data.lan}</Badge>
          <span>版本 #{data.version_id}</span>
          <ExtLink href={videoUrl(data.source, data.source_vid)} label="在原站打开视频" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {/* 左：源文（行号 + 原文，只读） */}
          <div className="overflow-hidden rounded-lg border">
            <div className="border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">源文（{data.lan}）</div>
            <div className="divide-y">
              {data.lines.map((ln) => (
                <div key={ln.line} className="flex gap-3 px-3 py-1.5 text-sm leading-relaxed">
                  <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">{ln.line}</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap">{ln.text}</span>
                </div>
              ))}
            </div>
          </div>
          {/* 右：译文填写与写回（Phase 3）——行数校验/文件载入/提交在 FillPanel */}
          <FillPanel source={data.source} sourceVid={data.source_vid} fromLan={data.lan} total={data.lines.length} />
        </div>
      </div>
    );
  } // 数据未落地的瞬态不渲染正文，等 useAsync 翻面

  return (
    <div className="space-y-4">
      {header}
      {body}
    </div>
  );
}

function WorkbenchHeader({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" />
        返回清单
      </Button>
      <h2 className="text-xl font-semibold tracking-tight">补翻工作台</h2>
    </div>
  );
}

// 右栏：译文编辑 + 写回。行数与原文一一对应（空行=保留占位），不符则标红且禁写回；
// 提交成功提示「已写入 zh-manual（N 行）」并给详情页链接（轨/版本查看见详情）。
function FillPanel({ source, sourceVid, fromLan, total }: { source: string; sourceVid: string; fromLan: string; total: number }) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [written, setWritten] = useState<number | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const lines = splitFillLines(draft);
  const matched = total > 0 && lines.length === total;

  // 从文件载入：纯文本按行拆进草稿（html file input 藏在 label 里，Button asChild 出样式）
  function onFile(ev: ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    void file.text().then((t) => setDraft(t));
    ev.target.value = ''; // 允许重复选择同一文件
  }

  async function onWriteBack() {
    if (!matched || submitting) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const r = await translateFill({ source, source_vid: sourceVid, from_lan: fromLan, lines });
      setWritten(r.lines);
      toast(`已写入 zh-manual（${r.lines} 行）`, 'success');
    } catch (e: unknown) {
      // 400 行数不符等 server 文案原样透出（含 expected/got，正是用户要看的对账信息）
      setSubmitErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[200px] flex-col rounded-lg border">
      <div className="border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">译文（zh-manual，每行一条）</div>
      <textarea
        aria-label="译文（每行一条）"
        className="min-h-[240px] w-full flex-1 resize-y bg-transparent p-3 font-mono text-sm leading-relaxed focus:outline-none"
        placeholder={`在此粘贴/输入译文，与左侧原文逐行对应（共 ${total} 行）。\n空行 = 该行保留占位；也可点「从文件载入」读入整份文本。`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="space-y-2 border-t p-3">
        {/* 实时行数对账：不符标红（写回按钮随之禁用） */}
        <div className={matched ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'} role="status" data-testid="fill-line-count">
          译文 {lines.length} 行 / 原文 {total} 行
          {lines.length === 0 && '（粘贴或载入译文后写回）'}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <label className="cursor-pointer">
              从文件载入
              <input type="file" accept=".txt,.srt,.vtt,.md,text/plain" className="hidden" onChange={onFile} />
            </label>
          </Button>
          <Button size="sm" disabled={!matched || submitting} onClick={() => void onWriteBack()}>
            {submitting ? '写回中…' : '写回 zh-manual 轨'}
          </Button>
        </div>
        {written != null && (
          <div className="text-xs text-emerald-600" role="status" data-testid="fill-ok">
            已写入 zh-manual（{written} 行），轨道查见{' '}
            <a className="underline" href={`#/videos/${source}/${encodeURIComponent(sourceVid)}`}>详情页</a>
          </div>
        )}
        {submitErr && (
          <div className="text-xs text-destructive" role="alert" data-testid="fill-err">
            写回失败：{submitErr}
          </div>
        )}
      </div>
    </div>
  );
}
