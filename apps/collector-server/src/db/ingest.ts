import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface IngestVideo {
  source_vid: string;
  title: string;
  creator: { source_uid: string; name?: string; avatar?: string };
  extra?: Record<string, unknown>;
  duration?: number;
  published_at?: number;
}

export interface IngestVersion {
  origin: string;
  payload: unknown;
  source_url?: string | null;
  asr_engine?: string | null;
}

export interface IngestTrack {
  lan?: string;
  lan_doc?: string;
  track_type?: number;
  versions: IngestVersion[];
}

export interface IngestRequest {
  source: string;
  video: IngestVideo;
  tracks: IngestTrack[];
}

export interface IngestResult {
  source: string;
  source_vid: string;
  inserted_tracks: number;
  skipped_tracks: number;
}

const VIDEO_FIELDS = ['title', 'extra', 'duration', 'status', 'published_at'] as const;

// extra 的 change_log 比较辅助：剔除 stat 子对象后再比较，使统计数字波动不产生 change_log。
// 库内 videos.extra 仍存完整 JSON（含最新 stat）；仅"是否记变更 + 记录的快照值"这一步忽略 stat。
function structuralExtra(v: unknown): string {
  if (typeof v !== 'string') return String(v ?? '');
  try {
    const o = JSON.parse(v);
    if (o && typeof o === 'object' && !Array.isArray(o)) delete (o as Record<string, unknown>).stat;
    return JSON.stringify(o);
  } catch { return v; }
}

// 分区字典（data/zones-v1.json，{ tid: { name, code, parent, main } }），模块级懒加载只读一次；读失败降级空字典。
const ZONES: Record<number, { name: string }> = (() => {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'zones-v1.json');
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return {}; }
})();

export function ingestVideo(db: Database.Database, req: IngestRequest): IngestResult {
  const now = Date.now();
  const tx = db.transaction((r: IngestRequest) => {
    // view API 的 tname 恒为空串，extra.tname 由 server 按 tid 用 ZONES 字典反查补全（须在 change_log 比较前生效）。
    const extra = { ...(r.video.extra ?? {}) };
    if (extra.tid != null && ZONES[extra.tid as number]?.name) {
      extra.tname = ZONES[extra.tid as number]!.name;
    }
    r.video.extra = extra;

    // 1. creator upsert + change_log
    const creatorSel = db.prepare('SELECT id, name FROM creators WHERE source = ? AND source_uid = ?');
    const creatorIns = db.prepare('INSERT INTO creators (source, source_uid, name, avatar, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    const creatorUpd = db.prepare('UPDATE creators SET name = ?, avatar = ?, updated_at = ? WHERE id = ?');
    const changeIns = db.prepare('INSERT INTO change_log (entity, entity_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)');

    const existingCreator = creatorSel.get(r.source, r.video.creator.source_uid) as { id: number; name: string | null } | undefined;
    let creatorId: number;
    if (!existingCreator) {
      const info = creatorIns.run(r.source, r.video.creator.source_uid, r.video.creator.name ?? null, r.video.creator.avatar ?? null, now, now);
      creatorId = Number(info.lastInsertRowid);
      changeIns.run('creator', creatorId, 'created', null, r.video.creator.name ?? null, now);
    } else {
      creatorId = existingCreator.id;
      if (r.video.creator.name != null && r.video.creator.name !== existingCreator.name) {
        changeIns.run('creator', creatorId, 'name', existingCreator.name, r.video.creator.name, now);
        creatorUpd.run(r.video.creator.name, r.video.creator.avatar ?? null, now, creatorId);
      }
    }

    // 2. video upsert + change_log（按字段）
    const videoSel = db.prepare('SELECT * FROM videos WHERE source = ? AND source_vid = ?');
    const videoIns = db.prepare('INSERT INTO videos (source, source_vid, creator_id, title, extra, duration, status, published_at, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const videoUpd = db.prepare('UPDATE videos SET creator_id = ?, title = ?, extra = ?, duration = ?, status = ?, published_at = ?, updated_at = ? WHERE id = ?');

    const existingVideo = videoSel.get(r.source, r.video.source_vid) as Record<string, unknown> | undefined;
    let videoId: number;
    if (!existingVideo) {
      const info = videoIns.run(r.source, r.video.source_vid, creatorId, r.video.title, JSON.stringify(r.video.extra ?? {}), r.video.duration ?? null, 'online', r.video.published_at ?? null, now, now);
      videoId = Number(info.lastInsertRowid);
      changeIns.run('video', videoId, 'created', null, r.video.title, now);
    } else {
      videoId = existingVideo.id as number;
      const fields: Record<string, unknown> = {
        title: r.video.title,
        extra: JSON.stringify(r.video.extra ?? {}),
        duration: r.video.duration ?? null,
        status: 'online',
        published_at: r.video.published_at ?? null,
      };
      for (const f of VIDEO_FIELDS) {
        const oldVal = existingVideo[f];
        const newVal = fields[f];
        const isExtra = f === 'extra';
        // extra：剔除 stat 后比较/记录（统计数字波动不记 change_log）；其余字段原样比较
        const oldCmp = isExtra ? structuralExtra(oldVal) : String(oldVal ?? '');
        const newCmp = isExtra ? structuralExtra(newVal) : String(newVal ?? '');
        if (oldCmp !== newCmp) {
          changeIns.run('video', videoId, f, oldVal == null ? null : oldCmp, newVal == null ? null : newCmp, now);
        }
      }
      videoUpd.run(creatorId, fields.title, fields.extra, fields.duration, fields.status, fields.published_at, now, videoId);
    }

    // 3. track upsert
    const trackSel = db.prepare('SELECT id FROM subtitle_tracks WHERE video_id = ? AND lan IS ? AND track_type IS ?');
    const trackIns = db.prepare('INSERT INTO subtitle_tracks (video_id, lan, lan_doc, track_type) VALUES (?, ?, ?, ?)');
    const trackUpd = db.prepare('UPDATE subtitle_tracks SET lan_doc = ? WHERE id = ?');

    // 4. version 写入（按 origin 分支去重）
    //    - external/asr：按 (track_id, origin, asr_engine, source_url) 先 SELECT，命中跳过（幂等去重）
    //    - manual：始终 INSERT 新行（人工导入不去重，保留每次导入的快照）
    const verSel = db.prepare('SELECT id FROM subtitle_versions WHERE track_id = ? AND origin = ? AND coalesce(asr_engine,\'\') = coalesce(?,\'\') AND coalesce(source_url,\'\') = coalesce(?,\'\')');
    const verIns = db.prepare('INSERT INTO subtitle_versions (track_id, origin, payload, body_size, source_url, asr_engine, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

    let inserted = 0;
    let skipped = 0;
    for (const t of r.tracks) {
      let trackId: number;
      const exTrack = trackSel.get(videoId, t.lan ?? null, t.track_type ?? null) as { id: number } | undefined;
      if (!exTrack) {
        const info = trackIns.run(videoId, t.lan ?? null, t.lan_doc ?? null, t.track_type ?? null);
        trackId = Number(info.lastInsertRowid);
      } else {
        trackId = exTrack.id;
        if (t.lan_doc != null) trackUpd.run(t.lan_doc, trackId);
      }
      for (const v of t.versions) {
        const payloadStr = JSON.stringify(v.payload);
        if (v.origin !== 'manual') {
          // external/asr：去重——命中现有行则跳过
          const ex = verSel.get(trackId, v.origin, v.asr_engine ?? null, v.source_url ?? null) as { id: number } | undefined;
          if (ex) { skipped++; continue; }
        }
        // manual（或 external/asr 首次）：始终 INSERT 新行
        verIns.run(trackId, v.origin, payloadStr, payloadStr.length, v.source_url ?? null, v.asr_engine ?? null, now);
        inserted++;
      }
    }
    return { inserted, skipped };
  });
  const { inserted, skipped } = tx(req);
  return { source: req.source, source_vid: req.video.source_vid, inserted_tracks: inserted, skipped_tracks: skipped };
}

// ── P2: UP 主资料 upsert（独立于 ingestVideo，只写 creators）──

export interface IngestUpperRequest {
  source: string;
  creator: {
    source_uid: string;
    name?: string;
    avatar?: string;
    sign?: string;
    level?: number;
    sex?: string;
    official_type?: number;
    official_title?: string;
    fans?: number;
    following?: number;
  };
}

export interface IngestUpperResult {
  source: string;
  source_uid: string;
  updated_fields: string[];
}

// fans/following 是时点 stat（同 videos.stat 哲学），波动不记 change_log；其余字段变化照常记。
const UPPER_STAT_FIELDS = new Set(['fans', 'following']);
const UPPER_FIELDS = ['name', 'avatar', 'sign', 'level', 'sex', 'official_type', 'official_title', 'fans', 'following'] as const;

export function ingestUpper(db: Database.Database, req: IngestUpperRequest): IngestUpperResult {
  const tx = db.transaction((r: IngestUpperRequest): { updated_fields: string[] } => {
    const now = Date.now();
    const creatorSel = db.prepare('SELECT * FROM creators WHERE source = ? AND source_uid = ?');
    const changeIns = db.prepare('INSERT INTO change_log (entity, entity_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)');

    const existing = creatorSel.get(r.source, r.creator.source_uid) as Record<string, unknown> | undefined;

    if (!existing) {
      db.prepare(`INSERT INTO creators (source, source_uid, name, avatar, sign, level, sex, official_type, official_title, fans, following, first_seen_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r.source, r.creator.source_uid,
          r.creator.name ?? null, r.creator.avatar ?? null, r.creator.sign ?? null,
          r.creator.level ?? null, r.creator.sex ?? null, r.creator.official_type ?? null,
          r.creator.official_title ?? null, r.creator.fans ?? null, r.creator.following ?? null,
          now, now);
      return { updated_fields: [...UPPER_FIELDS] };
    }

    const id = existing.id as number;
    const updated: string[] = [];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const f of UPPER_FIELDS) {
      const oldV = existing[f];
      const newV = (r.creator as Record<string, unknown>)[f] ?? null;
      if (String(oldV ?? '') !== String(newV ?? '')) {
        if (!UPPER_STAT_FIELDS.has(f)) {
          changeIns.run('creator', id, f, oldV == null ? null : String(oldV), newV == null ? null : String(newV), now);
        }
        updated.push(f);
        sets.push(`${f} = ?`);
        vals.push(newV);
      }
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      vals.push(now);
      vals.push(id);
      db.prepare(`UPDATE creators SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    return { updated_fields: updated };
  });
  const { updated_fields } = tx(req);
  return { source: req.source, source_uid: req.creator.source_uid, updated_fields };
}
