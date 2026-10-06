// bundle-comments.ts 单测（C6 评论导出，PLAN docs/plans/comments/PLAN.md §6）：
// commentsMetaByVideoIds 批量统计（多视频混合不串扰 / 0 评论视频不入 Map / coverage rcount 快照口径）+
// renderCommentsMd 正文渲染（头部三行 / 根组标题各段可有才带 / 缩进链 / >3 层拍平 / 状态标注 /
// 多行 message / 孤儿虚拟分组 / missing 确认根 / 环防御）+ buildBundle 集成（manifest comments 字段与
// comments/<BV>.md 文件）+ ANALYZE.md 盲区第四类与评论区共识信号段。
// 夹具：渲染测试用手工 CommentTree（纯函数不触库）；db 测试用 :memory: + migrate，行手插。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 批量统计/coverage 口径/md 渲染全形态/buildBundle 集成/模板增补 | 通过 | 2026-10-04 C6 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, runMigrations } from '../db/migrate.js';
import type { CommentRecord, CommentTree } from '../db/comments.js';
import { commentsMetaByVideoIds, renderCommentsMd } from './bundle-comments.js';
import { buildBundle, ANALYZE_MD } from './bundle.js';

// ── 夹具 ──

/** 2026-10-03 00:00:00 UTC（unix 秒），与 PLAN §6.3 样例采集日同日 */
const CT = 1790985600;

let seq = 0;
/** 构造完整 CommentRecord（缺省为根评论形态：root/parent/dialog='0'、无任何标注） */
function mkRow(over: Partial<CommentRecord> & Pick<CommentRecord, 'rpid_str'>): CommentRecord {
  seq++;
  return {
    id: seq,
    video_id: 1,
    root_rpid: '0', parent_rpid: '0', dialog_rpid: '0', is_root: 1,
    mid_str: '100', uname: '用户A', member: null, message: '正文', content: null,
    like_count: 0, rcount: 0, reply_total: 0, ctime_s: CT,
    ip_location: null, state: 0, invisible: 0, folded: 0,
    up_like: 0, up_reply: 0, is_up: 0, pin_kind: null,
    first_seen_at: 1728000000000, last_seen_at: 1728000000000,
    first_page: null, first_sort: null, batch_id: null, missing_since: null,
    ...over,
  };
}

/** 楼中楼直接回复根（§2.4：root=楼根、parent=楼根、dialog=自身 → 渲染无「回复 @」前缀） */
const floorOf = (rpid: string, root: string, over: Partial<CommentRecord> = {}): CommentRecord =>
  mkRow({ rpid_str: rpid, is_root: 0, root_rpid: root, parent_rpid: root, dialog_rpid: rpid, ...over });

/** 楼中楼回复楼内条目 Y（§2.4：root=楼根、parent=dialog=Y.rpid → 渲染带「回复 @Y.uname」前缀） */
const replyTo = (rpid: string, root: string, target: string, over: Partial<CommentRecord> = {}): CommentRecord =>
  mkRow({ rpid_str: rpid, is_root: 0, root_rpid: root, parent_rpid: target, dialog_rpid: target, ...over });

/** 手工组树：楼层按入参顺序归入各自 root 组（渲染保序，排序职责在 treeByVideo） */
function tree(roots: CommentRecord[], floors: CommentRecord[]): CommentTree {
  const floorsByRoot = new Map<string, CommentRecord[]>();
  for (const f of floors) {
    const list = floorsByRoot.get(f.root_rpid);
    if (list) list.push(f);
    else floorsByRoot.set(f.root_rpid, [f]);
  }
  return { roots, floorsByRoot };
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  return db;
}

function seedVideo(db: Database.Database, sourceVid: string, title = '测试视频'): number {
  return Number(db.prepare(
    "INSERT INTO videos (source, source_vid, title, first_seen_at, updated_at) VALUES ('bilibili', ?, ?, 1, 1)",
  ).run(sourceVid, title).lastInsertRowid);
}

const INSERT_SQL = `
  INSERT INTO comments (rpid_str, video_id, root_rpid, parent_rpid, dialog_rpid, is_root,
    mid_str, uname, message, like_count, rcount, ctime_s, ip_location, state, folded,
    up_like, up_reply, is_up, first_seen_at, last_seen_at, missing_since)
  VALUES (@rpid_str, @video_id, @root_rpid, @parent_rpid, @dialog_rpid, @is_root,
    @mid_str, @uname, @message, @like_count, @rcount, @ctime_s, @ip_location, @state, @folded,
    @up_like, @up_reply, @is_up, @first_seen_at, @last_seen_at, @missing_since)`;

/** 手插评论行（bundle 夹具全列可控，比走 upsert 直观；is_up/missing_since 直接给值） */
function seedComment(db: Database.Database, videoId: number, over: Partial<CommentRecord> & Pick<CommentRecord, 'rpid_str'>): void {
  db.prepare(INSERT_SQL).run({ ...mkRow(over), video_id: videoId });
}

const V = { title: '霸凌の意志', source_vid: 'BV1KmHb6JEFS' };
const STATS = { roots: 2, total: 3, coverage: 0.987, like_top: 917, last_collected_at: 1790985600000 };

// ── commentsMetaByVideoIds：批量统计（§6.2，防 N+1）──

test('批量统计:多视频混合(有评论/无评论)只出有评论视频,各字段不串扰', () => {
  const db = freshDb();
  try {
    const v1 = seedVideo(db, 'BV1');
    seedVideo(db, 'BV2'); // 无评论视频：不得出现在返回 Map
    const v3 = seedVideo(db, 'BV3');
    // V1：2 根 2 楼；最高赞在楼中楼（9）；last_collected_at 取各行 MAX(last_seen_at)
    seedComment(db, v1, { rpid_str: 'rA', like_count: 5, rcount: 2, last_seen_at: 1000 });
    seedComment(db, v1, { rpid_str: 'fA1', is_root: 0, root_rpid: 'rA', parent_rpid: 'rA', dialog_rpid: 'fA1', like_count: 9, last_seen_at: 1500 });
    seedComment(db, v1, { rpid_str: 'fA2', is_root: 0, root_rpid: 'rA', parent_rpid: 'rA', dialog_rpid: 'fA2', like_count: 1, last_seen_at: 1200 });
    seedComment(db, v1, { rpid_str: 'rB', like_count: 3, rcount: 0, last_seen_at: 1300 });
    seedComment(db, v3, { rpid_str: 'rC', like_count: 0, rcount: 0, last_seen_at: 777 });
    const meta = commentsMetaByVideoIds(db, [v1, 99999, v3]); // 99999=不存在 id（无评论形态）
    assert.equal(meta.size, 2, '无评论的 BV2 不得入 Map（0 评论省略字段的前提）');
    assert.deepEqual(meta.get(v1), { roots: 2, total: 4, like_top: 9, last_collected_at: 1500, coverage: 1 });
    // rB rcount=0 → 无有效分母 → coverage 按 1（无缺失，对齐 coverageOfRoots 空分母口径）
    assert.deepEqual(meta.get(v3), { roots: 1, total: 1, like_top: 0, last_collected_at: 777, coverage: 1 });
  } finally { db.close(); }
});

test('批量统计:空 id 列表返回空 Map(IN 子句不组装)', () => {
  const db = freshDb();
  try {
    assert.equal(commentsMetaByVideoIds(db, []).size, 0);
  } finally { db.close(); }
});

test('coverage:rcount 快照口径(Σmin(实采,rcount)/Σrcount),超采 clamp,rcount≤0 整根不计入', () => {
  const db = freshDb();
  try {
    const v = seedVideo(db, 'BVC');
    // rA 分母 3 实采 2 → covered 2；rB 分母 2 实采 3 → clamp covered 2；rC rcount=0 不计入分子分母
    seedComment(db, v, { rpid_str: 'rA', rcount: 3 });
    seedComment(db, v, { rpid_str: 'fA1', is_root: 0, root_rpid: 'rA', parent_rpid: 'rA', dialog_rpid: 'fA1' });
    seedComment(db, v, { rpid_str: 'fA2', is_root: 0, root_rpid: 'rA', parent_rpid: 'rA', dialog_rpid: 'fA2' });
    seedComment(db, v, { rpid_str: 'rB', rcount: 2 });
    for (const f of ['fB1', 'fB2', 'fB3']) {
      seedComment(db, v, { rpid_str: f, is_root: 0, root_rpid: 'rB', parent_rpid: 'rB', dialog_rpid: f });
    }
    seedComment(db, v, { rpid_str: 'rC', rcount: 0 });
    seedComment(db, v, { rpid_str: 'fC1', is_root: 0, root_rpid: 'rC', parent_rpid: 'rC', dialog_rpid: 'fC1' });
    const meta = commentsMetaByVideoIds(db, [v]);
    assert.equal(meta.get(v)!.coverage, 0.8, '(2+2)/(3+2)=0.8，rC 的 1 楼不参与');
  } finally { db.close(); }
});

test('coverage:rcount>0 但 0 实采的根 → covered 记 0(全 NULL SUM 走 COALESCE)', () => {
  const db = freshDb();
  try {
    const v = seedVideo(db, 'BVD');
    seedComment(db, v, { rpid_str: 'rD', rcount: 4 }); // 有楼分母但一楼未采
    const meta = commentsMetaByVideoIds(db, [v]);
    assert.equal(meta.get(v)!.coverage, 0);
  } finally { db.close(); }
});

// ── renderCommentsMd：头部（§6.3 样例逐字节对齐）──

test('md 头部三行:标题/引用元信息(采集日·总数·根楼拆分·覆盖率百分比·最高赞)/说明行,末尾换行', () => {
  const md = renderCommentsMd(V, STATS, tree([], []));
  const lines = md.split('\n');
  assert.equal(lines[0], '# 评论区 · 霸凌の意志');
  assert.equal(lines[1], '> BV1KmHb6JEFS · 采集 2026-10-03 · 共 3 条(根 2 / 楼中楼 1,覆盖率 98.7%,最高赞 917)');
  assert.equal(lines[2], '> 根评论按点赞降序;楼中楼组内按时间。`[已折叠]` `[仅自己可见]` 为平台状态标注。');
  assert.equal(lines[3], '');
  assert.ok(md.endsWith('\n'), '文件以单个换行收尾');
});

// ── renderCommentsMd：根组标题行（可有的标注才带）──

test('根组标题:IP属地/日期/UP主已回复/UP觉得很赞/(UP主) 各段可有才带;缺 uname 兜底空;无正文无楼层不出空行块', () => {
  const r1 = mkRow({ rpid_str: 'r1', uname: '用户A', like_count: 917, ip_location: '上海', up_reply: 1 });
  const r2 = mkRow({ rpid_str: 'r2', uname: '用户E', like_count: 585, is_up: 1, up_like: 1, ctime_s: null, message: null });
  const r3 = mkRow({ rpid_str: 'r3', uname: null, like_count: 100, ctime_s: null, message: '' }); // 全裸根：无任何可选段
  const md = renderCommentsMd(V, STATS, tree([r1, r2, r3], []));
  const lines = md.split('\n');
  assert.equal(lines[4], '## 【赞 917】@用户A · IP属地:上海 · 2026-10-03 · UP主已回复');
  assert.equal(lines[5], '正文');
  assert.equal(lines[8], '## 【赞 585】@用户E(UP主) · UP觉得很赞', 'is_up 昵称后 (UP主)；缺 IP/日期时段直接消失');
  assert.equal(lines[10], '## 【赞 100】@', 'uname null 兜底空串，无任何可选段时不带 · 分隔');
});

test('根组标题:状态标注缀行尾且可叠加(folded=1 → [已折叠];state=17 → [仅自己可见])', () => {
  const r = mkRow({ rpid_str: 'rs', like_count: 7, folded: 1, state: 17, up_reply: 1, up_like: 1, ip_location: '北京' });
  const fs = floorOf('fs', 'rs', { folded: 1, state: 17, message: '藏' });
  const fu = floorOf('fu', 'rs', { is_up: 1, message: 'UP发言' });
  const lines = renderCommentsMd(V, STATS, tree([r], [fs, fu])).split('\n');
  assert.equal(lines[4], '## 【赞 7】@用户A · IP属地:北京 · 2026-10-03 · UP主已回复 · UP觉得很赞 [已折叠] [仅自己可见]');
  assert.equal(lines[7], '- 【赞 0】@用户A:藏 [已折叠] [仅自己可见]', '楼层状态标注缀内容后');
  assert.equal(lines[8], '- 【赞 0】@用户A(UP主):UP发言');
});

// ── renderCommentsMd：楼中楼缩进链与「回复 @」前缀（§2.4 对话还原）──

test('缩进链:直回根 2 层(- )无前缀,回楼内条目 3 层(  - )带「回复 @」;dialog=0 异常形态同样省前缀', () => {
  const rootA = mkRow({ rpid_str: 'A', uname: '楼主A', like_count: 100, message: '楼根' });
  const f1 = floorOf('f1', 'A', { uname: '用户B', like_count: 19, ip_location: '广东', message: '回复内容' });
  const f2 = replyTo('f2', 'A', 'f1', { uname: '用户C', like_count: 5, message: '……' });
  const f3 = floorOf('f3', 'A', { uname: '用户D', like_count: 4, dialog_rpid: '0', message: '异常零dialog' });
  const lines = renderCommentsMd(V, STATS, tree([rootA], [f1, f2, f3])).split('\n');
  assert.equal(lines[7], '- 【赞 19】@用户B · IP属地:广东:回复内容', '直回根（dialog==自身）无「回复 @」，IP 可有才带');
  assert.equal(lines[8], '  - 【赞 5】@用户C 回复 @用户B:……');
  assert.equal(lines[9], '- 【赞 4】@用户D:异常零dialog', "dialog='0'（R0 脏行形态）省前缀");
});

test('缩进>3 层拍平到第 3 层,保留「回复 @」;dialog 悬空省略前缀(§2.4 边界)', () => {
  const rootA = mkRow({ rpid_str: 'A', like_count: 1 });
  const d1 = floorOf('d1', 'A', { uname: '用户甲' });
  const d2 = replyTo('d2', 'A', 'd1', { uname: '用户乙' });
  const d3 = replyTo('d3', 'A', 'd2', { uname: '用户丙' }); // parent 链深度 4 → 拍平
  const d4 = replyTo('d4', 'A', 'd3', { uname: '用户丁', dialog_rpid: 'ghost' }); // 深度 5 且 dialog 悬空
  const lines = renderCommentsMd(V, STATS, tree([rootA], [d1, d2, d3, d4])).split('\n');
  assert.equal(lines[7], '- 【赞 0】@用户甲:正文');
  assert.equal(lines[8], '  - 【赞 0】@用户乙 回复 @用户甲:正文');
  assert.equal(lines[9], '  - 【赞 0】@用户丙 回复 @用户乙:正文', '深度 4 拍平到第 3 层缩进，前缀保留');
  assert.equal(lines[10], '  - 【赞 0】@用户丁:正文', '深度 5 拍平 + dialog 悬空 → 前缀整个省略');
});

test('parent 链成环按深度收口不挂死;parent=0 楼行/父悬空上提 2 层;dialog 悬空/无名均省前缀', () => {
  const rootA = mkRow({ rpid_str: 'A', like_count: 1 });
  const c1 = mkRow({ rpid_str: 'c1', is_root: 0, root_rpid: 'A', parent_rpid: 'c2', dialog_rpid: 'c2', uname: '环一' });
  const c2 = mkRow({ rpid_str: 'c2', is_root: 0, root_rpid: 'A', parent_rpid: 'c1', dialog_rpid: 'c1', uname: '环二' });
  const p0 = mkRow({ rpid_str: 'p0', is_root: 0, root_rpid: 'A', parent_rpid: '0', dialog_rpid: 'p0', uname: '脏行' }); // R0 脏行形态
  const ghost = floorOf('ghost', 'A', { uname: '悬dialog', dialog_rpid: 'nope' }); // dialog 指向不在库条目
  const t0 = floorOf('t0', 'A', { uname: null }); // dialog 目标在库但无名
  const g0 = replyTo('g0', 'A', 't0', { uname: '回无名' });
  const dang = mkRow({ rpid_str: 'dang', is_root: 0, root_rpid: 'A', parent_rpid: 'vanished', dialog_rpid: 'dang', uname: '孤子' }); // 父悬空
  const lines = renderCommentsMd(V, STATS, tree([rootA], [c1, c2, p0, ghost, t0, g0, dang])).split('\n');
  assert.ok(lines.includes('  - 【赞 0】@环一 回复 @环二:正文'), '环成员按收口深度渲染，不无限递归');
  assert.ok(lines.includes('- 【赞 0】@脏行:正文'), "parent='0' 楼行按 2 层（根下）渲染");
  assert.ok(lines.includes('- 【赞 0】@悬dialog:正文'), 'dialog 悬空省「回复 @」前缀（§2.4 边界）');
  assert.ok(lines.includes('- 【赞 0】@:正文'), 'uname null 兜底空串');
  assert.ok(lines.includes('  - 【赞 0】@回无名:正文'), 'dialog 行在库但无名 → 3 层深度保留、前缀省略');
  assert.ok(lines.includes('- 【赞 0】@孤子:正文'), '父悬空上提挂楼根（2 层）');
});

// ── renderCommentsMd：多行 message / 孤儿虚拟分组 / missing 确认根 ──

test('多行 message:根正文原样换行;楼中楼续行按内容列缩进保持块结构', () => {
  const rm = mkRow({ rpid_str: 'rm', like_count: 9, message: '第一行\n第二行' });
  const fm = floorOf('fm', 'rm', { uname: '用户M', message: '一\n二' });
  const fm3 = replyTo('fm3', 'rm', 'fm', { uname: '用户N', message: '三\n四' });
  const md = renderCommentsMd(V, STATS, tree([rm], [fm, fm3]));
  const lines = md.split('\n');
  assert.equal(lines[5], '第一行');
  assert.equal(lines[6], '第二行', '根正文多行原样（不加缩进）');
  assert.equal(lines[8], '- 【赞 0】@用户M:一');
  assert.equal(lines[9], '  二', '2 层楼续行缩进到内容列（2 空格）');
  assert.equal(lines[10], '  - 【赞 0】@用户N 回复 @用户M:三');
  assert.equal(lines[11], '    四', '3 层楼续行缩进 4 空格');
});

test('孤儿楼层:根行不在库 → 归「根已删除的楼层」虚拟分组平铺,父悬空条目缀(父评论已删除)', () => {
  const o1 = floorOf('o1', 'X', { uname: '用户F', like_count: 1, message: '楼层一' }); // parent=X 不在库 → 悬空
  const o2 = replyTo('o2', 'X', 'o1', { uname: '用户G', like_count: 2, message: '楼层二' }); // parent 在库 → 无标注
  const md = renderCommentsMd(V, STATS, tree([], [o1, o2]));
  const lines = md.split('\n');
  assert.equal(lines[4], '## 根已删除的楼层(2 条)');
  assert.equal(lines[5], '- 【赞 1】@用户F:楼层一(父评论已删除)');
  assert.equal(lines[6], '- 【赞 2】@用户G 回复 @用户F:楼层二');
});

test('missing 确认根(last_seen<missing_since)不出根组,其楼层归虚拟分组;仅候选根照常出组', () => {
  const mroot = mkRow({ rpid_str: 'M', like_count: 50, missing_since: 2000, last_seen_at: 1000 }); // 两轮确认缺失
  const nroot = mkRow({ rpid_str: 'N', like_count: 60, message: '健在根' });
  const cand = mkRow({ rpid_str: 'C', like_count: 40, missing_since: 500, last_seen_at: 900 }); // 候选（近轮仍在）
  const m1 = floorOf('m1', 'M', { message: '孤楼' }); // parent=M 行在库（未物理删除）→ 不缀悬空标注
  const lines = renderCommentsMd(V, STATS, tree([mroot, nroot, cand], [m1])).split('\n');
  assert.ok(!lines.some((l) => l.startsWith('## 【赞 50】')), '确认缺失根不出现组标题');
  assert.ok(lines.includes('## 【赞 60】@用户A · 2026-10-03'), '健在根正常出组');
  assert.ok(lines.includes('## 【赞 40】@用户A · 2026-10-03'), '候选根（尚未两轮确认）照常出组');
  assert.ok(lines.includes('## 根已删除的楼层(1 条)'), '确认根的健在楼层归虚拟分组');
  assert.ok(lines.includes('- 【赞 0】@用户A:孤楼'), '虚拟分组内平铺渲染');
});

// ── buildBundle 集成：manifest comments 字段 + comments/<BV>.md 文件 ──

test('buildBundle:有评论视频出 comments/<BV>.md + manifest comments 摘要;0 评论视频省略字段不出文件', () => {
  const db = freshDb();
  try {
    const v1 = seedVideo(db, 'BV1', '标题A');
    seedVideo(db, 'BV2', '标题B');
    seedComment(db, v1, { rpid_str: 'rBig', uname: '高赞', like_count: 100, rcount: 3, ctime_s: CT, last_seen_at: 1790985600000, message: '根一' });
    seedComment(db, v1, { rpid_str: 'rSmall', uname: '低赞', like_count: 5, rcount: 0, ctime_s: CT + 100, last_seen_at: 1790000000000, message: '根二' });
    // 楼中楼故意乱序入库（ctime 晚的先插）——treeByVideo 组内 ctime 升序应纠正
    seedComment(db, v1, { rpid_str: 'fLate', is_root: 0, root_rpid: 'rBig', parent_rpid: 'rBig', dialog_rpid: 'fLate', uname: '晚的', ctime_s: 2000, message: '晚回复' });
    seedComment(db, v1, { rpid_str: 'fEarly', is_root: 0, root_rpid: 'rBig', parent_rpid: 'rBig', dialog_rpid: 'fEarly', uname: '早的', ctime_s: 1000, message: '早回复' });
    const r = buildBundle(db, { filters: {}, limit: 10, now: 0 });
    const bv1 = r.manifest.videos.find((x) => x.source_vid === 'BV1')!;
    const bv2 = r.manifest.videos.find((x) => x.source_vid === 'BV2')!;
    assert.equal('comments' in bv2, false, '0 评论视频省略 comments 字段（view 哲学）');
    const cm = bv1.comments!;
    assert.equal(cm.file, 'comments/BV1.md');
    assert.equal(cm.roots, 2);
    assert.equal(cm.total, 4);
    assert.equal(cm.like_top, 100);
    assert.equal(cm.last_collected_at, 1790985600000);
    assert.equal(cm.coverage, 0.6667, 'rcount 快照口径：min(2,3)/3 保留 4 位小数');
    const md = r.files.find((f) => f.path === 'comments/BV1.md')!.content;
    assert.ok(md.startsWith('# 评论区 · 标题A\n'));
    assert.ok(md.indexOf('【赞 100】@高赞') < md.indexOf('【赞 5】@低赞'), '根按赞降序（高赞组在前）');
    assert.ok(md.indexOf('@早的:早回复') < md.indexOf('@晚的:晚回复'), '组内按 ctime 升序（与入库顺序无关）');
    assert.ok(!md.includes('根已删除'), '无孤儿不出虚拟分组');
    // manifest.json 序列化含 comments 字段
    const manifestFile = JSON.parse(r.files.find((f) => f.path === 'manifest.json')!.content);
    assert.equal(manifestFile.videos.find((x: { source_vid: string }) => x.source_vid === 'BV1').comments.file, 'comments/BV1.md');
  } finally { db.close(); }
});

// ── ANALYZE.md 模板增补（§6.4）──

test('ANALYZE_MD:盲区第四类「评论区盲区」+ 评论区共识信号可选段 + 评论出处格式', () => {
  for (const anchor of ['覆盖盲区四类', '评论区盲区', 'coverage < 1', 'comments verify',
    '评论区共识信号', '粉丝向/情绪向', '评论区 @', 'comments/<BV号>.md']) {
    assert.ok(ANALYZE_MD.includes(anchor), `ANALYZE_MD 缺 C6 增补锚点: ${anchor}`);
  }
  // 观点汇总模板内含评论区共识信号段与出处格式示例（单一事实源在模板正文）
  assert.ok(ANALYZE_MD.includes('> 来源: 视频A 评论区 @用户A'), '缺评论出处格式示例行');
});
