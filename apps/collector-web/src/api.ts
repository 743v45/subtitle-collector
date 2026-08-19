import type {
  VideoListItem, VideoDetail, VideoFilter, ClientInfo,
  StatsOverview, KeyValue, StatsGroupBy, CreatorDetail, ChangeRow,
  TagSource, CollectTask, UpperVideoItem,
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
  if (filter.source) u.set('source', filter.source);
  if (filter.tid != null) u.set('tid', String(filter.tid));
  if (filter.tname) u.set('tname', filter.tname);
  if (filter.tag) u.set('tag', filter.tag);
  if (filter.tags?.length) u.set('tags', filter.tags.join(','));
  if (filter.tag_source?.length) u.set('tag_source', filter.tag_source.join(','));
  if (filter.subtitle_q) u.set('subtitle_q', filter.subtitle_q);
  if (filter.lang) u.set('lang', filter.lang);
  if (filter.has_subtitle) u.set('has_subtitle', 'true');
  if (filter.since != null) u.set('since', String(filter.since));
  if (filter.until != null) u.set('until', String(filter.until));
  if (filter.min_duration != null) u.set('min_duration', String(filter.min_duration));
  if (filter.max_duration != null) u.set('max_duration', String(filter.max_duration));
  if (filter.creator_id != null) u.set('creator_id', String(filter.creator_id));
  if (filter.min_view != null) u.set('min_view', String(filter.min_view));
  if (filter.max_view != null) u.set('max_view', String(filter.max_view));
  if (filter.date_field) u.set('date_field', filter.date_field);
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
    return { video, tracks: j.tracks, tag_details: j.tag_details } as VideoDetail;
  });
}

export async function getVersion(versionId: number): Promise<{ version: { id: number; origin: string; payload: { body: SubtitleLine[] }; captured_at: number } }> {
  const r = await fetch(`${BASE}/api/versions/${versionId}`);
  return ensureOk(r, (j) => j);
}

// ── change_log（最近采集/变更流水）──
export async function getChanges(params: {
  entity?: string;       // 'video' | 'creator'
  page?: number;
  size?: number;
}): Promise<{ total: number; items: ChangeRow[] }> {
  const u = new URLSearchParams();
  if (params.entity) u.set('entity', params.entity);
  u.set('page', String(params.page ?? 1));
  u.set('size', String(params.size ?? 20));
  const r = await fetch(`${BASE}/api/changes?${u}`);
  return ensureOk(r, (j) => ({ total: j.total, items: j.items ?? [] }));
}

// ── 统计看板 ──
export async function getStatsOverview(): Promise<StatsOverview> {
  const r = await fetch(`${BASE}/api/stats?type=overview`);
  return ensureOk(r, (j) => j.overview);
}
export async function getStatsAggregate(groupBy: StatsGroupBy, filter: VideoFilter = {}, topN?: number): Promise<KeyValue[]> {
  const u = new URLSearchParams({ type: 'aggregate', groupBy });
  if (filter.q) u.set('q', filter.q);
  if (filter.tag) u.set('tag', filter.tag);
  if (filter.tname) u.set('tname', filter.tname);
  if (topN) u.set('topN', String(topN));
  const r = await fetch(`${BASE}/api/stats?${u}`);
  return ensureOk(r, (j) => j.items ?? []);
}

// ── 客户端 ──
export async function listClients(): Promise<ClientInfo[]> {
  const r = await fetch(`${BASE}/api/clients`);
  return ensureOk(r, (j) => j.clients ?? []);
}

// ── 采集任务 ──
// 提交采集（text 为手机粘贴的分享文本/链接,server 侧提取并解析 URL）
export async function createCollectTask(text: string): Promise<CollectTask> {
  const r = await fetch(`${BASE}/api/collect-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return ensureOk(r, (j) => j.task);
}

export async function listCollectTasks(limit = 20): Promise<{ total: number; items: CollectTask[] }> {
  const r = await fetch(`${BASE}/api/collect-tasks?limit=${limit}`);
  return ensureOk(r, (j) => ({ total: j.total ?? 0, items: j.items ?? [] }));
}

export async function getCollectTask(id: number): Promise<CollectTask> {
  const r = await fetch(`${BASE}/api/collect-tasks/${id}`);
  return ensureOk(r, (j) => j.task);
}

// 删除采集任务（任意状态可删;dispatched 删除后扩展回执为 no-op）
export async function deleteCollectTask(id: number): Promise<void> {
  const r = await fetch(`${BASE}/api/collect-tasks/${id}`, { method: 'DELETE' });
  await ensureOk(r, () => undefined);
}

// ── 按 UP 批量采集（2026-08-19）──
// UP 全部视频列表：server 经扩展 WS 代理分页拉取（arc/search）+ 查库标注已采。
// 扩展离线 / 拉取失败 → 抛错（ensureOk 带 server error 文案）。
export async function expandUpperVideos(mid: string): Promise<{ total: number; items: UpperVideoItem[] }> {
  const r = await fetch(`${BASE}/api/upper-videos/expand`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mid }),
  });
  return ensureOk(r, (j) => ({ total: j.total ?? 0, items: j.items ?? [] }));
}

// 批量建采集任务（popup/web 勾选批量共用端点；pending/dispatched 任务去重跳过）
export async function createCollectTasksBatch(bvids: string[]): Promise<{ created: number; skipped: number }> {
  const r = await fetch(`${BASE}/api/collect-tasks/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bvids }),
  });
  return ensureOk(r, (j) => ({ created: j.created ?? 0, skipped: j.skipped ?? 0 }));
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

// ── 标签 ──
// 标签库条目（bili 档来自视频自带、无独立实体，counts 只含三档）
export interface TagItem {
  id: number;
  name: string;
  created_at: number;
  counts: { manual: number; batch: number; ai: number; total: number };
}
// 打标目标视频（source=平台，source_vid=平台内视频 ID）
export interface TagTarget { source: string; source_vid: string; }
// 可写入档位（bili 不可手动打标，服务端 400）
export type TagWriteSource = 'manual' | 'batch' | 'ai';

export async function listTags(params: { source?: TagWriteSource; q?: string; topN?: number } = {}): Promise<TagItem[]> {
  const u = new URLSearchParams();
  if (params.source) u.set('source', params.source);
  if (params.q) u.set('q', params.q);
  u.set('topN', String(params.topN ?? 500));
  const r = await fetch(`${BASE}/api/tags?${u}`);
  return ensureOk(r, (j) => j.items ?? []);
}

// 批量给一组视频打标；names 中不存在的标签会先落库（返回 inserted/missing 供提示）
export async function applyTags(body: { items: TagTarget[]; names: string[]; source: TagWriteSource }): Promise<{ inserted: number; missing: number }> {
  const r = await fetch(`${BASE}/api/tags/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return ensureOk(r, (j) => ({ inserted: j.inserted, missing: j.missing }));
}

// 批量解除标签关联；source 省略时删全档
export async function removeTags(body: { items: TagTarget[]; names: string[]; source?: TagSource }): Promise<{ removed: number; missing: number }> {
  const r = await fetch(`${BASE}/api/tags/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return ensureOk(r, (j) => ({ removed: j.removed, missing: j.missing }));
}

// 改名（撞已有名服务端 409）
export async function renameTag(id: number, name: string): Promise<TagItem> {
  const r = await fetch(`${BASE}/api/tags/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return ensureOk(r, (j) => j.tag);
}

// 删除标签及其全部视频关联
export async function deleteTag(id: number): Promise<void> {
  const r = await fetch(`${BASE}/api/tags/${id}`, { method: 'DELETE' });
  ensureOk(r, () => undefined);
}

// 标签展示优先级（四档精确排列，服务端校验非法 400）
export async function getTagPriority(): Promise<TagSource[]> {
  const r = await fetch(`${BASE}/api/settings/tag-priority`);
  return ensureOk(r, (j) => j.priority);
}

export async function putTagPriority(priority: TagSource[]): Promise<void> {
  const r = await fetch(`${BASE}/api/settings/tag-priority`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority }),
  });
  ensureOk(r, () => undefined);
}

// 单视频打标（bili 档 400）
export async function videoApplyTags(source: string, sourceVid: string, names: string[], tagSource: TagWriteSource): Promise<{ inserted: number }> {
  const r = await fetch(`${BASE}/api/videos/${source}/${encodeURIComponent(sourceVid)}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names, source: tagSource }),
  });
  return ensureOk(r, (j) => ({ inserted: j.inserted }));
}

// 单视频解标；source 省略删全档
export async function videoRemoveTags(source: string, sourceVid: string, name: string, tagSource?: TagSource): Promise<{ removed: number }> {
  const u = new URLSearchParams({ name });
  if (tagSource) u.set('source', tagSource);
  const r = await fetch(`${BASE}/api/videos/${source}/${encodeURIComponent(sourceVid)}/tags?${u}`, { method: 'DELETE' });
  return ensureOk(r, (j) => ({ removed: j.removed }));
}

// ── UP 主 ──
export async function listCreators(params: {
  q?: string;
  category?: string;
  scope?: 'agent' | 'human';
  sort?: 'first_seen' | 'fans' | 'video_count';
  page?: number;
  size?: number;
}): Promise<{ total: number; items: CreatorListItem[] }> {
  const u = new URLSearchParams();
  if (params.q) u.set('q', params.q);
  if (params.category) u.set('category', params.category);
  if (params.scope) u.set('scope', params.scope);
  if (params.sort) u.set('sort', params.sort);
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
