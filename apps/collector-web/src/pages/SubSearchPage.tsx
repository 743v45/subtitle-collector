// ── 字幕检索页（#/search；CLI sub search 的 web 形态，Phase 1）──
// URL 唯一真相：kw/regex/case/ctx/source/creator 提交后进 query（subSearchFilterUrl 序列化），
// 刷新/分享/后退还原；useAsync 以 query 串为 deps 自动重查。
// 结构（静态台账偿还拆分）：表单区 SubSearchForm、结果卡 SubSearchResultCard、高亮纯函数
// subSearchHighlight 各自成文件；本文件只留状态编排与五种互斥结果态（骨架/错误/引导/空/结果）。
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { subSearch } from '../api-extra';
import type { SubSearchResult } from '../api-extra';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { navigate, useRoute } from '../router';
import { SUB_SEARCH_DEFAULTS, subSearchFromQuery, subSearchToQuery, type SubSearchQueryState } from '../subSearchFilterUrl';
import { useAsync } from '@/lib/useAsync';
import { SubSearchForm } from './SubSearchForm';
import { SearchResultCard } from './SubSearchResultCard';

export function SubSearchPage() {
  const route = useRoute();
  const queryKey = route.query.toString();
  const f = subSearchFromQuery(route.query);

  // 表单本地回显：检索是显式动作（按钮/回车），不防抖不即时，提交才写 URL；后退/分享同步回表单
  const [form, setForm] = useState<SubSearchQueryState>(() => subSearchFromQuery(route.query));
  useEffect(() => { setForm(subSearchFromQuery(route.query)); }, [queryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const kw = form.kw.trim();
    if (!kw) return; // 关键词必填（按钮 disabled 兜底，键盘路径同防）
    const qs = subSearchToQuery({ ...form, kw }).toString();
    navigate(`/search${qs ? `?${qs}` : ''}`);
  };
  const reset = () => {
    setForm({ ...SUB_SEARCH_DEFAULTS });
    navigate('/search');
  };

  // ctx 非法（空/非数/≤0）不传，回落 server 默认 10
  const ctxNum = Number(f.ctx);
  const { data, loading, error, reload } = useAsync<SubSearchResult | null>(
    () =>
      f.kw
        ? subSearch({
            keyword: f.kw,
            regex: f.regex,
            caseSensitive: f.caseSensitive,
            ctx: Number.isFinite(ctxNum) && ctxNum > 0 ? ctxNum : undefined,
            source: f.source || undefined,
            creator: f.creator || undefined,
          })
        : Promise.resolve(null),
    [queryKey],
  );

  const items = data?.items ?? [];

  // 结果态五选一（互斥链，勿并发渲染）：骨架 → 错误（含 400 非法正则文案直出）→ 未检索引导 → 零结果 → 结果列表
  let body: ReactNode = null;
  if (loading) {
    body = (
      <div className="space-y-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  } else if (error) {
    body = (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4">
        <div className="text-sm text-destructive">检索失败：{error}</div>
        <Button variant="outline" size="sm" className="mt-2" onClick={reload}>
          重试
        </Button>
      </div>
    );
  } else if (!f.kw) {
    body = (
      <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
        输入关键词开始检索字幕内容（支持正则模式）
      </div>
    );
  } else if (data && items.length === 0) {
    body = (
      <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
        没有匹配的字幕片段——试试更换关键词或放宽筛选
      </div>
    );
  } else if (data) {
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            命中 <span className="font-medium tabular-nums text-foreground">{data.matched_videos}</span> 个视频 ·{' '}
            <span className="font-medium tabular-nums text-foreground">{data.total_snippets}</span> 个片段
          </span>
          {data.truncated && <Badge variant="secondary">结果已截断，可收紧关键词</Badge>}
        </div>
        {items.map((item) => (
          <SearchResultCard key={`${item.video.source}:${item.video.source_vid}:${item.track.id}`} item={item} f={f} />
        ))}
      </div>
    );
  } // 其余（kw 有但数据未落地的瞬态）不渲染正文，等 useAsync 翻面

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold tracking-tight">字幕检索</h2>
      <SubSearchForm value={form} onChange={setForm} onSubmit={submit} onReset={reset} />
      {body}
    </div>
  );
}
