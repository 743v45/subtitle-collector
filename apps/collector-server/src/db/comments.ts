import type Database from 'better-sqlite3';

// B 站评论持久层（2026-10-03 评论采集解冻，PLAN docs/plans/comments/PLAN.md §3）。
// 职责：幂等 upsert（观测列更新/首采列保留/R0 三元组修正）、置顶先清后打、
// missing 两轮删除对账（仅根评论）、count 哨兵查询、按根分组树查询。
// 树完整性校验（R0-R9）拆 comments-verify.ts，统计数学拆 comments-stats.ts（模块 ≤400 行纪律）。
// 完整轮守卫（伪完整轮 suspicious_truncation 等）在调用方（http/cli 层）判定后才允许触发
// reconcileMissing——本模块只做置候选/恢复两步纯 db 操作。

/** comments 表全列（SELECT * 原样，snake_case 对齐列名） */
export interface CommentRecord {
  id: number;
  rpid_str: string;
  video_id: number;
  root_rpid: string;
  parent_rpid: string;
  dialog_rpid: string;
  is_root: number;
  mid_str: string | null;
  uname: string | null;
  parent_reply_name: string | null;
  member: string | null;
  message: string | null;
  content: string | null;
  like_count: number;
  rcount: number;
  reply_total: number;
  ctime_s: number | null;
  ip_location: string | null;
  state: number;
  invisible: number;
  folded: number;
  up_like: number;
  up_reply: number;
  is_up: number;
  pin_kind: string | null;
  first_seen_at: number;
  last_seen_at: number;
  first_page: number | null;
  first_sort: string | null;
  batch_id: string | null;
  missing_since: number | null;
}

/**
 * 已解析归一化的评论行（cli/bili-comments.ts 解析产物；member/content 为 JSON 字符串）。
 * 五 ID 恒取 *_str 形态；is_up 不在此——由服务端按本请求 upper_mid 计算（PLAN §2.3）。
 */
export interface CommentUpsertRow {
  rpid_str: string;
  root_rpid: string;
  parent_rpid: string;
  dialog_rpid: string;
  mid_str: string | null;
  uname: string | null;
  parent_reply_name: string | null;
  member: string | null;
  message: string | null;
  content: string | null;
  like_count: number;
  rcount: number;
  reply_total: number;
  ctime_s: number | null;
  ip_location: string | null;
  state: number;
  invisible: number;
  folded: number;
  up_like: number;
  up_reply: number;
}

export interface UpsertCommentsArgs {
  videoId: number;
  /** 主接口 data.upper.mid（number|string 均可，String() 直读防御，PLAN §2.3）；null/缺省=无法判定（UPDATE 保留库内 is_up，INSERT 落 0） */
  upperMid?: string | number | null;
  replies: CommentUpsertRow[];
  /** 本批抓取时刻（毫秒）；写入 last_seen_at，首采行同时写 first_seen_at */
  fetchedAt: number;
  /** 首采批次 uuid（仅首采写入，重采不动） */
  batchId: string | null;
  /** 主列表页序（仅根评论批；楼中楼批不传） */
  page?: number | null;
  /** 本轮排序 'hot'|'time'（仅根评论批；诊断用） */
  sort?: string | null;
}

// R0 自洽判定（PLAN §5.1）：根行 root='0' 且 parent='0'；楼行 root!=='0' 且 parent!=='0'。
const tripleSelfConsistent = (root: string, parent: string): boolean =>
  (root === '0' && parent === '0') || (root !== '0' && parent !== '0');

const nowUpFlag = (upperMid: string | number | null | undefined, midStr: string | null): number =>
  upperMid != null && String(upperMid) === (midStr ?? '') ? 1 : 0;

/**
 * 幂等批量 upsert（单事务，PLAN §3.3）。已存在（UNIQUE rpid_str 命中）→ UPDATE 观测列
 * （like/rcount/reply_total/state/invisible/folded/up_like/up_reply/is_up（按本请求 upper_mid
 * 重算）/mid_str/uname/parent_reply_name/member/message/content/ip_location/ctime_s，last_seen_at=fetchedAt）；
 * 保留列：id/video_id/first_seen_at/first_page/first_sort/batch_id/missing_since。
 * 关联三元组防御性保留（首采值不改写，防上游异常形态污染已还原的树）；例外——库内现值违反
 * R0 而本轮新值自洽 → 以新值修正并打 [store] 修正日志；新值同样不自洽 → 不修正。
 * pin_kind 不在本函数写：full 轮由调用方随后 clearAndSetPins 先清后打；incremental 轮不发
 * pins、不动 pin_kind（PLAN §3.3）——更新清单里的 pin_kind 由置顶清打步骤承担。
 * 返回 { inserted, updated }。同批重复 rpid（置顶+列表双出现）天然幂等吸收（先 INSERT 后 UPDATE）。
 */
export function upsertComments(
  db: Database.Database,
  args: UpsertCommentsArgs,
): { inserted: number; updated: number } {
  const { videoId, upperMid, fetchedAt, batchId, page, sort } = args;
  const sel = db.prepare(
    'SELECT root_rpid, parent_rpid, dialog_rpid FROM comments WHERE rpid_str = ?',
  );
  const ins = db.prepare(`
    INSERT INTO comments (
      rpid_str, video_id, root_rpid, parent_rpid, dialog_rpid, is_root,
      mid_str, uname, parent_reply_name, member, message, content,
      like_count, rcount, reply_total, ctime_s, ip_location,
      state, invisible, folded, up_like, up_reply, is_up,
      first_seen_at, last_seen_at, first_page, first_sort, batch_id
    ) VALUES (${Array.from({ length: 28 }, () => '?').join(', ')})
  `);
  // upperMid 可判定时重算 is_up；不可判定（null）时保留库内值
  const upd = upperMid == null
    ? db.prepare(`
        UPDATE comments SET
          like_count = ?, rcount = ?, reply_total = ?, state = ?, invisible = ?, folded = ?,
          up_like = ?, up_reply = ?, mid_str = ?, uname = ?, parent_reply_name = ?, member = ?, message = ?, content = ?,
          ip_location = ?, ctime_s = ?, last_seen_at = ?
        WHERE rpid_str = ?`)
    : db.prepare(`
        UPDATE comments SET
          like_count = ?, rcount = ?, reply_total = ?, state = ?, invisible = ?, folded = ?,
          up_like = ?, up_reply = ?, is_up = ?, mid_str = ?, uname = ?, parent_reply_name = ?, member = ?, message = ?,
          content = ?, ip_location = ?, ctime_s = ?, last_seen_at = ?
        WHERE rpid_str = ?`);
  const fixTriple = db.prepare(
    'UPDATE comments SET root_rpid = ?, parent_rpid = ?, dialog_rpid = ?, is_root = ? WHERE rpid_str = ?',
  );

  let inserted = 0;
  let updated = 0;
  const run = db.transaction(() => {
    for (const r of args.replies) {
      const existing = sel.get(r.rpid_str) as
        | { root_rpid: string; parent_rpid: string; dialog_rpid: string }
        | undefined;
      if (existing) {
        const upFlag = nowUpFlag(upperMid, r.mid_str);
        if (upperMid == null) {
          upd.run(
            r.like_count, r.rcount, r.reply_total, r.state, r.invisible, r.folded,
            r.up_like, r.up_reply, r.mid_str, r.uname, r.parent_reply_name, r.member, r.message, r.content,
            r.ip_location, r.ctime_s, fetchedAt, r.rpid_str,
          );
        } else {
          upd.run(
            r.like_count, r.rcount, r.reply_total, r.state, r.invisible, r.folded,
            r.up_like, r.up_reply, upFlag, r.mid_str, r.uname, r.parent_reply_name, r.member, r.message,
            r.content, r.ip_location, r.ctime_s, fetchedAt, r.rpid_str,
          );
        }
        // R0 违例修正：库内三元组不自洽、新值自洽 → 以新值修正（含 is_root 重算）
        if (!tripleSelfConsistent(existing.root_rpid, existing.parent_rpid)
          && tripleSelfConsistent(r.root_rpid, r.parent_rpid)) {
          fixTriple.run(r.root_rpid, r.parent_rpid, r.dialog_rpid, r.root_rpid === '0' ? 1 : 0, r.rpid_str);
          console.error(
            `[store] R0 关联三元组修正 rpid_str=${r.rpid_str} `
            + `旧(root=${existing.root_rpid},parent=${existing.parent_rpid}) `
            + `→ 新(root=${r.root_rpid},parent=${r.parent_rpid},dialog=${r.dialog_rpid})`,
          );
        }
        updated++;
      } else {
        ins.run(
          r.rpid_str, videoId, r.root_rpid, r.parent_rpid, r.dialog_rpid, r.root_rpid === '0' ? 1 : 0,
          r.mid_str, r.uname, r.parent_reply_name, r.member, r.message, r.content,
          r.like_count, r.rcount, r.reply_total, r.ctime_s, r.ip_location,
          r.state, r.invisible, r.folded, r.up_like, r.up_reply, nowUpFlag(upperMid, r.mid_str),
          fetchedAt, fetchedAt, page ?? null, sort ?? null, batchId,
        );
        inserted++;
      }
    }
  });
  run();
  return { inserted, updated };
}

export interface CommentPin {
  rpid_str: string;
  kind: string; // 'admin' | 'upper' | 'vote'
}

/**
 * 置顶先清后打（仅 full 轮调用，PLAN §3.3）：先清本视频全部 pin_kind，再按本轮 pins 打值。
 * 置顶撤销/换条目自然生效；incremental 轮不发 pins、不调用本函数（置顶变更下次 full 轮生效）。
 * 返回 { cleared, set } 供 [store] 观察日志（set 只计实际命中行；引用不存在行不报错）。
 */
export function clearAndSetPins(
  db: Database.Database,
  videoId: number,
  pins: CommentPin[],
): { cleared: number; set: number } {
  const clear = db.prepare('UPDATE comments SET pin_kind = NULL WHERE video_id = ? AND pin_kind IS NOT NULL');
  const mark = db.prepare('UPDATE comments SET pin_kind = ? WHERE video_id = ? AND rpid_str = ?');
  let set = 0;
  const run = db.transaction(() => {
    const cleared = clear.run(videoId).changes;
    for (const p of pins) set += mark.run(p.kind, videoId, p.rpid_str).changes;
    return cleared;
  });
  const cleared = run();
  return { cleared, set };
}

/**
 * missing 对账两步（仅根评论，PLAN §3.3 两条 SQL 原文；is_root=1 必带——
 * 楼中楼可达性依附根，根删后整楼结构性不可达，对楼层也判定会把整楼孩子误判缺失，
 * 与 §3.4 不丢弃策略矛盾）。完整轮守卫由调用方保证。
 * 执行序：恢复 → 确认快照 → 置候选。两条 UPDATE 条件互斥（last_seen 与 scan_start 比较方向相反），
 * 先后不影响库内终态；确认计数必须在置候选前取——候选置值当轮 last_seen 必然 < missing_since，
 * 置后取会把单轮缺席立即误计为确认，破坏「两轮均完整轮才确认」语义（§3.3 守卫 3 / D6）。
 * 返回 { candidates, restored, confirmed }：candidates=本轮新置候选（首次缺席）；
 * restored=本轮重新见到的根行数（SQL matched 口径，含本就正常的行）；confirmed=此前轮次
 * 置候选、至今仍未再见（last_seen_at < missing_since）的根数，即 ≥2 轮确认缺失。
 */
export function reconcileMissing(
  db: Database.Database,
  args: { videoId: number; scanStart: number },
): { candidates: number; restored: number; confirmed: number } {
  const setCandidates = db.prepare(`
    UPDATE comments SET missing_since = ?
     WHERE video_id = ? AND is_root = 1 AND missing_since IS NULL AND last_seen_at < ?`);
  const restore = db.prepare(`
    UPDATE comments SET missing_since = NULL
     WHERE video_id = ? AND is_root = 1 AND last_seen_at >= ?`);
  const countConfirmed = db.prepare(`
    SELECT COUNT(*) AS n FROM comments
     WHERE video_id = ? AND is_root = 1 AND missing_since IS NOT NULL AND last_seen_at < missing_since`);
  let candidates = 0;
  let restored = 0;
  let confirmed = 0;
  const run = db.transaction(() => {
    restored = restore.run(args.videoId, args.scanStart).changes;
    confirmed = (countConfirmed.get(args.videoId) as { n: number }).n;
    candidates = setCandidates.run(args.scanStart, args.videoId, args.scanStart).changes;
  });
  run();
  return { candidates, restored, confirmed };
}

export interface CommentsCount {
  rows: number;
  roots: number;
  /** 根评论最大 ctime_s（unix 秒；增量轮水位）。仅统计根——楼中楼回复可晚于全部根（老楼追新），
   *  混入会把水位抬高于任何根、incremental 首页即判停漏采新根（PLAN §4.3 水位只比对主列表根行） */
  maxCtimeS: number | null;
}

/** GET /api/comments/count 底层查询（PLAN §4.1）：评论行数/根数/最大发布时间秒 */
export function commentsCount(db: Database.Database, videoId: number): CommentsCount {
  const row = db.prepare(`
    SELECT COUNT(*) AS rows_count,
           COALESCE(SUM(is_root), 0) AS roots_count,
           MAX(CASE WHEN is_root = 1 THEN ctime_s END) AS max_ctime_s
    FROM comments WHERE video_id = ?
  `).get(videoId) as { rows_count: number; roots_count: number; max_ctime_s: number | null };
  return { rows: row.rows_count, roots: row.roots_count, maxCtimeS: row.max_ctime_s };
}

export interface CommentTree {
  /** 根评论（like_count 降序，高赞优先供分析 §6.3；tie 按 ctime_s 升序保确定序） */
  roots: CommentRecord[];
  /** 楼中楼按根分组（组内 ctime_s 升序）；键可能无对应根行——根已删的孤儿楼层保留原 root_rpid 归组（§3.4） */
  floorsByRoot: Map<string, CommentRecord[]>;
}

/** 楼中楼按根分组查询（供 tree 子命令与 bundle 导出；行含全部列） */
export function treeByVideo(db: Database.Database, videoId: number): CommentTree {
  const roots = db.prepare(`
    SELECT * FROM comments WHERE video_id = ? AND is_root = 1
    ORDER BY like_count DESC, ctime_s ASC, id ASC
  `).all(videoId) as CommentRecord[];
  const floorRows = db.prepare(`
    SELECT * FROM comments WHERE video_id = ? AND is_root = 0
    ORDER BY ctime_s ASC, id ASC
  `).all(videoId) as CommentRecord[];
  const floorsByRoot = new Map<string, CommentRecord[]>();
  for (const f of floorRows) {
    const list = floorsByRoot.get(f.root_rpid);
    if (list) list.push(f);
    else floorsByRoot.set(f.root_rpid, [f]);
  }
  return { roots, floorsByRoot };
}

// ── 轻量树查询（GET /api/comments/list 底层，2026-10-08 popup 评论卡）──

/**
 * GET /api/comments/list 行形态：popup 展示/树还原白名单子集（snake_case 对齐列名）。
 * 不透出 member/content 大列（防体量防泄漏，对齐 http/danmaku.ts lightDanmaku 白名单口径）；
 * has_picture 由 content JSON $.pictures 派生（0/1），popup 仅作 [图] 标注、不渲染图本体。
 */
export interface CommentLightRow {
  rpid_str: string;
  is_root: number;
  uname: string | null;
  like_count: number;
  ctime_s: number | null;
  message: string | null;
  parent_reply_name: string | null;
  ip_location: string | null;
  pin_kind: string | null;
  state: number;
  folded: number;
  up_like: number;
  up_reply: number;
  is_up: number;
  /** content JSON $.pictures 非空数组 → 1（带图评论；verify countWithPictures 同口径，SQL 侧算） */
  has_picture: number;
  root_rpid: string;
  parent_rpid: string;
  dialog_rpid: string;
}

export interface CommentLightTree {
  /** 根评论（like_count 降序，tie 同 treeByVideo；limit 已截） */
  roots: CommentLightRow[];
  /** 楼中楼按根分组（组内 ctime_s 升序）；孤儿楼（根已删）无挂载点，消费方 flatten 时自然不进列表 */
  floorsByRoot: Map<string, CommentLightRow[]>;
}

/** 白名单列清单（两查询共用；has_picture 在库内派生，不拉 content 本体出网）。
 *  json_type='array' 防非数组值；嵌套 CASE 防 content 坏 JSON（json_valid 先行短路，json_* 遇坏串会 throw）。 */
const LIGHT_COLS = `
  rpid_str, is_root, uname, like_count, ctime_s, message, parent_reply_name, ip_location,
  pin_kind, state, folded, up_like, up_reply, is_up, root_rpid, parent_rpid, dialog_rpid,
  CASE WHEN json_valid(content)
       THEN CASE WHEN json_type(content, '$.pictures') = 'array'
                 THEN json_array_length(content, '$.pictures') ELSE 0 END
       ELSE 0 END AS has_picture
`;

/**
 * treeByVideo 的轻量白名单版（popup 评论卡 list 端点底层，2026-10-08）：排序口径与 treeByVideo
 * 完全同（根 like_count DESC/ctime_s ASC/id ASC，楼 ctime_s ASC/id ASC=导出 md 同序）；
 * limit>0 只截根数、楼中楼随其根带出（IN 子查询定位，单查询防 N+1），limit=0 全部（shapeTree 口径）；
 * 置顶前置分区由 http 层做（对齐 handleTree）。不拉 member/content 大列——88978 条级巨量视频下
 * SELECT * 全量行出库的内存/体量不可控，白名单显式列清单防回归。
 */
export function commentsLightTree(db: Database.Database, videoId: number, limit: number): CommentLightTree {
  const rootOrder = 'ORDER BY like_count DESC, ctime_s ASC, id ASC';
  const roots = (limit > 0
    ? db.prepare(`SELECT ${LIGHT_COLS} FROM comments WHERE video_id = ? AND is_root = 1 ${rootOrder} LIMIT ?`)
        .all(videoId, limit)
    : db.prepare(`SELECT ${LIGHT_COLS} FROM comments WHERE video_id = ? AND is_root = 1 ${rootOrder}`)
        .all(videoId)
  ) as CommentLightRow[];
  const floorRows = (limit > 0
    ? db.prepare(`
        SELECT ${LIGHT_COLS} FROM comments WHERE video_id = ? AND is_root = 0
          AND root_rpid IN (SELECT rpid_str FROM comments WHERE video_id = ? AND is_root = 1 ${rootOrder} LIMIT ?)
        ORDER BY ctime_s ASC, id ASC
      `).all(videoId, videoId, limit)
    : db.prepare(`
        SELECT ${LIGHT_COLS} FROM comments WHERE video_id = ? AND is_root = 0
        ORDER BY ctime_s ASC, id ASC
      `).all(videoId)
  ) as CommentLightRow[];
  const floorsByRoot = new Map<string, CommentLightRow[]>();
  for (const f of floorRows) {
    const list = floorsByRoot.get(f.root_rpid);
    if (list) list.push(f);
    else floorsByRoot.set(f.root_rpid, [f]);
  }
  return { roots, floorsByRoot };
}
