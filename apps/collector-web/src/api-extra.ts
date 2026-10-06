// Phase 1「CLI 全功能 web 化」新增端点封装（api.ts 撞 maxLines 台账线后拆出的兄弟模块）：
// 字幕检索（CLI sub search）/ 补翻（CLI translate pending+source）/ server 状态。
// 复用 api-core 的 BASE/ensureOk；类型内联本模块（自带契约，不进 types.ts）。
import { BASE, apiFetch, ensureOk } from './apiCore';

// ── 字幕检索（CLI sub search 的 web 形态；snippet 形状以 cli/commands/sub.ts 的 Snippet 为准：
//    context 是 ±ctxSec 邻段拼接字符串，非 before/after 数组）──
export interface SubSearchSnippet { from: number; to: number; content: string; context: string; }
export interface SubSearchItem {
  video: { id: number; source: string; source_vid: string; title: string; creator_name: string | null; duration: number | null; published_at: number | null };
  track: { id: number; lan: string | null; lan_doc: string | null };
  version: { id: number; origin?: string };
  snippets: SubSearchSnippet[];
}
export interface SubSearchResult {
  keyword: string; regex: boolean;
  matched_videos: number; total_snippets: number; truncated: boolean;
  items: SubSearchItem[];
}

export async function subSearch(params: {
  keyword: string;
  regex?: boolean;
  caseSensitive?: boolean;
  ctx?: number;                 // 命中段前后上下文秒数（server 默认 10）
  source?: string;              // 平台过滤
  creator?: string;             // 创作者名
  since?: number; until?: number; // 发布时间窗（ms）
  maxSnippetsPerVideo?: number; maxSnippets?: number; maxVideos?: number; // 截断配额（server 默认 3/30/100）
}): Promise<SubSearchResult> {
  const u = new URLSearchParams({ keyword: params.keyword });
  if (params.regex) u.set('regex', '1');
  if (params.caseSensitive) u.set('case_sensitive', '1');
  if (params.ctx != null) u.set('ctx', String(params.ctx));
  if (params.source) u.set('source', params.source);
  if (params.creator) u.set('creator', params.creator);
  if (params.since != null) u.set('since', String(params.since));
  if (params.until != null) u.set('until', String(params.until));
  if (params.maxSnippetsPerVideo != null) u.set('max_snippets_per_video', String(params.maxSnippetsPerVideo));
  if (params.maxSnippets != null) u.set('max_snippets', String(params.maxSnippets));
  if (params.maxVideos != null) u.set('max_videos', String(params.maxVideos));
  const r = await apiFetch(`${BASE}/api/sub-search?${u}`);
  return ensureOk(r, (j) => ({
    keyword: j.keyword,
    regex: j.regex,
    matched_videos: j.matched_videos,
    total_snippets: j.total_snippets,
    truncated: j.truncated,
    items: j.items ?? [],
  }));
}

// ── 补翻（CLI translate pending/source 的 web 形态）──
export interface TranslatePendingItem {
  source: string; source_vid: string; title: string;
  creator_name: string | null; duration: number | null;
  published_at: number | null; first_seen: number;
  langs: { lan: string | null; lan_doc: string | null; lines: number | null }[];
}

export async function translatePending(params: {
  source?: string;  // 平台过滤
  from?: string;    // 源语言（须有该语言轨）
  creator?: string; // 创作者名模糊
  page?: number; size?: number;
  sort?: 'first_seen' | 'published_at';
  asc?: boolean;
} = {}): Promise<{ total: number; page: number; size: number; items: TranslatePendingItem[] }> {
  const u = new URLSearchParams();
  if (params.source) u.set('source', params.source);
  if (params.from) u.set('from', params.from);
  if (params.creator) u.set('creator', params.creator);
  u.set('page', String(params.page ?? 1));
  u.set('size', String(params.size ?? 20));
  if (params.sort) u.set('sort', params.sort);
  if (params.asc) u.set('asc', '1');
  const r = await apiFetch(`${BASE}/api/translate/pending?${u}`);
  return ensureOk(r, (j) => ({ total: j.total ?? 0, page: j.page ?? 1, size: j.size ?? 20, items: j.items ?? [] }));
}

export interface TranslateSourceResult {
  source: string; source_vid: string; lan: string; version_id: number;
  lines: { line: number; text: string }[]; // 结构化行（web 双栏直用）
  text: string;                            // 拼回的「行号\t原文」文本（复制给模型用）
}

export async function translateSource(source: string, vid: string, from?: string): Promise<TranslateSourceResult> {
  const u = new URLSearchParams();
  if (from) u.set('from', from);
  const qs = u.toString();
  const r = await apiFetch(`${BASE}/api/translate/source/${source}/${encodeURIComponent(vid)}${qs ? `?${qs}` : ''}`);
  return ensureOk(r, (j) => ({ source: j.source, source_vid: j.source_vid, lan: j.lan, version_id: j.version_id, lines: j.lines ?? [], text: j.text ?? '' }));
}

// ── server 状态（设置页状态卡）──
export interface ServerStatus {
  version: string;
  uptime_s: number;
  config: { host: string; port: number; auth_required: boolean; token_configured: boolean; allowed_hosts: string };
  db_path: string;
  online_clients: number;
  counts: { videos: number; creators: number; tracks: number; versions: number; collect_tasks: number };
}

export async function getServerStatus(): Promise<ServerStatus> {
  const r = await apiFetch(`${BASE}/api/status`);
  return ensureOk(r, (j) => ({
    version: j.version,
    uptime_s: j.uptime_s,
    config: j.config,
    db_path: j.db_path,
    online_clients: j.online_clients,
    counts: j.counts,
  }));
}

// ── 补翻写回（CLI translate fill 的 web 形态；Phase 3）──
// 一行译文 ↔ 一行源字幕（时间轴 server 从源轨拷贝）；行数不符 400
// {error:'译文行数不符: 源字幕 X 行, 收到 Y 行', expected, got} → ensureOk 抛 HTTP 文案直出。
// 写入 zh-manual 轨（origin=manual 快照式追加不去重），zh_manual_versions_before 让调用方感知堆积。
export interface TranslateFillResult {
  source: string; source_vid: string; from_lan: string;
  lan: string;   // 固定 'zh-manual'
  lines: number; // 实际写入行数（=源字幕行数）
  zh_manual_versions_before: number;
}

export async function translateFill(body: { source: string; source_vid: string; from_lan: string; lines: string[] }): Promise<TranslateFillResult> {
  const r = await apiFetch(`${BASE}/api/translate/fill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return ensureOk(r, (j) => ({
    source: j.source,
    source_vid: j.source_vid,
    from_lan: j.from_lan,
    lan: j.lan,
    lines: j.lines ?? 0,
    zh_manual_versions_before: j.zh_manual_versions_before ?? 0,
  }));
}

// ── 采集编排（CLI collect 三个「选扩展下发 action」的 web 形态；server 进程内编排，Phase 3）──
// 候选条目：bilibili 回执 bvid/up/mid/play/duration/pubdate；youtube 回执 vid/created/length/pic；
// exists/has_subtitle 由 server 查库标注——已采=has_subtitle，已入库无字幕=exists 且 !has_subtitle。
export interface CollectSearchCandidate {
  bvid?: string; vid?: string;
  title?: string; up?: string; mid?: number;
  play?: number | null; duration?: number | null; pubdate?: number | null;
  created?: number | null; length?: string | null; pic?: string | null;
  exists?: boolean; has_subtitle?: boolean;
}

export interface CollectSearchResult {
  source: 'bilibili' | 'youtube'; keyword: string; client_id: string;
  total: number; items: CollectSearchCandidate[];
  // youtube 附加：CLI 同款解析命中/本地过滤计数（0 命中排障先看这）
  raw_total?: number | null; pages_fetched?: number | null; since_days?: number | null; since_filtered?: number;
}

export async function collectSearch(body: {
  source: 'bilibili' | 'youtube';
  keyword: string;
  order?: string;     // youtube: relevance|newest|views；bilibili web 不暴露（server 缺省 pubdate）
  pages?: number;     // youtube 1..5
  sinceDays?: number; // youtube 1..365 → 请求体 since_days
  tid?: number;       // bilibili 分区 tid
}): Promise<CollectSearchResult> {
  const r = await apiFetch(`${BASE}/api/collect-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: body.source,
      keyword: body.keyword,
      order: body.order,
      pages: body.pages,
      since_days: body.sinceDays,
      tid: body.tid,
    }),
  });
  return ensureOk(r, (j) => ({
    source: j.source,
    keyword: j.keyword,
    client_id: j.client_id,
    total: j.total ?? 0,
    items: j.items ?? [],
    raw_total: j.raw_total ?? null,
    pages_fetched: j.pages_fetched ?? null,
    since_days: j.since_days ?? null,
    since_filtered: j.since_filtered ?? 0,
  }));
}

// 合集展开预览（CLI collectSeason 的只读形态；实际采集走既有 createCollectTasksBatch）。
// arg 三形态：BV 号（须已采过）/ 纯数字合集 id / 合集页链接；web 从详情 extra.ugc_season.id 直取。
export interface SeasonPreviewItem {
  bvid: string;
  title?: string;
  created?: number | null; play?: number | null; length?: string | null; pic?: string | null;
  exists?: boolean; has_subtitle?: boolean;
}

export async function seasonPreview(params: { arg: string }): Promise<{
  season: { id: number; mid: number | null };
  client_id: string; total: number; items: SeasonPreviewItem[];
}> {
  const r = await apiFetch(`${BASE}/api/season/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arg: params.arg }),
  });
  return ensureOk(r, (j) => ({
    season: { id: j.season?.id ?? 0, mid: j.season?.mid ?? null },
    client_id: j.client_id,
    total: j.total ?? 0,
    items: j.items ?? [],
  }));
}

// UP 资料刷新（CLI collectUpperInfo 的 web 形态）：只发一个 action get-upper-info，
// 扩展自己拉取并推 ingest-upper 入库，server 回执即扩展回传的资料对象（宽松透传）。
export async function refreshUpperInfo(params: { mid: string }): Promise<{
  client_id: string;
  creator: { name?: string; mid?: number; fans?: number; sign?: string; [k: string]: unknown };
}> {
  const r = await apiFetch(`${BASE}/api/upper-info/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mid: params.mid }),
  });
  return ensureOk(r, (j) => ({ client_id: j.client_id, creator: j.creator ?? {} }));
}
