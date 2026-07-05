import type Database from 'better-sqlite3';

export interface VideoListItem {
  id: number;
  source: string;
  source_vid: string;
  title: string;
  creator_name: string | null;
  duration: number | null;
  track_count: number;
  first_seen_at: number;
}

export function listVideos(db: Database.Database, q: string | undefined, page: number, size: number): { total: number; items: VideoListItem[] } {
  const offset = (page - 1) * size;
  const params: any[] = [];
  let where = '';
  if (q) {
    where = "WHERE v.title LIKE ? OR c.name LIKE ?";
    params.push(`%${q}%`, `%${q}%`);
  }
  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}`).get(...params) as { c: number };
  const rows = db.prepare(`
    SELECT v.id, v.source, v.source_vid, v.title, c.name as creator_name, v.duration, v.first_seen_at,
           (SELECT COUNT(*) FROM subtitle_tracks t WHERE t.video_id = v.id) as track_count
    FROM videos v LEFT JOIN creators c ON c.id = v.creator_id
    ${where}
    ORDER BY v.first_seen_at DESC, v.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, size, offset) as VideoListItem[];
  return { total: totalRow.c, items: rows };
}

export interface VersionRow { id: number; origin: string; source_url: string | null; asr_engine: string | null; captured_at: number; body_size: number | null; }
export interface TrackRow { id: number; lan: string | null; lan_doc: string | null; track_type: number | null; versions: VersionRow[]; }
export interface VideoDetail { video: Record<string, unknown>; tracks: TrackRow[]; }

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

export function getVideo(db: Database.Database, source: string, sourceVid: string): VideoDetail | null {
  const video = db.prepare('SELECT v.*, c.name as creator_name FROM videos v LEFT JOIN creators c ON c.id = v.creator_id WHERE v.source = ? AND v.source_vid = ?').get(source, sourceVid) as Record<string, unknown> | undefined;
  if (!video) return null;
  const tracks = db.prepare('SELECT * FROM subtitle_tracks WHERE video_id = ? ORDER BY id').all(video.id) as Array<{ id: number; lan: string | null; lan_doc: string | null; track_type: number | null }>;
  const allVersions = db.prepare('SELECT * FROM subtitle_versions WHERE track_id = ? ORDER BY id');
  const result: VideoDetail = { video, tracks: [] };
  for (const t of tracks) {
    const vs = allVersions.all(t.id) as VersionRow[];
    const sortedVs = vs.slice().sort((a, b) => versionPriority(a.origin) - versionPriority(b.origin));
    result.tracks.push({ ...t, versions: sortedVs });
  }
  result.tracks.sort((a, b) => trackPriority(a.lan, a.track_type) - trackPriority(b.lan, b.track_type));
  // 标 is_default：每个 track 各自独立标首个 version 为 default（不跨轨串台）
  result.tracks.forEach((t, idx) => {
    (t as any).is_default = idx === 0; // 默认 track 是排序后首个
    let seenVer = false;
    for (const v of t.versions) {
      (v as any).is_default = !seenVer; // 默认 version 是该轨排序后首个
      seenVer = true;
    }
  });
  return result;
}

export function getVersionPayload(db: Database.Database, versionId: number): { id: number; origin: string; payload: unknown; captured_at: number } | null {
  const v = db.prepare('SELECT id, origin, payload, captured_at FROM subtitle_versions WHERE id = ?').get(versionId) as { id: number; origin: string; payload: string; captured_at: number } | undefined;
  if (!v) return null;
  return { id: v.id, origin: v.origin, payload: JSON.parse(v.payload), captured_at: v.captured_at };
}

export interface CreatorDetail {
  id: number;
  source: string;
  source_uid: string;
  name: string | null;
  avatar: string | null;
  sign: string | null;
  level: number | null;
  sex: string | null;
  official_type: number | null;
  official_title: string | null;
  fans: number | null;
  following: number | null;
  category_agent_id: number | null;
  category_agent_name: string | null;
  category_human_id: number | null;
  category_human_name: string | null;
  first_seen_at: number;
  updated_at: number;
}

// 按 creators 表自增 id 取 UP 主详情（含 P2 字段 sign/level/sex/official_*/fans/following + 分类名 join）。
// 供 popup/web 展示 UP 主资料。null = 未找到。
export function getCreator(db: Database.Database, id: number): CreatorDetail | null {
  const row = db.prepare(
    `SELECT c.*, ca.name AS category_agent_name, ch.name AS category_human_name
     FROM creators c
     LEFT JOIN categories ca ON ca.id = c.category_agent_id
     LEFT JOIN categories ch ON ch.id = c.category_human_id
     WHERE c.id = ?`,
  ).get(id) as CreatorDetail | undefined;
  return row ?? null;
}

// ── categories CRUD + creators 列表/打分类（股票 UP 主分类采集 + 后台管理）──

export interface Category {
  id: number;
  name: string;
  scope: 'agent' | 'human';
  sort_order: number;
  created_at: number;
}

export function listCategories(db: Database.Database, scope?: 'agent' | 'human'): Category[] {
  if (scope) return db.prepare('SELECT id, name, scope, sort_order, created_at FROM categories WHERE scope = ? ORDER BY sort_order, id').all(scope) as Category[];
  return db.prepare('SELECT id, name, scope, sort_order, created_at FROM categories ORDER BY scope, sort_order, id').all() as Category[];
}

export function createCategory(db: Database.Database, name: string, scope: 'agent' | 'human'): Category {
  const now = Date.now();
  const info = db.prepare('INSERT INTO categories (name, scope, sort_order, created_at) VALUES (?, ?, 0, ?)').run(name, scope, now);
  return { id: Number(info.lastInsertRowid), name, scope, sort_order: 0, created_at: now };
}

export function updateCategory(db: Database.Database, id: number, patch: { name?: string; sort_order?: number }): Category | null {
  const sets: string[] = []; const vals: unknown[] = [];
  if (patch.name != null) { sets.push('name = ?'); vals.push(patch.name); }
  if (patch.sort_order != null) { sets.push('sort_order = ?'); vals.push(patch.sort_order); }
  if (sets.length === 0) return db.prepare('SELECT id, name, scope, sort_order, created_at FROM categories WHERE id = ?').get(id) as Category | null;
  vals.push(id);
  db.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return db.prepare('SELECT id, name, scope, sort_order, created_at FROM categories WHERE id = ?').get(id) as Category | null;
}

export function deleteCategory(db: Database.Database, id: number): void {
  // 引用置 NULL（应用层兜底，不依赖 FK ON DELETE SET NULL）
  db.prepare('UPDATE creators SET category_agent_id = NULL WHERE category_agent_id = ?').run(id);
  db.prepare('UPDATE creators SET category_human_id = NULL WHERE category_human_id = ?').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
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

export function listCreators(
  db: Database.Database,
  filter: { q?: string; category?: string; scope?: 'agent' | 'human' },
  page: number,
  size: number,
): { total: number; items: CreatorListItem[] } {
  const where: string[] = []; const vals: unknown[] = [];
  if (filter.q) { where.push('(c.name LIKE ? OR c.source_uid LIKE ?)'); vals.push(`%${filter.q}%`, `%${filter.q}%`); }
  if (filter.category && filter.scope) {
    where.push(filter.scope === 'agent'
      ? "c.category_agent_id IN (SELECT id FROM categories WHERE name = ? AND scope = 'agent')"
      : "c.category_human_id IN (SELECT id FROM categories WHERE name = ? AND scope = 'human')");
    vals.push(filter.category);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM creators c ${whereSql}`).get(...vals) as { n: number }).n;
  const offset = (page - 1) * size;
  const items = db.prepare(
    `SELECT c.id, c.source, c.source_uid, c.name, c.avatar, c.fans,
       (SELECT COUNT(*) FROM videos v WHERE v.creator_id = c.id) AS video_count,
       c.category_agent_id, ca.name AS category_agent_name,
       c.category_human_id, ch.name AS category_human_name,
       c.first_seen_at
     FROM creators c
     LEFT JOIN categories ca ON ca.id = c.category_agent_id
     LEFT JOIN categories ch ON ch.id = c.category_human_id
     ${whereSql}
     ORDER BY c.first_seen_at DESC LIMIT ? OFFSET ?`,
  ).all(...vals, size, offset) as CreatorListItem[];
  return { total, items };
}

export interface CreatorDetailFull {
  id: number;
  source: string;
  source_uid: string;
  name: string | null;
  avatar: string | null;
  sign: string | null;
  level: number | null;
  sex: string | null;
  official_type: number | null;
  official_title: string | null;
  fans: number | null;
  following: number | null;
  category_agent_id: number | null;
  category_agent_name: string | null;
  category_human_id: number | null;
  category_human_name: string | null;
  first_seen_at: number;
  updated_at: number;
}

export function getCreatorBySourceUid(db: Database.Database, source: string, source_uid: string): CreatorDetailFull | null {
  return db.prepare(
    `SELECT c.*, ca.name AS category_agent_name, ch.name AS category_human_name
     FROM creators c
     LEFT JOIN categories ca ON ca.id = c.category_agent_id
     LEFT JOIN categories ch ON ch.id = c.category_human_id
     WHERE c.source = ? AND c.source_uid = ?`,
  ).get(source, source_uid) as CreatorDetailFull | null;
}

// 打分类（通用）：查/建 category → upsert creator（不存在建最小行）→ 设对应列。返回最新 creator。
export function setCreatorCategory(
  db: Database.Database,
  source: string,
  source_uid: string,
  scope: 'agent' | 'human',
  categoryName: string,
): CreatorDetailFull {
  let cat = db.prepare('SELECT id FROM categories WHERE name = ? AND scope = ?').get(categoryName, scope) as { id: number } | undefined;
  if (!cat) {
    const now = Date.now();
    const info = db.prepare('INSERT INTO categories (name, scope, sort_order, created_at) VALUES (?, ?, 0, ?)').run(categoryName, scope, now);
    cat = { id: Number(info.lastInsertRowid) };
  }
  const existing = db.prepare('SELECT id FROM creators WHERE source = ? AND source_uid = ?').get(source, source_uid) as { id: number } | undefined;
  const col = scope === 'agent' ? 'category_agent_id' : 'category_human_id';
  if (!existing) {
    const now = Date.now();
    const info = db.prepare('INSERT INTO creators (source, source_uid, first_seen_at, updated_at, ' + col + ') VALUES (?, ?, ?, ?, ?)').run(source, source_uid, now, now, cat.id);
    db.prepare('UPDATE creators SET ' + col + ' = ? WHERE id = ?').run(cat.id, Number(info.lastInsertRowid));
  } else {
    db.prepare('UPDATE creators SET ' + col + ' = ?, updated_at = ? WHERE id = ?').run(cat.id, Date.now(), existing.id);
  }
  return getCreatorBySourceUid(db, source, source_uid)!;
}
