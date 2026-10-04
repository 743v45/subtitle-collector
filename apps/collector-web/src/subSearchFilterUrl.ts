// ── 字幕检索页（#/search）表单 ↔ URL query 序列化（纯函数）──
// 镜像 videoFilterUrl 范式：URL 为唯一真相，提交后写入，刷新/分享/后退还原。
// 约定：默认值省略（默认态 URL 就是干净的 #/search）；regex/case 用 '1'，ctx 默认 10 秒省略不写。
export interface SubSearchQueryState {
  kw: string;           // 关键词（必填；提交时 trim）
  regex: boolean;       // 正则模式
  caseSensitive: boolean; // 区分大小写
  ctx: string;          // 上下文秒数（字符串透传，类型转换在组件层；默认 '10'）
  source: string;       // 平台过滤（'' = 全部）
  creator: string;      // 创作者名（可选）
}

export const SUB_SEARCH_DEFAULTS: SubSearchQueryState = {
  kw: '', regex: false, caseSensitive: false, ctx: '10', source: '', creator: '',
};

export function subSearchFromQuery(q: URLSearchParams): SubSearchQueryState {
  return {
    kw: q.get('kw') ?? '',
    regex: q.get('regex') === '1',
    caseSensitive: q.get('case') === '1',
    ctx: q.get('ctx') ?? '10',
    source: q.get('source') ?? '',
    creator: q.get('creator') ?? '',
  };
}

export function subSearchToQuery(s: SubSearchQueryState): URLSearchParams {
  const u = new URLSearchParams();
  if (s.kw) u.set('kw', s.kw);
  if (s.regex) u.set('regex', '1');
  if (s.caseSensitive) u.set('case', '1');
  if (s.ctx && s.ctx !== '10') u.set('ctx', s.ctx);
  if (s.source) u.set('source', s.source);
  if (s.creator) u.set('creator', s.creator);
  return u;
}
