import type Database from 'better-sqlite3';
import type { VideoDetail, VideoListItem, VersionRow } from './queries.js';
import { buildOrderBy, aggOrderBy, AGG_SORT_KEYS, CHANGE_SORT_KEYS, type AggregateSortKey, type ChangeSortKey } from './sort.js';
import { aggregateStatsByTag } from './aggregate-tag.js';

// CLI 专用扩展查询（不碰 queries.ts 以保 HTTP 兼容）。设计文档 §3.1/§3.2/§5。
// extra 是 TEXT/JSON，分区/标签/stat 过滤一律走 SQLite json_extract；first_seen/changed 比对为毫秒时间戳。

// ---- 视频过滤条件（list 与 aggregateStats 共用）----
export interface VideoFilter {
  q?: string;                // title / creator 名 模糊
  creator?: string;          // creator 名 模糊
  creator_id?: number;       // creator id 精确（UP 详情页拉该 UP 视频）
  creator_uid?: string;      // creator source_uid 精确（popup/web 按 B 站 mid 直查已采集合，免 mid→id 两跳）
  source?: string;           // videos.source 精确
  tid?: number;              // extra.tid 精确
  tname?: string;            // extra.tname 模糊
  tag?: string;              // 标签名模糊（五档并查：bili/season extra + manual/batch/ai 关系表）
  tags?: string[];           // 标签名精确（AND 语义，五档并查）
  tag_source?: string[];     // 档位过滤（manual/batch/ai/bili/season 子集；省略=五档全查）
  subtitle_q?: string;       // 字幕正文关键词模糊（命中 subtitle_versions.payload）
  lang?: string;             // subtitle_tracks.lan 模糊（zh 命中 zh-Hans）
  track_type?: number;       // subtitle_tracks.track_type 精确（1=AI 2=CC 3=翻译轨）
  has_subtitle?: boolean;    // 至少有一条 subtitle_versions
  paid?: boolean;            // 仅付费视频（v.paid = 1）
  since?: number;            // 毫秒，比对 date_field（默认 first_seen_at）
  until?: number;
  min_duration?: number;     // 秒
  max_duration?: number;
  min_view?: number;         // extra.stat.view 范围（绝对值）
  max_view?: number;
  date_field?: 'first_seen' | 'published_at';  // since/until 比对的列，默认 first_seen
  exclude_blocked?: boolean; // 排除已屏蔽 UP 的视频（undefined=不过滤；CLI 消费命令默认置 true，web/HTTP 不传即全量）
}

export type VideoSortKey = 'first_seen' | 'published_at' | 'title' | 'duration' | 'view' | 'updated_at';
// 合法排序键清单（HTTP/CLI 校验与 SORT_EXPR 的单一事实源；2026-08-25 全端点排序）
export const VIDEO_SORT_KEYS: readonly VideoSortKey[] = ['first_seen', 'published_at', 'title', 'duration', 'view', 'updated_at'];

export interface ListFilter extends VideoFilter {
  sort?: VideoSortKey;
  desc?: boolean;
  page?: number;
  size?: number;
}

// list items：在 queries.ts VideoListItem 基础上补 published_at / creator_source_uid / creator_blocked
export interface VideoListItemAdvanced extends VideoListItem {
  published_at: number | null;
  creator_source_uid: string | null;
  creator_blocked: boolean;
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
  source?: string | null; // 派生列：entity 行所属平台（video/creator 可判，其余 null），非表列
}

export interface ChangeFilter {
  entity?: string;
  entity_id?: number;
  field?: string;
  source?: string;   // 平台过滤（bilibili|youtube）：经 entity 行 JOIN 判定，change_log 表无 source 列
  since?: number;   // 毫秒，比对 changed_at
  until?: number;
}

export type StatsGroupBy = 'creator' | 'tname' | 'lang' | 'track-type' | 'tag' | 'source';

export interface KeyValue {
  key: string;
  count: number;
  blocked?: boolean; // 仅 groupBy=creator 时置位（该 UP 已屏蔽，web 聚合榜标识用）
}

export interface Overview {
  videos: number;
  tracks: number;
  versions: number;
  creators: number;
  languages: number;
  categories: number;
  today_videos: number; // 当日本地 00:00 起 first_seen_at 新入库视频数（采集页摘要行）
  first_seen_min: number | null;
  first_seen_max: number | null;
  blocked_videos: number;   // 已屏蔽 UP 名下视频数（恒返回：web 展示与 CLI 可观察性）
  blocked_creators: number; // 已屏蔽 UP 数
}

// 标签匹配 EXISTS 片段：一个标签名（精确 = 或模糊 LIKE）× 档位（tag_source 过滤）。
// bili 档查 extra json_each $.tags；season 档查 extra json_extract $.ugc_season.title（同为只读实时读）；
// manual/batch/ai 档查 video_tags 关系表。OR 连接。
// tag_source 省略/含全部五档 → 各路都拼；只含 bili → 只 extra tags 路；只含 season → 只 season 路；只含关系档 → 只关系路。
function tagMatchCond(name: string, mode: 'exact' | 'like', tagSource?: string[]): { cond: string; params: unknown[] } {
  const allSources = ['manual', 'batch', 'ai', 'bili', 'season'];
  const sources = tagSource?.length ? tagSource.filter((s) => allSources.includes(s)) : allSources;
  if (sources.length === 0) sources.push(...allSources);
  const op = mode === 'exact' ? '=' : 'LIKE';
  const val = mode === 'exact' ? name : `%${name}%`;
  const branches: string[] = [];
  const params: unknown[] = [];
  const relSources = sources.filter((s) => s !== 'bili' && s !== 'season');
  if (relSources.length > 0) {
    const placeholders = relSources.map(() => '?').join(',');
    branches.push(
      `EXISTS (SELECT 1 FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = v.id AND t.name ${op} ? AND vt.source IN (${placeholders}))`,
    );
    params.push(val, ...relSources);
  }
  if (sources.includes('bili')) {
    branches.push(
      `EXISTS (SELECT 1 FROM json_each(v.extra, '$.tags') WHERE json_extract(json_each.value, '$.tag_name') ${op} ?)`,
    );
    params.push(val);
  }
  if (sources.includes('season')) {
    branches.push(
      `json_extract(v.extra, '$.ugc_season.title') ${op} ?`,
    );
    params.push(val);
  }
  if (branches.length === 0) return { cond: '0', params: [] }; // 无合法档 → 恒 false
  return { cond: `(${branches.join(' OR ')})`, params };
}

// 构建 video 级 WHERE（含 extra/tracks 上的 EXISTS 子查询）。调用方需 LEFT JOIN creators c。
function buildVideoWhere(f: VideoFilter): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  // 排除已屏蔽 UP：参数化写法保 LEFT JOIN 下无 UP 的视频保留（COALESCE）；falsy → 0 → 恒真不过滤
  conds.push('(? = 0 OR COALESCE(c.blocked, 0) = 0)');
  params.push(Number(Boolean(f.exclude_blocked)));
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
  if (f.creator_uid) {
    // source_uid 精确（子查询防 LIKE 误匹配：296 命中 1296）。多源（bilibili/youtube）uid 不互通，调用方带 source 过滤收窄。
    conds.push('v.creator_id IN (SELECT id FROM creators WHERE source_uid = ?)');
    params.push(f.creator_uid);
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
    // 标签模糊：四档并查（原只查 bili extra，扩展为超集兼容）
    const { cond, params: p } = tagMatchCond(f.tag, 'like', f.tag_source);
    conds.push(cond);
    params.push(...p);
  }
  if (f.tags && f.tags.length > 0) {
    // 标签精确 AND：每个名字一个条件组
    for (const name of f.tags) {
      const { cond, params: p } = tagMatchCond(name, 'exact', f.tag_source);
      conds.push(cond);
      params.push(...p);
    }
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
  updated_at: 'v.updated_at',
};

// 可空排序键（NULLS LAST 不论升降）：published_at/duration 可空、view 经 json_extract 可能 NULL；其余 NOT NULL。
const SORT_NULLABLE: ReadonlySet<VideoSortKey> = new Set(['published_at', 'duration', 'view']);

// 视频列表（多过滤 + 多排序键 + 分页）。返回 {total, page, size, items}。
export function listVideosFiltered(db: Database.Database, filter: ListFilter): PageResult<VideoListItemAdvanced> {
  const page = filter.page && filter.page > 0 ? filter.page : 1;
  const size = filter.size && filter.size > 0 ? filter.size : 20;
  const offset = (page - 1) * size;
  const { where, params } = buildVideoWhere(filter);

  const totalRow = db.prepare(
    `SELECT COUNT(*) as c FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}`,
  ).get(...params) as { c: number };

  const sortKey = filter.sort ?? 'first_seen';
  // id tiebreak 保分页稳定（方向随主键）、可空键 NULLS LAST（见 db/sort.ts）
  const orderBy = buildOrderBy(SORT_EXPR[sortKey], filter.desc ?? true, { nullable: SORT_NULLABLE.has(sortKey), tieExpr: 'v.id' });

  const items = db.prepare(`
    SELECT v.id, v.source, v.source_vid, v.title,
           c.name as creator_name, c.source_uid as creator_source_uid,
           COALESCE(c.blocked, 0) as creator_blocked,
           v.duration, v.published_at, v.first_seen_at,
           (SELECT COUNT(*) FROM subtitle_tracks t WHERE t.video_id = v.id) as track_count
    FROM videos v LEFT JOIN creators c ON c.id = v.creator_id
    ${where}
    ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, size, offset) as Array<Omit<VideoListItemAdvanced, 'creator_blocked'> & { creator_blocked: number }>;

  // blocked 存 0/1，出口统一布尔化
  const mapped = items.map((r) => ({ ...r, creator_blocked: !!r.creator_blocked }));
  return { total: totalRow.c, page, size, items: mapped };
}

// 过滤命中总数（不分页）：导出可观察性用（blocked_filtered = 不排除计数 − 排除计数）。
export function countVideosFiltered(db: Database.Database, filter: VideoFilter): number {
  const { where, params } = buildVideoWhere(filter);
  const row = db.prepare(
    `SELECT COUNT(*) as c FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}`,
  ).get(...params) as { c: number };
  return row.c;
}

// 优先级 / is_default 逻辑镜像 queries.ts getVideo，保持一致（queries.ts 的私有 helper 不导出，这里原地复刻一份）。
// 默认轨优先级：原文人工 CC > 原文 ASR > 翻译轨(type=3) > 其他——翻译轨（YouTube tlang 机翻）排在所有原文轨之后，zh CC / zh AI 细分保持 B 站行为不变。
const trackPriority = (lan: string | null, track_type: number | null): number => {
  if (lan === 'zh-manual') return 1.5; // 补翻中文（translate fill 写入）：AI中文之后、原文轨之前——与 queries.ts 镜像同步
  const isZh = !!lan && lan.toLowerCase().includes('zh');
  const isEn = !!lan && lan.toLowerCase().includes('en');
  if (isZh && track_type === 2) return 0; // CC中文（原文人工 CC）
  if (isZh && track_type === 1) return 1; // AI中文（原文 ASR）
  if (isEn && track_type === 2) return 2; // 英文人工 CC（YouTube 原文 CC）
  if (isEn && track_type === 1) return 3; // 英文 ASR（YouTube 原文自动轨）
  if (track_type === 3) return 4;         // 翻译轨（tlang 机翻）：所有原文轨之后、其他语言轨之前
  if (isEn) return 2;                     // 英文无 type（B 站旧数据）：维持原序
  return 5;                               // 其他
};
const versionPriority = (origin: string): number => {
  if (origin === 'external') return 0;
  if (origin === 'manual') return 1;
  return 2; // asr
};

// 按 videos.id 取详情（轨+版本，默认标记逻辑同 getVideo）
export function getVideoByDbId(db: Database.Database, id: number): VideoDetail | null {
  const video = db.prepare(
    'SELECT v.*, c.name as creator_name, COALESCE(c.blocked, 0) as creator_blocked FROM videos v LEFT JOIN creators c ON c.id = v.creator_id WHERE v.id = ?',
  ).get(id) as Record<string, unknown> | undefined;
  if (!video) return null;
  video.creator_blocked = !!video.creator_blocked;
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

// change_log 列表（过滤 + 分页 + 排序，键仅 changed_at——单键但参数形态与其他端点统一；缺省 DESC）。
export function getChanges(db: Database.Database, filter: ChangeFilter, page: number, size: number, sort: ChangeSortKey = 'changed_at', desc = true): PageResult<ChangeRow> {
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
  if (filter.source) {
    // 平台过滤：change_log 无 source 列，经实体行判定（当前 entity 只写 video/creator 两类；
    // 无法判平台的 entity 类型在平台过滤下不命中）
    conds.push(
      "((cl.entity = 'video' AND cl.entity_id IN (SELECT id FROM videos WHERE source = ?)) OR (cl.entity = 'creator' AND cl.entity_id IN (SELECT id FROM creators WHERE source = ?)))",
    );
    params.push(filter.source, filter.source);
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

  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM change_log cl ${where}`).get(...params) as { c: number };
  // source 为派生列（CASE 子查询带出），供展示层标平台；无平台语义的 entity 为 null
  const items = db.prepare(
    `SELECT cl.*,
       CASE
         WHEN cl.entity = 'video' THEN (SELECT source FROM videos WHERE id = cl.entity_id)
         WHEN cl.entity = 'creator' THEN (SELECT source FROM creators WHERE id = cl.entity_id)
         ELSE NULL
       END AS source
     FROM change_log cl ${where} ${buildOrderBy('cl.changed_at', desc, { tieExpr: 'cl.id' })} LIMIT ? OFFSET ?`,
  ).all(...params, s, offset) as ChangeRow[];
  return { total: totalRow.c, page: p, size: s, items };
}

// 分组聚合计数（topN 截断，默认 20）。filter 同 list；sort 缺省 count DESC, key ASC（与旧硬编码一致）。
export function aggregateStats(
  db: Database.Database, groupBy: StatsGroupBy, filter: VideoFilter = {}, topN = 20,
  sort: AggregateSortKey = 'count', desc = true,
): KeyValue[] {
  const { where, params } = buildVideoWhere(filter);
  let sql: string;
  switch (groupBy) {
    case 'creator':
      sql = `SELECT COALESCE(c.name, '(unknown)') as key, COUNT(*) as count, MAX(COALESCE(c.blocked, 0)) as blocked
             FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}
             GROUP BY c.name ORDER BY ${aggOrderBy(sort, desc)} LIMIT ?`;
      break;
    case 'source':
      sql = `SELECT COALESCE(v.source, '(unknown)') as key, COUNT(*) as count
             FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}
             GROUP BY v.source ORDER BY ${aggOrderBy(sort, desc)} LIMIT ?`;
      break;
    case 'tname':
      sql = `SELECT COALESCE(json_extract(v.extra, '$.tname'), '(unknown)') as key, COUNT(*) as count
             FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}
             GROUP BY json_extract(v.extra, '$.tname') ORDER BY ${aggOrderBy(sort, desc)} LIMIT ?`;
      break;
    case 'lang':
      sql = `SELECT COALESCE(t.lan, '(unknown)') as key, COUNT(DISTINCT v.id) as count
             FROM videos v JOIN subtitle_tracks t ON t.video_id = v.id
             LEFT JOIN creators c ON c.id = v.creator_id ${where}
             GROUP BY t.lan ORDER BY ${aggOrderBy(sort, desc)} LIMIT ?`;
      break;
    case 'track-type':
      sql = `SELECT COALESCE(t.track_type, '(unknown)') as key, COUNT(DISTINCT v.id) as count
             FROM videos v JOIN subtitle_tracks t ON t.video_id = v.id
             LEFT JOIN creators c ON c.id = v.creator_id ${where}
             GROUP BY t.track_type ORDER BY ${aggOrderBy(sort, desc)} LIMIT ?`;
      break;
    case 'tag': // 五档并聚在 aggregate-tag.ts（2026-08-25 抽出偿还 max-lines 台账），WHERE/参数同构传入
      return aggregateStatsByTag(db, where, params, filter.tag_source, topN, sort, desc);
  }
  const rows = db.prepare(sql).all(...params, topN) as Array<{ key: string | number | null; count: number; blocked?: number | null }>;
  return rows.map((r) => ({
    key: r.key == null ? '(unknown)' : String(r.key),
    count: r.count,
    // 仅 creator 分支且已屏蔽时置位（web 聚合榜按 truthy 判断，未屏蔽不带键保持存量断言兼容）
    ...((groupBy === 'creator' && r.blocked) ? { blocked: true } : {}),
  }));
}

// 每视频最近一次采集任务状态（collect_tasks 按 (source, source_vid) 取 id 最大一条；无任务 → null）。
// 受限标记（pot_limited）的唯一派生源：latest='limited' 即半入库（元信息在、0 轨，如 YouTube pot 门槛），
// 与「真无字幕」库内无法区分的三态缺口由此补上。选从任务表派生而非给 videos 加列：
// 重采成功后最新任务不再是 limited，标记自然消失——加列则要维护「何时回清」逻辑，派生零维护。
export function latestTaskStatusByVideoIds(db: Database.Database, ids: number[]): Map<number, string | null> {
  const map = new Map<number, string | null>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT v.id AS vid,
           (SELECT ct.status FROM collect_tasks ct
             WHERE ct.source = v.source AND ct.source_vid = v.source_vid
             ORDER BY ct.id DESC LIMIT 1) AS latest_status
    FROM videos v WHERE v.id IN (${placeholders})
  `).all(...ids) as Array<{ vid: number; latest_status: string | null }>;
  for (const row of rows) map.set(row.vid, row.latest_status);
  return map;
}

// 总览计数：视频/轨/版本/UP/语言/分区数 + first_seen 时间范围 + 屏蔽口径计数。
// languages 取 subtitle_tracks.lan 去重计数；categories 取 extra.tname 去重计数。
// source 给定时全口径按平台收窄（轨/版本经 video_id 溯源归属平台）；
// opts.exclude_blocked 时视频级指标全部排除已屏蔽 UP（tracks/versions 经 JOIN videos 关联排除），
// creators 恒全量（UP 总数与屏蔽数并列展示才有意义）。模板统一拼接，params 按子查询出现顺序绑定。
export function countOverview(
  db: Database.Database,
  source?: string,
  opts: { exclude_blocked?: boolean } = {},
): Overview {
  // 当日本地零点（ms epoch）：today_videos 的下界。跨时区按 server 本地时区算。
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const nb = opts.exclude_blocked
    ? 'NOT EXISTS (SELECT 1 FROM creators bc WHERE bc.id = v.creator_id AND bc.blocked = 1)'
    : '';
  const src = source ? 'v.source = ?' : '';
  // 视频级子查询的 WHERE 拼接（source + 屏蔽排除 + 调用方附加条件）
  const vw = (extra = '') => {
    const conds = [src, nb, extra].filter(Boolean);
    return conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  };
  // 占位符绑定：子查询含 source 条件时按出现顺序先 push(source)，再 push子查询自身参数（如 today 的零点）
  const params: unknown[] = [];
  const bind = (...rest: unknown[]) => { if (source) params.push(source); params.push(...rest); };
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM videos v${vw()}) as videos,
      (SELECT COUNT(*) FROM subtitle_tracks st JOIN videos v ON v.id = st.video_id${vw()}) as tracks,
      (SELECT COUNT(*) FROM subtitle_versions sv JOIN subtitle_tracks st ON st.id = sv.track_id JOIN videos v ON v.id = st.video_id${vw()}) as versions,
      (SELECT COUNT(*) FROM creators${source ? ' WHERE source = ?' : ''}) as creators,
      (SELECT COUNT(DISTINCT st.lan) FROM subtitle_tracks st JOIN videos v ON v.id = st.video_id${vw('st.lan IS NOT NULL')}) as languages,
      (SELECT COUNT(DISTINCT json_extract(v.extra, '$.tname')) FROM videos v${vw("json_extract(v.extra, '$.tname') IS NOT NULL")}) as categories,
      (SELECT COUNT(*) FROM videos v${vw('v.first_seen_at >= ?')}) as today_videos,
      (SELECT MIN(v.first_seen_at) FROM videos v${vw()}) as first_seen_min,
      (SELECT MAX(v.first_seen_at) FROM videos v${vw()}) as first_seen_max,
      (SELECT COUNT(*) FROM videos v JOIN creators bc ON bc.id = v.creator_id WHERE bc.blocked = 1${source ? ' AND v.source = ?' : ''}) as blocked_videos,
      (SELECT COUNT(*) FROM creators WHERE blocked = 1${source ? ' AND source = ?' : ''}) as blocked_creators
  `;
  // 绑定顺序 = 子查询出现顺序：videos/tracks/versions/creators/languages/categories/today(+零点)/min/max/blocked_videos/blocked_creators
  bind(); bind(); bind(); bind(); bind(); bind();
  bind(todayStart.getTime()); bind(); bind(); bind(); bind();
  return db.prepare(sql).get(...params) as Overview;
}

// 分平台总览（overview 接口/命令用）：全库总 + 按库内出现的平台逐个收窄。
// 平台集合动态取 DISTINCT（0 视频的平台不出现，避免硬编码枚举漂移）。
export function countOverviewWithSources(db: Database.Database): { total: Overview; by_source: Record<string, Overview> } {
  const total = countOverview(db);
  const sources = db.prepare('SELECT DISTINCT source FROM videos ORDER BY source').all() as Array<{ source: string }>;
  const by_source: Record<string, Overview> = {};
  for (const { source } of sources) by_source[source] = countOverview(db, source);
  return { total, by_source };
}
