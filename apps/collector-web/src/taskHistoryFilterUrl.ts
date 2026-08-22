// ── 采集历史页筛选 ↔ URL query 序列化（纯函数，2026-08-22 多维查询）──
// 镜像 videoFilterUrl 范式：URL 为唯一真相，组件从 query 派生 state，变更时 replace 写回。
// 约定：空值/默认值省略（默认态 URL 就是干净的 #/history）；page/日期一律字符串透传，类型转换在组件层。
//
// creator 判别在序列化层：输入纯数字 → creator_uid（mid 精确），否则 → creator（UP 名模糊）；
// fromQuery 还原时 uid 优先，roundtrip 成立。
// range 互斥：preset（today/7d/30d）激活时不写 since_date/until_date（避免双真相，since 组件层按
// 「现在」重算）；custom 档只写日期串。
export interface TaskHistoryQueryState {
  status: string;      // 状态档 key（''=全部 / 'pending,dispatched' / 'succeeded' / 'limited' / 'failed'）
  source: string;      // '' | 'bilibili' | 'youtube'
  creator: string;     // UP 名或 B站 mid（输入框原样单串，判别见上）
  q: string;           // 标题关键词
  range: '' | 'today' | '7d' | '30d' | 'custom';
  sinceDate: string;   // YYYY-MM-DD（custom 档）
  untilDate: string;
  batchId: string;
  batch: '' | 'batch' | 'single'; // 批量/单点档：batch=批量提交(batch_id 非空)，single=单条/旧任务
  page: number;
}

export const TASK_HISTORY_DEFAULTS: TaskHistoryQueryState = {
  status: '', source: '', creator: '', q: '', range: '', sinceDate: '', untilDate: '', batchId: '', batch: '', page: 1,
};

const RANGE_PRESETS: readonly string[] = ['today', '7d', '30d'];

// 纯数字输入按 mid 精确查（creator_uid）；其余按 UP 名模糊（creator）
export function isMidLike(input: string): boolean {
  return /^\d+$/.test(input);
}

export function taskHistoryFromQuery(q: URLSearchParams): TaskHistoryQueryState {
  const rangeRaw = q.get('range');
  const pageRaw = Number(q.get('page'));
  const hasDate = !!(q.get('since_date') || q.get('until_date'));
  const range = RANGE_PRESETS.includes(rangeRaw ?? '')
    ? (rangeRaw as TaskHistoryQueryState['range'])
    : hasDate ? 'custom' : '';
  return {
    status: q.get('status') ?? '',
    source: q.get('source') ?? '',
    creator: q.get('creator_uid') ?? q.get('creator') ?? '',
    q: q.get('q') ?? '',
    range,
    sinceDate: q.get('since_date') ?? '',
    untilDate: q.get('until_date') ?? '',
    batchId: q.get('batch_id') ?? '',
    batch: q.get('batch') === 'batch' || q.get('batch') === 'single' ? q.get('batch') as TaskHistoryQueryState['batch'] : '',
    page: Number.isInteger(pageRaw) && pageRaw > 1 ? pageRaw : 1,
  };
}

export function taskHistoryToQuery(s: TaskHistoryQueryState): URLSearchParams {
  const u = new URLSearchParams();
  if (s.status) u.set('status', s.status);
  if (s.source) u.set('source', s.source);
  if (s.creator) u.set(isMidLike(s.creator) ? 'creator_uid' : 'creator', s.creator);
  if (s.q) u.set('q', s.q);
  if (s.range === 'custom') {
    if (s.sinceDate) u.set('since_date', s.sinceDate);
    if (s.untilDate) u.set('until_date', s.untilDate);
  } else if (s.range) {
    u.set('range', s.range);
  }
  if (s.batchId) u.set('batch_id', s.batchId);
  if (s.batch) u.set('batch', s.batch);
  if (s.page > 1) u.set('page', String(s.page));
  return u;
}
