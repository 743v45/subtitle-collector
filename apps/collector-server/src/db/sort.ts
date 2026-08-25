// ── 列表排序统一口径（2026-08-25 server 全端点排序）──
// 白名单 Record<排序键, SQL 表达式>（先例 advanced.ts SORT_EXPR）+ 方向 → ORDER BY 子句：
//   - 主键 tie-break 方向随主排序键（分页稳定，先例 listVideosFiltered）；
//   - 可空排序键一律 NULLS LAST（不论升降）：升序看「最早完成」时未完成（NULL）行
//     不该挤在最前——SQLite 默认 NULL 最小，ASC 会把 NULL 顶到头部，反直觉。
// 本文件只出子句构造；各模块自持键→表达式映射（表达式含别名/JOIN 前缀，归属查询所在模块）。

export type SortDir = 'ASC' | 'DESC';

export interface OrderByOpts {
  /** 排序键可空（如 finished_at/name/published_at）→ 追加 NULLS LAST */
  nullable?: boolean;
  /** tie-break 表达式（如 'v.id'）；缺省不加 tie */
  tieExpr?: string;
}

export function buildOrderBy(sortExpr: string, desc: boolean, opts: OrderByOpts = {}): string {
  const dir: SortDir = desc ? 'DESC' : 'ASC';
  const nulls = opts.nullable ? ' NULLS LAST' : '';
  const tie = opts.tieExpr ? `, ${opts.tieExpr} ${dir}` : '';
  return `ORDER BY ${sortExpr} ${dir}${nulls}${tie}`;
}

// JS 侧排序比较器（SQL ORDER BY 语义的镜像，内存合并行时用——tasks 批次补全、clients 合并视图）：
// 可空值 NULLS LAST（不论升降）+ tie 比较方向随主键。与 SQL 路径（buildOrderBy）行为必须一致。
export function cmpBySortKey<T>(a: T, b: T, key: keyof T, desc: boolean, tieKey: keyof T): number {
  const va = a[key] as string | number | null | undefined;
  const vb = b[key] as string | number | null | undefined;
  let r: number;
  if (va == null && vb == null) r = 0;
  else if (va == null) return 1;   // NULLS LAST（不论升降）
  else if (vb == null) return -1;
  else r = va < vb ? -1 : va > vb ? 1 : 0;
  if (r === 0) {
    const ta = a[tieKey] as string | number;
    const tb = b[tieKey] as string | number;
    const t = ta < tb ? -1 : ta > tb ? 1 : 0;
    return desc ? -t : t;
  }
  return desc ? -r : r;
}

// ── 跨模块共用的排序键清单（2026-08-25 全端点排序）──

// collect_tasks 排序键（键名即列名）：created_at（缺省 ≡ 旧 t.id DESC）、finished_at（NULLS LAST）、status（字典序）。
export type TaskSortKey = 'created_at' | 'finished_at' | 'status';
export const TASK_SORT_KEYS: readonly TaskSortKey[] = ['created_at', 'finished_at', 'status'];

// 聚合榜排序键：count=计数、key=分组值本身。tie：count 排序同计数按 key ASC；key 分组值唯一无 tie。
export type AggregateSortKey = 'count' | 'key';
export const AGG_SORT_KEYS: readonly AggregateSortKey[] = ['count', 'key'];
export function aggOrderBy(sort: AggregateSortKey, desc: boolean): string {
  const dir: SortDir = desc ? 'DESC' : 'ASC';
  return sort === 'count' ? `count ${dir}, key ASC` : `key ${dir}, count DESC`;
}

// change_log 排序键：只有 changed_at 有时间语义（entity/field/new_value 是文本，排序无意义）。
export type ChangeSortKey = 'changed_at';
export const CHANGE_SORT_KEYS: readonly ChangeSortKey[] = ['changed_at'];
