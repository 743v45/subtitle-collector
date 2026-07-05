import type Database from 'better-sqlite3';
import type { VideoDetail, VideoListItem, VersionRow } from './queries.js';

// CLI 专用扩展查询（不碰 queries.ts 以保 HTTP 兼容）。设计文档 §3.1/§3.2/§5。
// extra 是 TEXT/JSON，分区/标签/stat 过滤一律走 SQLite json_extract；first_seen/changed 比对为毫秒时间戳。

// ---- 视频过滤条件（list 与 aggregateStats 共用）----
export interface VideoFilter {
  q?: string;                // title / creator 名 模糊
  creator?: string;          // creator 名 模糊
  creator_id?: number;       // creator id 精确（UP 详情页拉该 UP 视频）
  source?: string;           // videos.source 精确
  tid?: number;              // extra.tid 精确
  tname?: string;            // extra.tname 模糊
  tag?: string;              // extra.tags[].tag_name 模糊
  subtitle_q?: string;       // 字幕正文关键词模糊（命中 subtitle_versions.payload）
  lang?: string;             // subtitle_tracks.lan 模糊（zh 命中 zh-Hans）
  track_type?: number;       // subtitle_tracks.track_type 精确（1=AI 2=CC）
  has_subtitle?: boolean;    // 至少有一条 subtitle_versions
  paid?: boolean;            // 仅付费视频（v.paid = 1）
  since?: number;            // 毫秒，比对 date_field（默认 first_seen_at）
  until?: number;
  min_duration?: number;     // 秒
  max_duration?: number;
  min_view?: number;         // extra.stat.view 范围（绝对值）
  max_view?: number;
  date_field?: 'first_seen' | 'published_at';  // since/until 比对的列，默认 first_seen
}

export type VideoSortKey = 'first_seen' | 'published_at' | 'title' | 'duration' | 'view';

export interface ListFilter extends VideoFilter {
  sort?: VideoSortKey;
  desc?: boolean;
  page?: number;
  size?: number;
}

// list items：在 queries.ts VideoListItem 基础上补 published_at / creator_source_uid
export interface VideoListItemAdvanced extends VideoListItem {
  published_at: number | null;
  creator_source_uid: string | null;
}

export interface PageResult<T> {
  total: number;
  page: number;
  size: number;
  items: T[];
}

export interface ChangeRow {
  id: number;
  entity: string;
  entity_id: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: number;
}

export interface ChangeFilter {
  entity?: string;
  entity_id?: number;
  field?: string;
  since?: number;   // 毫秒，比对 changed_at
  until?: number;
}

export type StatsGroupBy = 'creator' | 'tname' | 'lang' | 'track-type';

export interface KeyValue {
  key: string;
  count: number;
}

export interface Overview {
  videos: number;
  tracks: number;
  versions: number;
  creators: number;
  languages: number;
  categories: number;
  first_seen_min: number | null;
  first_seen_max: number | null;
}

// 构建 video 级 WHERE（含 extra/tracks 上的 EXISTS 子查询）。调用方需 LEFT JOIN creators c。
function buildVideoWhere(f: VideoFilter): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.q) {
    conds.push('(v.title LIKE ? OR c.name LIKE ?)');
    params.push(`%${f.q}%`, `%${f.q}%`);
  }
  if (f.creator) {
    conds.push('c.name LIKE ?');
    params.push(`%${f.creator}%`);
  }
  if (f.creator_id != null) {
    conds.push('v.creator_id = ?');
    params.push(f.creator_id);
  }
  if (f.source) {
    conds.push('v.source = ?');
    params.push(f.source);
  }
  if (f.tid != null) {
    conds.push("json_extract(v.extra, '$.tid') = ?");
    params.push(f.tid);
  }
  if (f.tname) {
    conds.push("json_extract(v.extra, '$.tname') LIKE ?");
    params.push(`%${f.tname}%`);
  }
  if (f.tag) {
    // extra.tags 是数组：json_each 遍历后对 tag_name 做 LIKE
    conds.push("EXISTS (SELECT 1 FROM json_each(v.extra, '$.tags') WHERE json_extract(json_each.value, '$.tag_name') LIKE ?)");
    params.push(`%${f.tag}%`);
  }
  if (f.subtitle_q) {
    // 字幕正文：subtitle_versions.payload 是 JSON，LIKE 命中 body[].content
    conds.push('EXISTS (SELECT 1 FROM subtitle_versions sv JOIN subtitle_tracks st ON st.id = sv.track_id WHERE st.video_id = v.id AND sv.payload LIKE ?)');
    params.push(`%${f.subtitle_q}%`);
  }
  if (f.lang) {
    conds.push('EXISTS (SELECT 1 FROM subtitle_tracks st WHERE st.video_id = v.id AND st.lan LIKE ?)');
    params.push(`%${f.lang}%`);
  }
  if (f.track_type != null) {
    conds.push('EXISTS (SELECT 1 FROM subtitle_tracks st WHERE st.video_id = v.id AND st.track_type = ?)');
    params.push(f.track_type);
  }
  if (f.has_subtitle) {
    conds.push('EXISTS (SELECT 1 FROM subtitle_tracks st JOIN subtitle_versions sv ON sv.track_id = st.id WHERE st.video_id = v.id)');
  }
  if (f.paid) {
    conds.push('v.paid = 1');
  }
  const dateCol = f.date_field === 'published_at' ? 'v.published_at' : 'v.first_seen_at';
  if (f.since != null) {
    conds.push(`${dateCol} >= ?`);
    params.push(f.since);
  }
  if (f.until != null) {
    conds.push(`${dateCol} <= ?`);
    params.push(f.until);
  }
  if (f.min_view != null) {
    conds.push("CAST(json_extract(v.extra, '$.stat.view') AS INTEGER) >= ?");
    params.push(f.min_view);
  }
  if (f.max_view != null) {
    conds.push("CAST(json_extract(v.extra, '$.stat.view') AS INTEGER) <= ?");
    params.push(f.max_view);
  }
  if (f.min_duration != null) {
    conds.push('v.duration >= ?');
    params.push(f.min_duration);
  }
  if (f.max_duration != null) {
    conds.push('v.duration <= ?');
    params.push(f.max_duration);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return { where, params };
}

const SORT_EXPR: Record<VideoSortKey, string> = {
  first_seen: 'v.first_seen_at',
  published_at: 'v.published_at',
  title: 'v.title',
  duration: 'v.duration',
  view: "CAST(json_extract(v.extra, '$.stat.view') AS INTEGER)",
};

// 视频列表（多过滤 + 多排序键 + 分页）。返回 {total, page, size, items}。
export function listVideosFiltered(db: Database.Database, filter: ListFilter): PageResult<VideoListItemAdvanced> {
  const page = filter.page && filter.page > 0 ? filter.page : 1;
  const size = filter.size && filter.size > 0 ? filter.size : 20;
  const offset = (page - 1) * size;
  const { where, params } = buildVideoWhere(filter);

  const totalRow = db.prepare(
    `SELECT COUNT(*) as c FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}`,
  ).get(...params) as { c: number };

  const sortExpr = SORT_EXPR[filter.sort ?? 'first_seen'];
  const dir = filter.desc ? 'DESC' : 'ASC';
  // id 作 tiebreaker 保证分页稳定（方向跟随主排序键）
  const orderBy = `ORDER BY ${sortExpr} ${dir}, v.id ${dir}`;

  const items = db.prepare(`
    SELECT v.id, v.source, v.source_vid, v.title,
           c.name as creator_name, c.source_uid as creator_source_uid,
           v.duration, v.published_at, v.first_seen_at,
           (SELECT COUNT(*) FROM subtitle_tracks t WHERE t.video_id = v.id) as track_count
    FROM videos v LEFT JOIN creators c ON c.id = v.creator_id
    ${where}
    ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, size, offset) as VideoListItemAdvanced[];

  return { total: totalRow.c, page, size, items };
}

// 优先级 / is_default 逻辑镜像 queries.ts getVideo，保持一致（queries.ts 的私有 helper 不导出，这里原地复刻一份）
const trackPriority = (lan: string | null, track_type: number | null): number => {
  const isZh = !!lan && lan.toLowerCase().includes('zh');
  const isEn = !!lan && lan.toLowerCase().includes('en');
  if (isZh && track_type === 2) return 0; // CC中文
  if (isZh && track_type === 1) return 1; // AI中文
  if (isEn) return 2;
  return 3;
};
const versionPriority = (origin: string): number => {
  if (origin === 'external') return 0;
  if (origin === 'manual') return 1;
  return 2; // asr
};

// 按 videos.id 取详情（轨+版本，默认标记逻辑同 getVideo）
export function getVideoByDbId(db: Database.Database, id: number): VideoDetail | null {
  const video = db.prepare(
    'SELECT v.*, c.name as creator_name FROM videos v LEFT JOIN creators c ON c.id = v.creator_id WHERE v.id = ?',
  ).get(id) as Record<string, unknown> | undefined;
  if (!video) return null;
  const tracks = db.prepare('SELECT * FROM subtitle_tracks WHERE video_id = ? ORDER BY id').all(id) as Array<{
    id: number; lan: string | null; lan_doc: string | null; track_type: number | null;
  }>;
  const allVersions = db.prepare('SELECT * FROM subtitle_versions WHERE track_id = ? ORDER BY id');
  const result: VideoDetail = { video, tracks: [] };
  for (const t of tracks) {
    const vs = allVersions.all(t.id) as VersionRow[];
    const sortedVs = vs.slice().sort((a, b) => versionPriority(a.origin) - versionPriority(b.origin));
    result.tracks.push({ ...t, versions: sortedVs });
  }
  result.tracks.sort((a, b) => trackPriority(a.lan, a.track_type) - trackPriority(b.lan, b.track_type));
  // 标 is_default：默认 track 是排序后首个；每个 track 内各自独立标首个 version 为 default（不跨轨串台）
  result.tracks.forEach((t, idx) => {
    (t as { is_default?: boolean }).is_default = idx === 0;
    let seenVer = false;
    for (const v of t.versions) {
      (v as { is_default?: boolean }).is_default = !seenVer;
      seenVer = true;
    }
  });
  return result;
}

// change_log 列表（过滤 + 分页）。返回 {total, page, size, items}。
export function getChanges(
  db: Database.Database,
  filter: ChangeFilter,
  page: number,
  size: number,
): PageResult<ChangeRow> {
  const p = page > 0 ? page : 1;
  const s = size > 0 ? size : 20;
  const offset = (p - 1) * s;
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.entity) {
    conds.push('entity = ?');
    params.push(filter.entity);
  }
  if (filter.entity_id != null) {
    conds.push('entity_id = ?');
    params.push(filter.entity_id);
  }
  if (filter.field) {
    conds.push('field = ?');
    params.push(filter.field);
  }
  if (filter.since != null) {
    conds.push('changed_at >= ?');
    params.push(filter.since);
  }
  if (filter.until != null) {
    conds.push('changed_at <= ?');
    params.push(filter.until);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM change_log ${where}`).get(...params) as { c: number };
  const items = db.prepare(
    `SELECT * FROM change_log ${where} ORDER BY changed_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, s, offset) as ChangeRow[];
  return { total: totalRow.c, page: p, size: s, items };
}

// 分组聚合计数（count desc 截 topN，默认 20）。filter 同 list。
export function aggregateStats(
  db: Database.Database,
  groupBy: StatsGroupBy,
  filter: VideoFilter = {},
  topN = 20,
): KeyValue[] {
  const { where, params } = buildVideoWhere(filter);
  let sql: string;
  switch (groupBy) {
    case 'creator':
      sql = `SELECT COALESCE(c.name, '(unknown)') as key, COUNT(*) as count
             FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}
             GROUP BY c.name ORDER BY count DESC, key ASC LIMIT ?`;
      break;
    case 'tname':
      sql = `SELECT COALESCE(json_extract(v.extra, '$.tname'), '(unknown)') as key, COUNT(*) as count
             FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}
             GROUP BY json_extract(v.extra, '$.tname') ORDER BY count DESC, key ASC LIMIT ?`;
      break;
    case 'lang':
      sql = `SELECT COALESCE(t.lan, '(unknown)') as key, COUNT(DISTINCT v.id) as count
             FROM videos v JOIN subtitle_tracks t ON t.video_id = v.id
             LEFT JOIN creators c ON c.id = v.creator_id ${where}
             GROUP BY t.lan ORDER BY count DESC, key ASC LIMIT ?`;
      break;
    case 'track-type':
      sql = `SELECT COALESCE(t.track_type, '(unknown)') as key, COUNT(DISTINCT v.id) as count
             FROM videos v JOIN subtitle_tracks t ON t.video_id = v.id
             LEFT JOIN creators c ON c.id = v.creator_id ${where}
             GROUP BY t.track_type ORDER BY count DESC, key ASC LIMIT ?`;
      break;
  }
  const rows = db.prepare(sql).all(...params, topN) as Array<{ key: string | number | null; count: number }>;
  return rows.map((r) => ({ key: r.key == null ? '(unknown)' : String(r.key), count: r.count }));
}

// 总览计数：视频/轨/版本/UP/语言/分区数 + first_seen 时间范围。
// languages 取 subtitle_tracks.lan 去重计数；categories 取 extra.tname 去重计数。
export function countOverview(db: Database.Database): Overview {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM videos) as videos,
      (SELECT COUNT(*) FROM subtitle_tracks) as tracks,
      (SELECT COUNT(*) FROM subtitle_versions) as versions,
      (SELECT COUNT(*) FROM creators) as creators,
      (SELECT COUNT(DISTINCT lan) FROM subtitle_tracks WHERE lan IS NOT NULL) as languages,
      (SELECT COUNT(DISTINCT json_extract(extra, '$.tname')) FROM videos WHERE json_extract(extra, '$.tname') IS NOT NULL) as categories,
      (SELECT MIN(first_seen_at) FROM videos) as first_seen_min,
      (SELECT MAX(first_seen_at) FROM videos) as first_seen_max
  `).get() as Overview;
}
