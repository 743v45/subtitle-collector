// 创作者列表筛选条（2026-10-05 自 CreatorsPage.tsx 抽出，偿还行数台账）：
// 搜索框 + 槽位三态按钮 + 分类筛选 + 排序 + 平台。顺序保持
// [0]=分类筛选 [1]=排序 [2]=平台 的 Combobox 序（既有测试按索引取，勿调换）。
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PlatformSelect } from '@/components/PlatformSelect';
import { parseSourceFilter } from '@/lib/platformSource';
import type { Category } from '@/api';

type CreatorSort = 'first_seen' | 'fans' | 'video_count';
const SORTS: readonly CreatorSort[] = ['first_seen', 'fans', 'video_count'];

export type SlotScope = 'agent' | 'human';
// 槽位筛选三态按钮：null=全部（缺省，URL 不写）——同一套分类值，只是限定看哪个槽位打的标
export const SLOT_TABS: ReadonlyArray<{ value: SlotScope | null; label: string }> = [
  { value: null, label: '全部' },
  { value: 'agent', label: 'Agent 打标' },
  { value: 'human', label: '人工打标' },
];

// URL query → 列表筛选/分页状态一次解析（非法值收敛到缺省），组件内不再逐项条件判断
export function parseRouteFilters(query: URLSearchParams) {
  const scopeRaw = query.get('scope');
  const sourceRaw = query.get('source');
  const sortRaw = query.get('sort');
  const pageRaw = Number(query.get('page'));
  return {
    q: query.get('q') ?? '',
    catFilter: query.get('cat') ?? '',
    scope: SLOT_TABS.find((t) => t.value === scopeRaw)?.value ?? null,
    source: parseSourceFilter(sourceRaw),
    sort: (SORTS as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as CreatorSort) : 'first_seen',
    page: Number.isInteger(pageRaw) && pageRaw > 1 ? pageRaw : 1,
  };
}

export function CreatorsFilterBar({
  q, onQInput, scope, onScope, catFilter, onCatFilter, sort, onSort, source, onSource, cats,
}: {
  q: string;
  onQInput: (v: string) => void;
  scope: SlotScope | null;
  onScope: (s: SlotScope | null) => void;
  catFilter: string;
  onCatFilter: (v: string | null) => void;
  sort: CreatorSort;
  onSort: (v: string | null) => void;
  source: string | null;
  onSource: (v: string | null) => void;
  cats: Category[] | null | undefined; // useAsync data 是 T | null，调用方直传
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="搜索 创作者名/ID"
        value={q}
        onChange={(e) => onQInput(e.target.value)}
        className="max-w-xs"
      />
      <div className="flex gap-1">
        {SLOT_TABS.map((t) => (
          <Button
            key={t.label}
            variant={t.value === scope ? 'default' : 'outline'}
            size="sm"
            onClick={() => onScope(t.value)}
          >
            {t.label}
          </Button>
        ))}
      </div>
      <Select value={catFilter || '__all'} onValueChange={(v) => onCatFilter(v === '__all' ? null : v)}>
        <SelectTrigger className="w-48">
          {/* 有槽位时占位符注明限定（该槽位匹配列），全部=两槽位任一 */}
          <SelectValue placeholder={scope ? `按分类筛选（${scope === 'agent' ? 'Agent' : '人工'}槽位）` : '按分类筛选'} />
        </SelectTrigger>
        <SelectContent>
          {/* 「全部」即清除入口——此前选了分类没有任何取消方式（无重置按钮，URL 还原也带着） */}
          <SelectItem value="__all">全部分类</SelectItem>
          {(cats ?? []).map((c) => (
            <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={sort} onValueChange={onSort}>
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="first_seen">首见时间</SelectItem>
          <SelectItem value="fans">粉丝数</SelectItem>
          <SelectItem value="video_count">视频数</SelectItem>
        </SelectContent>
      </Select>
      <PlatformSelect value={source} onChange={onSource} />
    </div>
  );
}

// 搜索防抖（300ms）：本地回显，停止输入后写 URL（自 CreatorsPage 原地逻辑原样搬入）
export function useDebouncedQ(q: string, commit: (v: string | null) => void) {
  const [qInput, setQInput] = useState(q);
  useEffect(() => { setQInput(q); }, [q]);
  useEffect(() => {
    const t = setTimeout(() => { if (qInput !== q) commit(qInput || null); }, 300);
    return () => clearTimeout(t);
  }, [qInput]); // 仅 qInput 变化触发防抖提交（与原 CreatorsPage 内联实现一致）
  return [qInput, setQInput] as const;
}
