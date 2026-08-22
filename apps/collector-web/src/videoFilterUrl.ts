// ── VideoList 筛选 ↔ URL query 序列化（纯函数）──
// URL 为唯一真相：组件从 query 派生 state，变更时 replace 写回。
// 约定：空值/默认值省略（默认态 URL 就是干净的 #/videos）；page/日期/数字一律字符串透传，类型转换在组件层。
import type { VideoFilter } from './types';

type SortField = NonNullable<VideoFilter['sort']>;
type DateField = NonNullable<VideoFilter['date_field']>;

export interface VideoListQueryState {
  q: string;          // 标题/创作者关键词（已提交值；输入框防抖后写入）
  sq: string;         // 字幕正文关键词（已提交值）
  source: string;     // 平台
  tname: string;      // 分区
  tags: string[];     // 标签（精确，多选 AND；query 形如 tags=a,b，对齐 server split(',') 口径）
  tagSource: string;  // 标签档位
  lang: string;
  hasSubtitle: boolean;
  dateField: DateField;
  sinceDate: string;  // YYYY-MM-DD
  untilDate: string;
  minDur: string;     // 分钟
  maxDur: string;
  minView: string;    // 万
  maxView: string;
  sort: SortField | undefined;
  desc: boolean;
  page: number;
}

export const VIDEO_LIST_DEFAULTS: VideoListQueryState = {
  q: '', sq: '', source: '', tname: '', tags: [], tagSource: '', lang: '',
  hasSubtitle: false, dateField: 'first_seen',
  sinceDate: '', untilDate: '', minDur: '', maxDur: '', minView: '', maxView: '',
  sort: undefined, desc: true, page: 1,
};

const SORT_FIELDS: readonly SortField[] = ['first_seen', 'published_at', 'title', 'duration', 'view'];
const DATE_FIELDS: readonly DateField[] = ['first_seen', 'published_at'];

export function videoListFromQuery(q: URLSearchParams): VideoListQueryState {
  const sortRaw = q.get('sort');
  const dateRaw = q.get('date_field');
  const pageRaw = Number(q.get('page'));
  // tags 多选：tags=a,b（split+trim+去空，与 server filter.ts 同口径）；
  // 旧单数 tag= 兼容读入（视作单元素数组，分享旧链接不断），不再写出
  const tagsRaw = q.get('tags');
  const legacyTag = q.get('tag');
  const tags = tagsRaw
    ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : legacyTag
      ? [legacyTag.trim()].filter(Boolean)
      : [];
  return {
    q: q.get('q') ?? '',
    sq: q.get('sq') ?? '',
    source: q.get('source') ?? '',
    tname: q.get('tname') ?? '',
    tags,
    tagSource: q.get('tag_source') ?? '',
    lang: q.get('lang') ?? '',
    hasSubtitle: q.get('has_subtitle') === '1',
    dateField: (DATE_FIELDS as readonly string[]).includes(dateRaw ?? '') ? (dateRaw as DateField) : 'first_seen',
    sinceDate: q.get('since_date') ?? '',
    untilDate: q.get('until_date') ?? '',
    minDur: q.get('min_dur') ?? '',
    maxDur: q.get('max_dur') ?? '',
    minView: q.get('min_view') ?? '',
    maxView: q.get('max_view') ?? '',
    sort: (SORT_FIELDS as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as SortField) : undefined,
    desc: q.get('desc') !== '0',
    page: Number.isInteger(pageRaw) && pageRaw > 1 ? pageRaw : 1,
  };
}

export function videoListToQuery(s: VideoListQueryState): URLSearchParams {
  const u = new URLSearchParams();
  if (s.q) u.set('q', s.q);
  if (s.sq) u.set('sq', s.sq);
  if (s.source) u.set('source', s.source);
  if (s.tname) u.set('tname', s.tname);
  // 标签名按本系统构造不含半角逗号（bili 档来自 B 站逐个录入的 tag 列表、manual 档录入时
  // VideoDetail.onAddTags 即按逗号切分），join(',') 无歧义；万一出现含逗号名则序列化时丢弃
  // （server split(',') 无法表达单名含逗号，防御性最小处理）
  const tags = s.tags.filter((t) => t && !t.includes(','));
  if (tags.length > 0) u.set('tags', tags.join(','));
  if (s.tagSource) u.set('tag_source', s.tagSource);
  if (s.lang) u.set('lang', s.lang);
  if (s.hasSubtitle) u.set('has_subtitle', '1');
  if (s.dateField !== 'first_seen') u.set('date_field', s.dateField);
  if (s.sinceDate) u.set('since_date', s.sinceDate);
  if (s.untilDate) u.set('until_date', s.untilDate);
  if (s.minDur) u.set('min_dur', s.minDur);
  if (s.maxDur) u.set('max_dur', s.maxDur);
  if (s.minView) u.set('min_view', s.minView);
  if (s.maxView) u.set('max_view', s.maxView);
  if (s.sort) u.set('sort', s.sort);
  if (s.sort && !s.desc) u.set('desc', '0');
  if (s.page > 1) u.set('page', String(s.page));
  return u;
}
