import type {
  VideoListItem, VideoDetail, VideoFilter, ClientInfo,
  StatsOverview, KeyValue, StatsGroupBy, CreatorDetail,
} from './types';
import type { SubtitleLine } from '@/components/SubtitleView';

const BASE = '';

export interface Category {
  id: number;
  name: string;
  scope: 'agent' | 'human';
  sort_order: number;
  created_at: number;
}

export interface CreatorListItem {
  id: number;
  source: string;
  source_uid: string;
  name: string | null;
  avatar: string | null;
  fans: number | null;
  video_count: number;
  category_agent_id: number | null;
  category_agent_name: string | null;
  category_human_id: number | null;
  category_human_name: string | null;
  first_seen_at: number;
}

async function ensureOk<T>(r: Response, parse: (json: any) => T): Promise<T> {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  if (json.ok === false) throw new Error(json.error ?? 'API error');
  return parse(json);
}

// ── 视频 ──
export async function listVideos(filter: VideoFilter = {}): Promise<{ total: number; items: VideoListItem[] }> {
  const u = new URLSearchParams();
  if (filter.q) u.set('q', filter.q);
  if (filter.tid != null) u.set('tid', String(filter.tid));
  if (filter.tname) u.set('tname', filter.tname);
  if (filter.tag) u.set('tag', filter.tag);
  if (filter.lang) u.set('lang', filter.lang);
  if (filter.has_subtitle) u.set('has_subtitle', 'true');
  if (filter.since != null) u.set('since', String(filter.since));
  if (filter.until != null) u.set('until', String(filter.until));
  if (filter.min_duration != null) u.set('min_duration', String(filter.min_duration));
  if (filter.max_duration != null) u.set('max_duration', String(filter.max_duration));
  if (filter.sort) u.set('sort', filter.sort);
  if (filter.desc) u.set('desc', 'true');
  u.set('page', String(filter.page ?? 1));
  u.set('size', String(filter.size ?? 20));
  const r = await fetch(`${BASE}/api/videos?${u}`);
  return ensureOk(r, (j) => ({ total: j.total, items: j.items }));
}

export async function getVideo(source: string, sourceVid: string): Promise<VideoDetail> {
  const r = await fetch(`${BASE}/api/videos/${source}/${encodeURIComponent(sourceVid)}`);
  return ensureOk(r, (j) => {
    const video = j.video;
    // 服务端 videos.extra 是 TEXT(JSON 字符串)；这里解析成对象，让 VideoInfo.extra 可直接访问
    // tid/tname/tags/stat/pic 等字段（修复此前详情页元信息全部取不到的 bug）。
    if (video && typeof video.extra === 'string') {
      try { video.extra = JSON.parse(video.extra); } catch { video.extra = {}; }
    }
    return { video, tracks: j.tracks } as VideoDetail;
  });
}

export async function getVersion(versionId: number): Promise<{ version: { id: number; origin: string; payload: { body: SubtitleLine[] }; captured_at: number } }> {
  const r = await fetch(`${BASE}/api/versions/${versionId}`);
  return ensureOk(r, (j) => j);
}

// ── 统计看板 ──
export async function getStatsOverview(): Promise<StatsOverview> {
  const r = await fetch(`${BASE}/api/stats?type=overview`);
  return ensureOk(r, (j) => j.overview);
}
export async function getStatsAggregate(groupBy: StatsGroupBy, filter: VideoFilter = {}): Promise<KeyValue[]> {
  const u = new URLSearchParams({ type: 'aggregate', groupBy });
  if (filter.q) u.set('q', filter.q);
  if (filter.tag) u.set('tag', filter.tag);
  if (filter.tname) u.set('tname', filter.tname);
  const r = await fetch(`${BASE}/api/stats?${u}`);
  return ensureOk(r, (j) => j.items ?? []);
}

// ── 客户端 ──
export async function listClients(): Promise<ClientInfo[]> {
  const r = await fetch(`${BASE}/api/clients`);
  return ensureOk(r, (j) => j.clients ?? []);
}

export async function setReporting(clientId: string, enabled: boolean): Promise<boolean> {
  const r = await fetch(`${BASE}/api/clients/${encodeURIComponent(clientId)}/reporting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return ensureOk(r, (j) => j.reporting_enabled);
}

// ── 分类 ──
export async function listCategories(scope?: 'agent' | 'human'): Promise<Category[]> {
  const q = scope ? `?scope=${scope}` : '';
  const r = await fetch(`${BASE}/api/categories${q}`);
  return ensureOk(r, (j) => j.items ?? []);
}

export async function createCategory(name: string, scope: 'agent' | 'human'): Promise<Category> {
  const r = await fetch(`${BASE}/api/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, scope }),
  });
  return ensureOk(r, (j) => j.category);
}

export async function updateCategory(id: number, patch: { name?: string; sort_order?: number }): Promise<Category> {
  const r = await fetch(`${BASE}/api/categories/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return ensureOk(r, (j) => j.category);
}

export async function deleteCategory(id: number): Promise<void> {
  const r = await fetch(`${BASE}/api/categories/${id}`, { method: 'DELETE' });
  ensureOk(r, () => undefined);
}

// ── UP 主 ──
export async function listCreators(params: {
  q?: string;
  category?: string;
  scope?: 'agent' | 'human';
  page?: number;
  size?: number;
}): Promise<{ total: number; items: CreatorListItem[] }> {
  const u = new URLSearchParams();
  if (params.q) u.set('q', params.q);
  if (params.category) u.set('category', params.category);
  if (params.scope) u.set('scope', params.scope);
  u.set('page', String(params.page ?? 1));
  u.set('size', String(params.size ?? 20));
  const r = await fetch(`${BASE}/api/creators?${u}`);
  return ensureOk(r, (j) => ({ total: j.total ?? 0, items: j.items ?? [] }));
}

export async function getCreatorDetail(id: number): Promise<CreatorDetail> {
  const r = await fetch(`${BASE}/api/creators/${id}`);
  return ensureOk(r, (j) => j.creator);
}

export async function setCreatorCategory(
  source_uid: string,
  scope: 'agent' | 'human',
  name: string,
): Promise<void> {
  const r = await fetch(`${BASE}/api/creators/by-uid/${encodeURIComponent(source_uid)}/category`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, name }),
  });
  ensureOk(r, () => undefined);
}
