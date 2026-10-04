// ── 补翻 pending 清单（#/translate 无 vid 时；CLI translate pending 的 web 形态，Phase 1）──
// 待补翻视频表：平台/源语言筛选（写 query + resetPage）、分页（对齐 VideoList 范式）、
// langs chips 即工作台入口。工作台视图见 TranslateWorkbench.tsx，路由分发见 TranslatePage.tsx。
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { translatePending } from '../api-extra';
import type { TranslatePendingItem } from '../api-extra';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useAsync } from '@/lib/useAsync';
import { PlatformSelect } from '@/components/PlatformSelect';
import { PlatformIcon, platformIconClass } from '@/components/PlatformIcon';
import { ExtLink } from '@/components/ExtLink';
import { videoUrl } from '../lib/externalLinks';
import { useQueryUpdater, useRoute } from '../router';

const PAGE_SIZE = 20;

function formatTs(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN');
}

// 秒 → m:ss / h:mm:ss
function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function TranslatePendingList() {
  const route = useRoute();
  const updateQuery = useQueryUpdater();
  const q = route.query;

  // URL 解析（三参：source/from/page；筛选变更 resetPage 回第 1 页）
  const source = q.get('source') ?? '';
  const from = q.get('from') ?? '';
  const pageNum = Number(q.get('page'));
  const page = Number.isInteger(pageNum) && pageNum > 0 ? pageNum : 1;

  const setFilter = (patch: Record<string, string | null | undefined>) => updateQuery(patch, { resetPage: true });

  // 源语言输入框：本地回显 + 300ms 防抖写 URL（对齐 VideoList q/sq 范式）
  const [fromInput, setFromInput] = useState(from);
  useEffect(() => { setFromInput(from); }, [from]);
  useEffect(() => {
    const t = setTimeout(() => { if (fromInput !== from) setFilter({ from: fromInput || null }); }, 300);
    return () => clearTimeout(t);
  }, [fromInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const queryKey = route.query.toString();
  const { data, loading, error, reload } = useAsync(
    () => translatePending({ source: source || undefined, from: from || undefined, page, size: PAGE_SIZE }),
    [queryKey],
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 进工作台：lan=null（行点击）沿用当前 from 筛选作为查看语言；lan 传值（chip 点击）以该轨语言覆盖
  const openPending = (v: TranslatePendingItem, lan: string | null) => {
    const key = `${v.source}:${v.source_vid}`;
    updateQuery(lan === null ? { vid: key } : { vid: key, from: lan });
  };

  // 表体四态互斥：骨架 → 错误（文案+重试）→ 空态 → 数据行
  let rows: ReactNode;
  if (loading) {
    rows = Array.from({ length: 5 }).map((_, i) => (
      <TableRow key={`sk-${i}`}>
        <TableCell className="pl-3"><Skeleton className="h-5 w-full max-w-64" /></TableCell>
        <TableCell className="hidden md:table-cell"><Skeleton className="h-4 w-16" /></TableCell>
        <TableCell className="hidden sm:table-cell"><Skeleton className="ml-auto h-4 w-10" /></TableCell>
        <TableCell className="hidden xl:table-cell"><Skeleton className="h-4 w-20" /></TableCell>
        <TableCell><Skeleton className="h-4 w-24" /></TableCell>
      </TableRow>
    ));
  } else if (error) {
    rows = (
      <TableRow>
        <TableCell colSpan={5} className="py-6 text-center">
          <div className="text-sm text-destructive">加载失败：{error}</div>
          <Button variant="outline" size="sm" className="mt-2" onClick={reload}>
            重试
          </Button>
        </TableCell>
      </TableRow>
    );
  } else if (items.length === 0) {
    rows = (
      <TableRow>
        <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
          没有待补翻视频
        </TableCell>
      </TableRow>
    );
  } else {
    rows = items.map((v) => <PendingRow key={`${v.source}:${v.source_vid}`} v={v} onOpen={openPending} />);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">补翻</h2>
        <span className="text-sm text-muted-foreground">
          共 <span className="font-medium tabular-nums text-foreground">{total}</span> 条待补翻
        </span>
      </div>

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        <PlatformSelect value={source || null} onChange={(v) => setFilter({ source: v })} />
        <Input
          className="w-[160px]"
          placeholder="源语言，如 en/ja"
          aria-label="源语言"
          value={fromInput}
          onChange={(e) => setFromInput(e.target.value)}
        />
      </div>

      {/* 分页（对齐 VideoList 分页控件范式，页码进 query） */}
      <div className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
        <div className="tabular-nums">第 {page}/{totalPages} 页</div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => updateQuery({ page: page - 1 > 1 ? String(page - 1) : null })}>
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || total === 0}
            onClick={() => updateQuery({ page: String(page + 1) })}
          >
            下一页
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border shadow-sm" aria-busy={loading || undefined}>
        <Table className="table-fixed">
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-3">标题</TableHead>
              <TableHead className="hidden w-32 md:table-cell">创作者</TableHead>
              <TableHead className="hidden w-16 text-right sm:table-cell">时长</TableHead>
              <TableHead className="hidden w-36 xl:table-cell">发布时间</TableHead>
              <TableHead className="w-[30%]">源轨</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{rows}</TableBody>
        </Table>
      </div>
    </div>
  );
}

function PendingRow({ v, onOpen }: { v: TranslatePendingItem; onOpen: (v: TranslatePendingItem, lan: string | null) => void }) {
  return (
    // 整行点击进工作台（不指定查看语言 → 沿用清单 from 筛选）；ExtLink 自带 stopPropagation 不误触
    <TableRow onClick={() => onOpen(v, null)} className="cursor-pointer">
      <TableCell className="pl-3">
        <div className="flex items-center gap-1.5">
          <PlatformIcon source={v.source} className={cn('h-3.5 w-3.5 shrink-0', platformIconClass(v.source))} />
          <span className="min-w-0 truncate" title={v.title}>{v.title}</span>
          <ExtLink href={videoUrl(v.source, v.source_vid)} label="在原站打开视频" />
        </div>
      </TableCell>
      <TableCell className="hidden truncate text-muted-foreground md:table-cell" title={v.creator_name ?? undefined}>
        {v.creator_name ?? '—'}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatDuration(v.duration) || '—'}</TableCell>
      <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground xl:table-cell">
        {v.published_at ? formatTs(v.published_at) : '—'}
      </TableCell>
      <TableCell>
        {/* chips 即入口：点某条源轨 → 以该语言打开工作台；容器拦冒泡防触发整行点击 */}
        {v.langs.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {v.langs.map((l, i) =>
              l.lan ? (
                <button
                  key={i}
                  type="button"
                  className="cursor-pointer rounded border px-1.5 py-0.5 text-xs transition-colors hover:bg-muted"
                  title={`以 ${l.lan_doc ?? l.lan} 源轨打开补翻工作台`}
                  onClick={() => onOpen(v, l.lan)}
                >
                  {l.lan_doc ?? l.lan}
                  {l.lines != null ? ` (${l.lines}行)` : ''}
                </button>
              ) : (
                <span key={i} className="text-xs text-muted-foreground">未知语言</span>
              ),
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
