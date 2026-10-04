// ── 导出端点 URL 构造（CLI 全功能 web 化 Phase 2，纯函数无 fetch）──
// 对应 server 三个 GET 下载端点（apps/collector-server/src/http/export.ts）：
//   /api/export/videos?format=csv|ndjson|json&<VideoFilter>
//   /api/export/subtitle/:source/:vid?track=&version=&format=srt|vtt|txt|json
//   /api/export/bundle?<VideoFilter>&limit=&name_order=&track=
// 序列化口径与 api.ts listVideos 同源（VideoFilter snake_case 直传 server，非 web query 键）；
// 下载统一走 lib/download.ts downloadUrl。注意 videos/bundle 导出是全量拉取，不序列化 page/size。
import type { VideoFilter } from './types';

// VideoFilter → query（文本/集合字段；数值范围字段见 appendRangeFilter）。
// 拆两个函数：字段多，单函数圈复杂度会破 ≤15 台账线。
function appendTextFilter(u: URLSearchParams, f: VideoFilter): void {
  if (f.q) u.set('q', f.q);
  if (f.source) u.set('source', f.source);
  if (f.tid != null) u.set('tid', String(f.tid));
  if (f.tname) u.set('tname', f.tname);
  if (f.tag) u.set('tag', f.tag);
  if (f.tags?.length) u.set('tags', f.tags.join(','));
  if (f.tag_source?.length) u.set('tag_source', f.tag_source.join(','));
  if (f.subtitle_q) u.set('subtitle_q', f.subtitle_q);
  if (f.lang) u.set('lang', f.lang);
  if (f.has_subtitle) u.set('has_subtitle', 'true');
}

// 数值范围/排序字段。desc=false 必须显式发（省略会被 server 缺省降序吃掉，listVideos 同坑）。
// bundle 端点 server 侧丢弃 creator_id/tag_source/date_field（CLI bundle 不支持），多传无害。
function appendRangeFilter(u: URLSearchParams, f: VideoFilter): void {
  if (f.since != null) u.set('since', String(f.since));
  if (f.until != null) u.set('until', String(f.until));
  if (f.min_duration != null) u.set('min_duration', String(f.min_duration));
  if (f.max_duration != null) u.set('max_duration', String(f.max_duration));
  if (f.creator_id != null) u.set('creator_id', String(f.creator_id));
  if (f.min_view != null) u.set('min_view', String(f.min_view));
  if (f.max_view != null) u.set('max_view', String(f.max_view));
  if (f.date_field) u.set('date_field', f.date_field);
  if (f.sort) u.set('sort', f.sort);
  if (f.desc != null) u.set('desc', String(f.desc));
}

function filterToQuery(f: VideoFilter): URLSearchParams {
  const u = new URLSearchParams();
  appendTextFilter(u, f);
  appendRangeFilter(u, f);
  return u;
}

const withQuery = (path: string, u: URLSearchParams): string => {
  const qs = u.toString();
  return qs ? `${path}?${qs}` : path;
};

export type ExportVideosFormat = 'csv' | 'ndjson' | 'json';

// CLI export videos 的 web 形态：按筛选全量导出视频行（server 循环翻页聚合）
export function buildExportVideosUrl(filter: VideoFilter, format: ExportVideosFormat = 'json'): string {
  const u = filterToQuery(filter);
  u.set('format', format);
  return withQuery('/api/export/videos', u);
}

export type ExportSubtitleFormat = 'srt' | 'vtt' | 'txt' | 'json';

// CLI export subtitle 的 web 形态：单视频单轨导出。
// track 省略 = 各视频默认轨；version 省略 = 该轨默认版本；format 省略 = srt（server 缺省）。
export function buildExportSubtitleUrl(
  source: string,
  vid: string,
  opts: { track?: number; version?: number; format?: ExportSubtitleFormat } = {},
): string {
  const u = new URLSearchParams();
  if (opts.track != null) u.set('track', String(opts.track));
  if (opts.version != null) u.set('version', String(opts.version));
  if (opts.format) u.set('format', opts.format);
  return withQuery(`/api/export/subtitle/${encodeURIComponent(source)}/${encodeURIComponent(vid)}`, u);
}

export interface ExportBundleOpts {
  limit?: number;      // 打包视频数上限（server 默认 500、上限 1000）
  nameOrder?: string;  // 文件名组件逗号串，组件域 id|name|time|author（如 id,name）
  track?: string;      // 指定轨语言（留空 = 各视频默认轨）
}

// CLI export bundle 的 web 形态：按筛选打包 manifest + 字幕 txt + ANALYZE.md（zip 下载）
export function buildExportBundleUrl(filter: VideoFilter, opts: ExportBundleOpts = {}): string {
  const u = filterToQuery(filter);
  if (opts.limit != null) u.set('limit', String(opts.limit));
  if (opts.nameOrder) u.set('name_order', opts.nameOrder);
  if (opts.track) u.set('track', opts.track);
  return withQuery('/api/export/bundle', u);
}
