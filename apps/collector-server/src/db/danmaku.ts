import type Database from 'better-sqlite3';

// B 站弹幕持久层（2026-10-07 弹幕采集解冻，PLAN docs/plans/danmaku/PLAN.md §3）。
// 职责：幂等 upsert（观测列刷新/首采列保留）、count 哨兵查询、时间轴全量行查询。
// 与评论的差异（PLAN §3.3）：无 pins/无 missing/无 R0 三元组修正——弹幕无关联结构，
// upsert 就是纯键值幂等；删除不物理删、无 missing 机制（全量重拉成本低，§0 D7）。
// 校验统计（R1-R5）拆 danmaku-verify.ts（模块 ≤400 行纪律）。

/** danmaku 表全列（SELECT * 原样，snake_case 对齐列名） */
export interface DanmakuRecord {
  id: number;
  id_str: string;
  video_id: number;
  cid: number;
  page: number;
  progress_ms: number | null;
  mode: number | null;
  fontsize: number | null;
  color: number | null;
  mid_hash: string | null;
  content: string | null;
  ctime_s: number | null;
  weight: number | null;
  pool: number | null;
  action: string | null;
  first_seen_at: number;
  last_seen_at: number;
  batch_id: string | null;
}

/**
 * 已解析归一化的弹幕行（cli/bili-danmaku.ts 解析产物）。
 * 唯一键恒取 id_str（protobuf field12 字符串；field1 int64 在 JS Number 下尾数漂移
 * ——实测 37828425933127683→…80，严禁作键，PLAN §2.3）。
 */
export interface DanmakuUpsertRow {
  id_str: string;
  cid: number;
  page: number;
  progress_ms: number | null;
  mode: number | null;
  fontsize: number | null;
  color: number | null;
  mid_hash: string | null;
  content: string | null;
  ctime_s: number | null;
  weight: number | null;
  pool: number | null;
  action: string | null;
}

export interface UpsertDanmakuOpts {
  /** 本批抓取时刻（毫秒）；写入 last_seen_at，首采行同时写 first_seen_at */
  fetchedAt: number;
  /** 首采批次 uuid（仅首采写入，重采不动） */
  batchId: string;
}

/**
 * 幂等批量 upsert（单事务，PLAN §3.3）。已存在（UNIQUE id_str 命中）→ UPDATE 观测列
 * （progress_ms/mode/fontsize/color/mid_hash/content/ctime_s/weight/pool/action 以本轮值刷新，
 * last_seen_at = fetchedAt）——弹幕发送后不可编辑，内容理论不变；刷新是防御 B 站侧修正，幂等无害。
 * 保留列：id/video_id/cid/page/first_seen_at/batch_id。
 * 空数组防御：不开事务直接返回零计数（分段判停轮可能 0 条，无需空事务）。
 * 同批重复 id_str（跨段边界池快照重叠）天然幂等吸收：先 INSERT 后 UPDATE，后值生效。
 * 返回 { inserted, updated }。
 */
export function upsertDanmaku(
  db: Database.Database,
  videoId: number,
  rows: DanmakuUpsertRow[],
  opts: UpsertDanmakuOpts,
): { inserted: number; updated: number } {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const { fetchedAt, batchId } = opts;
  const sel = db.prepare('SELECT id_str FROM danmaku WHERE id_str = ?');
  const ins = db.prepare(`
    INSERT INTO danmaku (
      id_str, video_id, cid, page,
      progress_ms, mode, fontsize, color, mid_hash, content, ctime_s, weight, pool, action,
      first_seen_at, last_seen_at, batch_id
    ) VALUES (${Array.from({ length: 17 }, () => '?').join(', ')})
  `);
  const upd = db.prepare(`
    UPDATE danmaku SET
      progress_ms = ?, mode = ?, fontsize = ?, color = ?, mid_hash = ?, content = ?,
      ctime_s = ?, weight = ?, pool = ?, action = ?, last_seen_at = ?
    WHERE id_str = ?`);
  let inserted = 0;
  let updated = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      const existing = sel.get(r.id_str) as { id_str: string } | undefined;
      if (existing) {
        upd.run(
          r.progress_ms, r.mode, r.fontsize, r.color, r.mid_hash, r.content,
          r.ctime_s, r.weight, r.pool, r.action, fetchedAt, r.id_str,
        );
        updated++;
      } else {
        ins.run(
          r.id_str, videoId, r.cid, r.page,
          r.progress_ms, r.mode, r.fontsize, r.color, r.mid_hash, r.content, r.ctime_s, r.weight, r.pool, r.action,
          fetchedAt, fetchedAt, batchId,
        );
        inserted++;
      }
    }
  });
  run();
  return { inserted, updated };
}

export interface DanmakuCount {
  rows: number;
  /** 分 P 聚合（GROUP BY cid,page；0 行时为空数组），键名 snake_case 对齐 §5.3 verify 回执 by_page（http 响应直出免转换） */
  pages: Array<{ cid: number; page: number; rows: number }>;
  max_ctime_s: number | null;
  /** progress 跨度取全部非空原值口径（含 -1 高级弹幕，min 会取到负值；§2.3 原值保留，消费端自行甄别） */
  min_progress_ms: number | null;
  max_progress_ms: number | null;
}

/** count 哨兵查询（PLAN §3.4，供采集判停回执与 verify counts 段） */
export function danmakuCount(db: Database.Database, videoId: number): DanmakuCount {
  const total = db.prepare(`
    SELECT COUNT(*) AS rows_count,
           MAX(ctime_s) AS max_ctime_s,
           MIN(progress_ms) AS min_progress_ms,
           MAX(progress_ms) AS max_progress_ms
    FROM danmaku WHERE video_id = ?
  `).get(videoId) as {
    rows_count: number;
    max_ctime_s: number | null;
    min_progress_ms: number | null;
    max_progress_ms: number | null;
  };
  const pages = db.prepare(`
    SELECT cid, page, COUNT(*) AS rows_count
    FROM danmaku WHERE video_id = ?
    GROUP BY cid, page ORDER BY cid ASC, page ASC
  `).all(videoId) as Array<{ cid: number; page: number; rows_count: number }>;
  return {
    rows: total.rows_count,
    pages: pages.map((p) => ({ cid: p.cid, page: p.page, rows: p.rows_count })),
    max_ctime_s: total.max_ctime_s,
    min_progress_ms: total.min_progress_ms,
    max_progress_ms: total.max_progress_ms,
  };
}

/**
 * 时间轴全量行（PLAN §3.4，供 bundle 正文与导出）：按 (cid, progress_ms) 升序。
 * SQLite ASC 对 NULL 排最前、负值（-1 高级弹幕）排 NULL 之后正点之前——消费端按 §2.3 处置；
 * 同 (cid, progress_ms) 以 id 升序 tie 保确定序。
 */
export function danmakuTimeline(db: Database.Database, videoId: number): DanmakuRecord[] {
  return db.prepare(`
    SELECT * FROM danmaku WHERE video_id = ?
    ORDER BY cid ASC, progress_ms ASC, id ASC
  `).all(videoId) as DanmakuRecord[];
}
