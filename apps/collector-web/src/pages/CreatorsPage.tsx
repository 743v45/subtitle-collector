// 创作者管理页（2026-10-05 表格/筛选条/批量条抽至 CreatorsTable / CreatorsFilterBar / CreatorsBatchBar）。
// Q6a 批量分类：勾选行 → 批量操作条 → setCreatorsCategoryBatch（不变=丢键，清除=null，具体=id）。
// Q6b 刷新资料：行内按钮（仅 bilibili）→ refreshCreatorProfile → 成功刷新列表。
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useAsync } from '@/lib/useAsync';
import { useQueryUpdater, useRoute } from '../router';
import { listCategories, listCreators, setCreatorCategory, refreshCreatorProfile, setCreatorsCategoryBatch, type Category, type CreatorListItem } from '@/api';
import { CreatorsBatchBar, batchArg, type BatchSlotChoice } from './CreatorsBatchBar';
import { CreatorsFilterBar, parseRouteFilters, useDebouncedQ, type SlotScope } from './CreatorsFilterBar';
import { CreatorsTable } from './CreatorsTable';

const PAGE_SIZE = 20;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function CreatorsPage({ onOpen }: { onOpen: (id: number) => void }) {
  const toast = useToast();
  // 筛选/页码进 URL（#/creators?q=…&sort=fans&page=2），刷新/后退还原；q 输入本地防抖后写 URL
  const route = useRoute();
  const updateQuery = useQueryUpdater();
  const setFilter = (patch: Record<string, string | null | undefined>) => updateQuery(patch, { resetPage: true });
  const { q, catFilter, scope, source, sort, page } = parseRouteFilters(route.query);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  // 搜索防抖（300ms）：本地回显，停止输入后写 URL
  const [qInput, setQInput] = useDebouncedQ(q, (v) => setFilter({ q: v }));

  // 列表：useAsync 驱动，error 显式落到 UI（不再 .catch 静默吞）。
  // scope 独立于 catFilter（三态筛选）：有值时 server 按对应槽位筛（配合 cat=该槽位匹配列 / 单独=该槽位已打标），null=不限槽位
  const { data: listResult, loading, error, reload } = useAsync(
    () => listCreators({
      q: q || undefined,
      category: catFilter || undefined,
      scope: scope ?? undefined,
      source: source ?? undefined,
      sort,
      page,
      size: PAGE_SIZE,
    }),
    [q, catFilter, scope, source, sort, page],
  );
  const items = listResult?.items ?? [];
  const total = listResult?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 一套共享分类值：筛选下拉、行内两个编辑下拉、批量条共用同一次拉取
  const { data: cats } = useAsync<Category[]>(() => listCategories(), []);

  // ── Q6a 批量选择与应用 ──
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [agentChoice, setAgentChoice] = useState<BatchSlotChoice>('keep');
  const [humanChoice, setHumanChoice] = useState<BatchSlotChoice>('keep');

  function toggleRow(c: CreatorListItem) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === items.length && items.every((c) => prev.has(c.id))
      ? new Set<number>()
      : new Set(items.map((c) => c.id))));
  }

  const allSelected = items.length > 0 && items.every((c) => selected.has(c.id));

  // 批量应用：keep=不传键（undefined 经 JSON.stringify 丢弃）、清除=null、分类=传 id；
  // 成功清空勾选并刷新；失败 toast 带上下文（ids 数、两槽位参数），勾选保留便于重试
  async function applyBatch() {
    const ids = items.filter((c) => selected.has(c.id)).map((c) => c.id);
    if (ids.length === 0) return;
    setBatchBusy(true);
    try {
      const { updated } = await setCreatorsCategoryBatch(ids, batchArg(agentChoice), batchArg(humanChoice));
      toast(`已更新 ${updated} 个创作者`, 'success');
      setSelected(new Set());
      setAgentChoice('keep');
      setHumanChoice('keep');
      reload();
    } catch (e: unknown) {
      toast(`批量分类失败：${errMsg(e)}（ids=${ids.length} 个，agent=${agentChoice} human=${humanChoice}）`, 'error');
    } finally {
      setBatchBusy(false);
    }
  }

  // ── 行内单改分类（原有逻辑） ──
  async function changeCategory(c: CreatorListItem, catScope: 'agent' | 'human', name: string) {
    setBusyUid(c.source_uid);
    try {
      // 平台段必传：uid 两平台命名空间独立（B 站 mid / YouTube channelId），不带会写错行
      await setCreatorCategory(c.source, c.source_uid, catScope, name);
      toast('已更新', 'success');
      reload();
    } catch (e: unknown) {
      toast(`失败：${errMsg(e)}`, 'error');
    } finally {
      setBusyUid(null);
    }
  }

  // ── Q6b 刷新资料（仅 bilibili 行渲染入口） ──
  async function refreshProfile(c: CreatorListItem) {
    setRefreshingId(c.id);
    try {
      await refreshCreatorProfile(c.id);
      toast(`资料已刷新：${c.name ?? c.source_uid}`, 'success');
      reload();
    } catch (e: unknown) {
      toast(`刷新资料失败：${errMsg(e)}（id=${c.id} ${c.source_uid}）`, 'error');
    } finally {
      setRefreshingId(null);
    }
  }

  function switchScope(s: SlotScope | null) {
    if (s === scope) return;
    updateQuery({ scope: s }, { resetPage: true });
  }

  const hasFilter = Boolean(q || catFilter || source);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">创作者管理</h2>
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>

      <CreatorsFilterBar
        q={qInput}
        onQInput={setQInput}
        scope={scope}
        onScope={switchScope}
        catFilter={catFilter}
        onCatFilter={(v) => setFilter({ cat: v })}
        sort={sort}
        onSort={(v) => setFilter({ sort: v === 'first_seen' ? null : v })}
        source={source}
        onSource={(v) => setFilter({ source: v })}
        cats={cats}
      />

      {selected.size > 0 && (
        <CreatorsBatchBar
          count={selected.size}
          cats={cats}
          busy={batchBusy}
          agentChoice={agentChoice}
          humanChoice={humanChoice}
          onAgentChoice={setAgentChoice}
          onHumanChoice={setHumanChoice}
          onApply={applyBatch}
          onClearSelection={() => setSelected(new Set())}
        />
      )}

      <div className="overflow-hidden rounded-md border" aria-busy={loading || undefined}>
        <CreatorsTable
          items={items}
          cats={cats}
          loading={loading}
          error={error}
          reload={reload}
          busyUid={busyUid}
          refreshingId={refreshingId}
          selected={selected}
          allSelected={allSelected}
          onToggleRow={toggleRow}
          onToggleAll={toggleAll}
          onOpen={onOpen}
          onCategoryChange={changeCategory}
          onRefreshProfile={refreshProfile}
          emptyHint={hasFilter ? '没有匹配的创作者——试试放宽搜索或筛选' : '暂无创作者——采集视频后创作者会自动入库'}
        />
      </div>

      <div className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
        <div className="tabular-nums">第 {page}/{totalPages} 页</div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => updateQuery({ page: page - 1 > 1 ? String(page - 1) : null })}>上一页</Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages || total === 0} onClick={() => updateQuery({ page: String(page + 1) })}>下一页</Button>
        </div>
      </div>
    </div>
  );
}
