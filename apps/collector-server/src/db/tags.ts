// 视频标签 DB 层：标签库（tags）+ 视频-标签关系（video_tags）。
// 五档来源中 manual/batch/ai/system 落本表（source 列区分，多档并存）；
// bili 档（B 站自带）不落表，实时读 videos.extra 的 tags JSON（见 http/queries.ts 富化）。
// system 档（2026-08-23）：系统自动状态标（如 no-subtitle「确认无字幕」），采集链路自动打/摘，不打不显示于手动打标选项。
// 打标即建标：applyVideoTags 内 upsert tags 行（INSERT OR IGNORE + 查 id），对齐 setCreatorCategory 哲学。
import type Database from 'better-sqlite3';

export type TagSource = 'manual' | 'batch' | 'ai' | 'system';
export const TAG_SOURCES: readonly TagSource[] = ['manual', 'batch', 'ai', 'system'] as const;

export function isTagSource(v: unknown): v is TagSource {
  return v === 'manual' || v === 'batch' || v === 'ai' || v === 'system';
}

export interface TagRow {
  id: number;
  name: string;
  created_at: number;
}

export interface TagWithCounts extends TagRow {
  counts: { manual: number; batch: number; ai: number; system: number; total: number };
}

// 标签库列表：实时计数（3376 视频规模 COUNT 毫秒级，不冗余 usage_count）。
// counts 恒为四档全量；?scope=ai 过滤「该档计数 >0」的标签（按档位分开可查），
// 排序也按该档计数（省略 scope 时按 total）。
// source（平台）给定时计数只算该平台视频的关系（JOIN videos 收窄；bili/season 档本就不入表，不受影响）。
// 命名约定：档位对外一律叫 scope（video_tags.source 列是历史命名，DB 列不动）；source 保留给平台。
export function listTags(
  db: Database.Database,
  opts: { scope?: TagSource; source?: string; q?: string; topN?: number } = {},
): TagWithCounts[] {
  const conds: string[] = [];
  const vals: unknown[] = [];
  if (opts.q) { conds.push("t.name LIKE ?"); vals.push(`%${opts.q}%`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const counted = opts.scope ?? 'total';
  const totalExpr = counted === 'total' ? '(c_manual + c_batch + c_ai + c_system)' : `c_${counted}`;
  // 平台收窄：关系行经 video 溯源平台后才计入 CASE；无平台时 vv JOIN 不参与判定（全平台口径）
  // 占位符顺序 = SELECT 内 4 个 CASE（各 1 个 source）→ WHERE q → LIMIT，platformVals 排最前
  const platformCond = opts.source ? ' AND vv.source = ?' : '';
  const platformVals = opts.source ? [opts.source, opts.source, opts.source, opts.source] : [];
  const rows = db.prepare(
    `SELECT t.id, t.name, t.created_at,
       SUM(CASE WHEN vt.source = 'manual'${platformCond} THEN 1 ELSE 0 END) AS c_manual,
       SUM(CASE WHEN vt.source = 'batch'${platformCond}  THEN 1 ELSE 0 END) AS c_batch,
       SUM(CASE WHEN vt.source = 'ai'${platformCond}     THEN 1 ELSE 0 END) AS c_ai,
       SUM(CASE WHEN vt.source = 'system'${platformCond} THEN 1 ELSE 0 END) AS c_system
     FROM tags t
     LEFT JOIN video_tags vt ON vt.tag_id = t.id
     LEFT JOIN videos vv ON vv.id = vt.video_id
     ${where}
     GROUP BY t.id, t.name, t.created_at
     ORDER BY ${totalExpr} DESC, t.name ASC
     LIMIT ?`,
  ).all(...platformVals, ...vals, opts.topN ?? 500) as Array<TagRow & { c_manual: number; c_batch: number; c_ai: number; c_system: number }>;
  const mapped = rows.map((r) => ({
    id: r.id, name: r.name, created_at: r.created_at,
    counts: { manual: r.c_manual, batch: r.c_batch, ai: r.c_ai, system: r.c_system, total: r.c_manual + r.c_batch + r.c_ai + r.c_system },
  }));
  // 默认列表含 0 使用标签（标签库可复用，空标签留着下次直接用）；
  // 显式 ?scope= 时只列该档 >0 的（按档位分开可查）；平台过滤同样按收窄后计数判定。
  return opts.scope ? mapped.filter((r) => r.counts[opts.scope!] > 0) : mapped;
}

export interface VideoRef { source: string; source_vid: string }

function resolveVideoIds(db: Database.Database, refs: VideoRef[]): { found: Map<string, number>; missing: VideoRef[] } {
  const found = new Map<string, number>(); // key: `${source}|${vid}`
  const missing: VideoRef[] = [];
  const stmt = db.prepare('SELECT id FROM videos WHERE source = ? AND source_vid = ?');
  for (const r of refs) {
    const row = stmt.get(r.source, r.source_vid) as { id: number } | undefined;
    if (row) found.set(`${r.source}|${r.source_vid}`, row.id);
    else missing.push(r);
  }
  return { found, missing };
}

// 批量打标：打标即建标（upsert tags）+ 关系 INSERT OR IGNORE 幂等。
// scope=档位（manual/batch/ai/system；落 video_tags.source 列——列名是历史命名，对外参数一律叫 scope）。
// 返回 { applied: 命中视频数 × names 的关系写入尝试数（含已存在的忽略）, missing: 库里不存在的视频 }。
export function applyVideoTags(
  db: Database.Database,
  refs: VideoRef[],
  names: string[],
  scope: TagSource,
): { inserted: number; missing: VideoRef[] } {
  const { found, missing } = resolveVideoIds(db, refs);
  const cleanNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (found.size === 0 || cleanNames.length === 0) return { inserted: 0, missing };

  const now = Date.now();
  let inserted = 0;
  const ensureTag = db.prepare('INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?)');
  const tagId = db.prepare('SELECT id FROM tags WHERE name = ?');
  const insertRel = db.prepare('INSERT OR IGNORE INTO video_tags (video_id, tag_id, source, created_at) VALUES (?, ?, ?, ?)');

  db.transaction(() => {
    for (const name of cleanNames) {
      ensureTag.run(name, now);
      const t = tagId.get(name) as { id: number };
      for (const videoId of found.values()) {
        const info = insertRel.run(videoId, t.id, scope, now);
        if (info.changes > 0) inserted++;
      }
    }
  })();
  return { inserted, missing };
}

// 批量移除：scope 省略 → 删该名字的全部三档关系（tags 行保留，库里的标签不因移除关系而消失）。
export function removeVideoTags(
  db: Database.Database,
  refs: VideoRef[],
  names: string[],
  scope?: TagSource,
): { removed: number; missing: VideoRef[] } {
  const { found, missing } = resolveVideoIds(db, refs);
  const cleanNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (found.size === 0 || cleanNames.length === 0) return { removed: 0, missing };

  let removed = 0;
  const stmt = scope
    ? db.prepare(`DELETE FROM video_tags WHERE video_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?) AND source = ?`)
    : db.prepare(`DELETE FROM video_tags WHERE video_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)`);

  db.transaction(() => {
    for (const videoId of found.values()) {
      for (const name of cleanNames) {
        const info = scope ? stmt.run(videoId, name, scope) : stmt.run(videoId, name);
        if (info.changes > 0) removed++;
      }
    }
  })();
  return { removed, missing };
}

// 改名：video_tags 走 tag_id 引用自动生效（无需级联写）。撞已有名由 UNIQUE 抛错（http 层转 409）。
export function renameTag(db: Database.Database, id: number, name: string): TagRow | null {
  const info = db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
  if (info.changes === 0) return null;
  return db.prepare('SELECT id, name, created_at FROM tags WHERE id = ?').get(id) as TagRow;
}

// 删除标签：事务先删关系再删标签（应用层级联，对齐 deleteCategory 先例，无孤儿）。
export function deleteTag(db: Database.Database, id: number): boolean {
  return db.transaction(() => {
    db.prepare('DELETE FROM video_tags WHERE tag_id = ?').run(id);
    const info = db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    return info.changes > 0;
  })();
}

// 批量查视频的关系档标签（enrichItems 富化用）：video_id -> [{name, source}]
export function getVideoTagsByVideoIds(db: Database.Database, videoIds: number[]): Map<number, Array<{ name: string; source: TagSource }>> {
  const map = new Map<number, Array<{ name: string; source: TagSource }>>();
  if (videoIds.length === 0) return map;
  const stmt = db.prepare(
    `SELECT vt.video_id, t.name, vt.source FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = ?`,
  );
  for (const id of videoIds) {
    const rows = stmt.all(id) as Array<{ video_id: number; name: string; source: TagSource }>;
    if (rows.length) map.set(id, rows.map((r) => ({ name: r.name, source: r.source })));
  }
  return map;
}

// 单视频全档关系标签（详情页用；bili 档由调用方从 extra 解析后并入）。
export function getVideoTagsForDetail(db: Database.Database, videoId: number): Array<{ name: string; source: TagSource }> {
  return (db.prepare(
    `SELECT t.name, vt.source FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = ? ORDER BY vt.source, t.name`,
  ).all(videoId) as Array<{ name: string; source: TagSource }>);
}

// ── no-subtitle 系统状态标（2026-08-23，远期 ASR 音频转字幕的定位锚点，见 README Feature 列表）──
// 语义：fetch-subtitle 执行回执 reason=no_subtitle（UP 未传 CC 且平台未生成 AI 字幕）→ 打标；
//       后续 ingest 实际新增字幕轨 → 摘标。与「从未尝试采集」的无轨视频区分，供 ASR 批量圈定。
export const NO_SUBTITLE_TAG = 'no-subtitle';

// 确认无字幕打标：视频须已入库（fetch-subtitle 的 ingest 先行，元信息已落 videos 表）。
// 返回实际写入的关系数（幂等，已带标返回 0）。
export function markNoSubtitle(db: Database.Database, ref: VideoRef): number {
  const r = applyVideoTags(db, [ref], [NO_SUBTITLE_TAG], 'system');
  return r.inserted;
}

// 采到字幕摘标：ingest 新增轨数 > 0 时调用（标失效必须摘，保证 --tag no-subtitle 圈出的恒为真无轨）。
// 返回实际删除的关系数（无标返回 0）。
export function unmarkNoSubtitle(db: Database.Database, ref: VideoRef): number {
  const r = removeVideoTags(db, [ref], [NO_SUBTITLE_TAG], 'system');
  return r.removed;
}
