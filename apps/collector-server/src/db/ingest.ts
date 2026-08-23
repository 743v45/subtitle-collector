import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unmarkNoSubtitle } from './tags.js';

// creator 契约（与扩展侧共同约定）：payload 不携带 creator（或 source_uid 为 null/undefined/空串）时，
// server 不 upsert creator 行——新视频 creator_id 写 null（schema 允许）；重采 UPDATE 保留旧归属
// （COALESCE 语义，合法视频经不带 creator 的路径重采不误清）。
// 扩展侧旧版本会把缺失 uid 填字面 'unknown' 发来——UNIQUE(source, source_uid) 会把不同频道的
// 视频吸进同一虚构 UP 行，故 'unknown' 一律视同缺失（两端改动落地窗口期的脏数据防御）。
export interface IngestVideo {
  source_vid: string;
  title: string;
  creator?: { source_uid?: string | null; name?: string; avatar?: string } | null;
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

const VIDEO_FIELDS = ['title', 'extra', 'duration', 'published_at', 'paid'] as const;

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

// 重采 extra 合并（UPDATE 路径）：整体替换保持现状，唯 tags 保底——
// 新 extra 无 tags 字段或空数组时保留旧 extra.tags。tag 接口失败的重采会把已入库的
// B 站档标签整体冲掉（bili 档标签只存 extra.tags，无独立表），此处兜底。
function mergeExtraTags(newExtra: Record<string, unknown>, oldExtraJson: unknown): Record<string, unknown> {
  const merged = { ...newExtra };
  const newTags = merged.tags;
  // 新值带非空 tags（或非数组的原样值）→ 正常整体替换，不保底
  if (newTags != null && (!Array.isArray(newTags) || newTags.length > 0)) return merged;
  let oldTags: unknown[] | null = null;
  if (typeof oldExtraJson === 'string') {
    try {
      const o: unknown = JSON.parse(oldExtraJson);
      const t = (o as Record<string, unknown> | null)?.tags;
      if (Array.isArray(t) && t.length > 0) oldTags = t;
    } catch { /* 旧 extra 非合法 JSON → 无 tags 可保 */ }
  }
  if (oldTags != null) merged.tags = oldTags;
  return merged;
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

    // paid 标志：扩展在 extra.paid 算好（综合 is_upower_exclusive/is_ugc_pay_preview/elec_high_level/rights），
    // 可能是 boolean/number，统一 Number() 转 0/1 落独立列；extra.paid 原值随 JSON 整列存（双写）。
    // extra 无 paid 键 → null = 本次未知：新建行落默认 0；重采 UPDATE 遵循「paid 只升不降」保留旧值。
    const paidRaw = r.video.extra?.paid;
    const paidNew = paidRaw == null ? null : (Number(paidRaw) ? 1 : 0);

    // 1. creator upsert + change_log（缺失契约见 IngestVideo 注释：不发/空串/'unknown' 一律视同缺失）
    const creator = r.video.creator;
    const creatorUid = creator?.source_uid;
    const hasCreator = typeof creatorUid === 'string' && creatorUid !== '' && creatorUid !== 'unknown';
    const creatorSel = db.prepare('SELECT id, name FROM creators WHERE source = ? AND source_uid = ?');
    const creatorIns = db.prepare('INSERT INTO creators (source, source_uid, name, avatar, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    const creatorUpd = db.prepare('UPDATE creators SET name = ?, avatar = ?, updated_at = ? WHERE id = ?');
    const changeIns = db.prepare('INSERT INTO change_log (entity, entity_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)');

    let creatorId: number | null = null;
    if (creator && hasCreator) {
      const existingCreator = creatorSel.get(r.source, creatorUid) as { id: number; name: string | null } | undefined;
      if (!existingCreator) {
        const info = creatorIns.run(r.source, creatorUid, creator.name ?? null, creator.avatar ?? null, now, now);
        creatorId = Number(info.lastInsertRowid);
        changeIns.run('creator', creatorId, 'created', null, creator.name ?? null, now);
      } else {
        creatorId = existingCreator.id;
        if (creator.name != null && creator.name !== existingCreator.name) {
          changeIns.run('creator', creatorId, 'name', existingCreator.name, creator.name, now);
          creatorUpd.run(creator.name, creator.avatar ?? null, now, creatorId);
        }
      }
    }

    // 2. video upsert + change_log（按字段）
    const videoSel = db.prepare('SELECT * FROM videos WHERE source = ? AND source_vid = ?');
    const videoIns = db.prepare('INSERT INTO videos (source, source_vid, creator_id, title, extra, duration, published_at, paid, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const videoUpd = db.prepare('UPDATE videos SET creator_id = ?, title = ?, extra = ?, duration = ?, published_at = ?, paid = ?, updated_at = ? WHERE id = ?');

    const existingVideo = videoSel.get(r.source, r.video.source_vid) as Record<string, unknown> | undefined;
    let videoId: number;
    if (!existingVideo) {
      const info = videoIns.run(r.source, r.video.source_vid, creatorId, r.video.title, JSON.stringify(r.video.extra ?? {}), r.video.duration ?? null, r.video.published_at ?? null, paidNew ?? 0, now, now);
      videoId = Number(info.lastInsertRowid);
      changeIns.run('video', videoId, 'created', null, r.video.title, now);
    } else {
      videoId = existingVideo.id as number;
      // 重采 UPDATE 合并语义（防浏览路径/受限重采把已有元信息冲掉；change_log 按合并后的终值比对）：
      //   duration/published_at：新值非空才覆盖（COALESCE(new, old)——浏览路径 payload 可能不带）；
      //   paid：新值非空且 > 旧值才覆盖（只升不降——付费片重采 payload 不带 paid 标志时防 1→0 回落；
      //         extra JSON 整列替换仍存本次原值，列与 JSON 可能短暂不一致，查询以独立列为准）；
      //   title：新值优先（标题会改版，属正常更新），但新值 null 不覆盖；
      //   creator_id：同 COALESCE 语义——本次缺 creator_uid 保留旧归属（合法视频经一条不带
      //   creator 的采集路径重采不应误清；'unknown' 挂靠清理由订正脚本/重采带真值时覆盖）；
      //   extra：整体替换 + tags 保底（见 mergeExtraTags）。
      const oldPaid = (existingVideo.paid as number | null) ?? 0;
      const fields: Record<string, unknown> = {
        title: r.video.title ?? existingVideo.title,
        duration: r.video.duration ?? existingVideo.duration,
        published_at: r.video.published_at ?? existingVideo.published_at,
        paid: paidNew != null && paidNew > oldPaid ? paidNew : oldPaid,
        extra: JSON.stringify(mergeExtraTags(r.video.extra ?? {}, existingVideo.extra)),
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
      videoUpd.run(creatorId ?? existingVideo.creator_id, fields.title, fields.extra, fields.duration, fields.published_at, fields.paid, now, videoId);
    }

    // 2.5 任务行 UP 归属回填（collect_tasks.creator_uid，2026-08-22 历史页按 UP 筛未入库任务）：
    // 该视频的任务行（pending/failed 尚未入库的）在此拿到归属。归属取该视频当前库内归属
    // （本次 upsert 已生效，同事务可见）；只补 NULL 行，不覆盖调用方显式落的值。
    db.prepare(
      `UPDATE collect_tasks
       SET creator_uid = (SELECT c.source_uid FROM videos v JOIN creators c ON c.id = v.creator_id
                          WHERE v.source = collect_tasks.source AND v.source_vid = collect_tasks.source_vid)
       WHERE source = ? AND source_vid = ? AND creator_uid IS NULL`,
    ).run(r.source, r.video.source_vid);

    const { inserted, skipped } = insertTracksVersions(db, videoId, r.tracks, now);
    // 实际新增字幕轨 → 摘 no-subtitle 系统标（此前确认无字幕的视频重采到了轨，标失效必须摘，
    // 保证 --tag no-subtitle 圈出的恒为真无轨；同事务内，标随轨原子翻转）。
    if (inserted > 0) unmarkNoSubtitle(db, { source: r.source, source_vid: r.video.source_vid });
    return { inserted, skipped };
  });
  const { inserted, skipped } = tx(req);
  return { source: req.source, source_vid: req.video.source_vid, inserted_tracks: inserted, skipped_tracks: skipped };
}

// track+version 写入（ingestVideo 步骤 3/4 抽出，2026-08-23）：translate fill（http/translate.ts）
// 复用同一写入路径——补翻轨走 origin='manual' 的既有语义（不去重、保留每次导入快照）。
// 不开事务：调用方负责包事务（ingestVideo 的 tx / fill handler 的 tx），本函数只保证语句序列。
export function insertTracksVersions(
  db: Database.Database,
  videoId: number,
  tracks: IngestTrack[],
  now: number,
): { inserted: number; skipped: number } {
  // 3. track upsert
  const trackSel = db.prepare('SELECT id FROM subtitle_tracks WHERE video_id = ? AND lan IS ? AND track_type IS ?');
  const trackIns = db.prepare('INSERT INTO subtitle_tracks (video_id, lan, lan_doc, track_type) VALUES (?, ?, ?, ?)');
  const trackUpd = db.prepare('UPDATE subtitle_tracks SET lan_doc = ? WHERE id = ?');

  // 4. version 写入（按 origin 分支去重）
  //    - external/asr：按 (track_id, origin, asr_engine, body_hash) 先 SELECT，命中跳过（幂等去重）。
  //      去重键用字幕体 hash 而非 source_url——source_url 是带会话签名的临时 URL
  //      （YouTube timedtext 的 signature/expire/pot、B 站 AI 字幕同理），跨会话必不同，
  //      用它去重会让重采必插重复行。内容真变化（hash 不同）→ 新版本行，符合版本语义。
  //      存量行 body_hash 为 NULL：NULL = ? 不成立，天然不参与去重（成为孤立历史行）。
  //    - manual：始终 INSERT 新行（人工导入不去重，保留每次导入的快照）
  const verSel = db.prepare('SELECT id FROM subtitle_versions WHERE track_id = ? AND origin = ? AND coalesce(asr_engine,\'\') = coalesce(?,\'\') AND body_hash = ?');
  const verIns = db.prepare('INSERT INTO subtitle_versions (track_id, origin, payload, body_size, body_hash, source_url, asr_engine, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

  let inserted = 0;
  let skipped = 0;
  for (const t of tracks) {
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
      const bodyHash = createHash('sha256').update(payloadStr).digest('hex');
      if (v.origin !== 'manual') {
        // external/asr：去重——命中现有行则跳过
        const ex = verSel.get(trackId, v.origin, v.asr_engine ?? null, bodyHash) as { id: number } | undefined;
        if (ex) { skipped++; continue; }
      }
      // manual（或 external/asr 首次）：始终 INSERT 新行
      verIns.run(trackId, v.origin, payloadStr, payloadStr.length, bodyHash, v.source_url ?? null, v.asr_engine ?? null, now);
      inserted++;
    }
  }
  return { inserted, skipped };
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
      const info = db.prepare(`INSERT INTO creators (source, source_uid, name, avatar, sign, level, sex, official_type, official_title, fans, following, first_seen_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r.source, r.creator.source_uid,
          r.creator.name ?? null, r.creator.avatar ?? null, r.creator.sign ?? null,
          r.creator.level ?? null, r.creator.sex ?? null, r.creator.official_type ?? null,
          r.creator.official_title ?? null, r.creator.fans ?? null, r.creator.following ?? null,
          now, now);
      // 创建审计对齐 ingestVideo：新建 creator 同样记 change_log 'created'（否则两条创建路径一条审计一条不审计）
      changeIns.run('creator', Number(info.lastInsertRowid), 'created', null, r.creator.name ?? null, now);
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
