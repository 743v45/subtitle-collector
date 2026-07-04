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
  first_seen_at: number;
  updated_at: number;
}

// 按 creators 表自增 id 取 UP 主详情（含 P2 字段 sign/level/sex/official_*/fans/following）。
// 供 popup/web 展示 UP 主资料。null = 未找到。
export function getCreator(db: Database.Database, id: number): CreatorDetail | null {
  const row = db.prepare('SELECT * FROM creators WHERE id = ?').get(id) as CreatorDetail | undefined;
  return row ?? null;
}
