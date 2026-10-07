// export bundle 评论导出（C6，PLAN docs/plans/comments/PLAN.md §6）：
// manifest comments 摘要批量查询（IN + GROUP BY 防 N+1，§6.2）+ comments/<BV号>.md 正文渲染（§6.3）。
// 从 bundle.ts 拆出独立模块（模块 ≤400 行纪律，对齐 analyze-template 先例）；评论树查询复用
// db/comments.ts 的 treeByVideo（C1 产物，注释明示「供 tree 子命令与 bundle 导出」）。
// coverage 口径（§6.2「与 verify 端点一致」）：bundle 批量场景无实时 page.count，用库内根行
// rcount 快照当分母（verify 的 fallback 来源同款）；分母 ≤0 的根不计入分子分母、空分母按 1=无缺失
// （对齐 comments-verify.ts coverageOfRoots 的 rcount fallback 路径）。

import type Database from 'better-sqlite3';
import type { CommentRecord, CommentTree } from '../db/comments.js';

// ── manifest 摘要（§6.2）──

/** manifest video 条目的 comments 摘要统计（file 由组装方按 comments/<source_vid>.md 补齐） */
export interface BundleCommentsStats {
  roots: number;             // 根评论数（含置顶）
  total: number;             // 总条数（根+楼中楼）
  coverage: number;          // 楼中楼覆盖率 0-1（rcount 快照口径，§6.2）
  like_top: number;          // 最高赞数
  last_collected_at: number; // MAX(last_seen_at) 毫秒
}

export interface BundleCommentsMeta extends BundleCommentsStats {
  file: string;              // 「comments/<BV号>.md」相对 bundle 根
}

/**
 * 批量取全视频评论统计（§6.2 实现要点）：stats 与 coverage 各一条聚合查询算全量视频（防 N+1，
 * 对齐 videoExtrasByVideoIds 先例）。库内 0 评论的视频不在返回 Map——组装方以 'comments' in v
 * 判别省略字段；coverage 保留 4 位小数（0.9867），无行视频/空分母视频按 1（无缺失）。
 */
export function commentsMetaByVideoIds(
  db: Database.Database,
  ids: number[],
): Map<number, BundleCommentsStats> {
  const map = new Map<number, BundleCommentsStats>();
  if (ids.length === 0) return map;
  const ph = ids.map(() => '?').join(',');
  const stats = db.prepare(
    `SELECT video_id,
            COUNT(*) AS total,
            COALESCE(SUM(is_root), 0) AS roots,
            MAX(like_count) AS like_top,
            MAX(last_seen_at) AS last_collected_at
       FROM comments WHERE video_id IN (${ph})
       GROUP BY video_id`,
  ).all(...ids) as Array<{
    video_id: number; total: number; roots: number; like_top: number; last_collected_at: number;
  }>;
  for (const s of stats) {
    map.set(s.video_id, {
      roots: s.roots, total: s.total, like_top: s.like_top,
      last_collected_at: s.last_collected_at, coverage: 1,
    });
  }
  // coverage = Σ min(实采楼数, rcount) / Σ rcount（仅 rcount>0 的根计入）。
  // 两条简单 GROUP BY + JS 聚合（楼层按 root_rpid 计数、根行按自身 rpid_str 对上——根行 root_rpid='0'
  // 不能做 join 键，旧的单条 LEFT JOIN 即败于此）。有 cov 聚合的视频必有 stats 行（rcount>0 的根
  // 本身是评论行）；无 cov 聚合（全根 rcount≤0）保持 1。expected 恒 ≥1（只在 rcount>0 行累加），无除零。
  const floorCnt = new Map<string, number>();
  for (const f of db.prepare(
    `SELECT video_id, root_rpid, COUNT(*) AS cnt
       FROM comments WHERE is_root = 0 AND video_id IN (${ph})
       GROUP BY video_id, root_rpid`,
  ).all(...ids) as Array<{ video_id: number; root_rpid: string; cnt: number }>) {
    floorCnt.set(`${f.video_id}:${f.root_rpid}`, f.cnt);
  }
  const covByVideo = new Map<number, { covered: number; expected: number }>();
  for (const r of db.prepare(
    `SELECT video_id, rpid_str, rcount FROM comments WHERE is_root = 1 AND rcount > 0 AND video_id IN (${ph})`,
  ).all(...ids) as Array<{ video_id: number; rpid_str: string; rcount: number }>) {
    const agg = covByVideo.get(r.video_id) ?? { covered: 0, expected: 0 };
    agg.covered += Math.min(floorCnt.get(`${r.video_id}:${r.rpid_str}`) ?? 0, r.rcount);
    agg.expected += r.rcount;
    covByVideo.set(r.video_id, agg);
  }
  for (const s of stats) {
    const c = covByVideo.get(s.video_id);
    if (c) map.get(s.video_id)!.coverage = Math.round((c.covered / c.expected) * 10000) / 10000;
  }
  return map;
}

// ── comments/<BV号>.md 正文渲染（§6.3）──

const dateFromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dateFromS = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);

/** 覆盖率 → 百分比文案（一位小数：0.987 → "98.7%"，对齐 §6.3 样例） */
const pct = (coverage: number): string => `${(coverage * 100).toFixed(1)}%`;

/** UP 主标注（is_up=1 昵称后 (UP主)，§6.3） */
const upTag = (r: CommentRecord): string => (r.is_up === 1 ? '(UP主)' : '');

/** 平台状态标注（folded=1 → [已折叠]；state=17 → [仅自己可见]；可叠加，带前导空格） */
function stateTags(r: CommentRecord): string {
  const tags: string[] = [];
  if (r.folded === 1) tags.push('[已折叠]');
  if (r.state === 17) tags.push('[仅自己可见]');
  return tags.length > 0 ? ` ${tags.join(' ')}` : '';
}

/** 「回复 @dialog 行 uname」前缀（§2.4 对话还原规则）：直回根（dialog==自身，B 站免渲染「回复 @根作者」）
 *  与 dialog='0' 省略前缀；指向行在库→用其 uname；悬空/无名→本行 parent_reply_name 兜底
 *  （被回复者昵称快照，B 站楼内互复 dialog==parent，快照即 dialog 对象名；两者皆缺省略，§2.4 边界）。 */
function replyPrefix(f: CommentRecord, byRpid: Map<string, CommentRecord>): string {
  if (f.dialog_rpid === f.rpid_str || f.dialog_rpid === '0') return '';
  const d = byRpid.get(f.dialog_rpid);
  if (d?.uname) return ` 回复 @${d.uname}`;
  return f.parent_reply_name ? ` 回复 @${f.parent_reply_name}` : '';
}

/** 根评论组标题行：`## 【赞 N】@uname(UP主) · IP属地:X · YYYY-MM-DD · UP主已回复/UP觉得很赞`
 *  （可有的标注才带；状态标注缀行尾）。 */
function rootHeader(r: CommentRecord): string {
  const segs: string[] = [];
  if (r.ip_location) segs.push(`IP属地:${r.ip_location}`);
  if (r.ctime_s != null) segs.push(dateFromS(r.ctime_s));
  if (r.up_reply === 1) segs.push('UP主已回复');
  if (r.up_like === 1) segs.push('UP觉得很赞');
  return `## 【赞 ${r.like_count}】@${r.uname ?? ''}${upTag(r)}`
    + (segs.length > 0 ? ` · ${segs.join(' · ')}` : '')
    + stateTags(r);
}

/**
 * 楼中楼缩进层级（parent 链；根=1，直回根/父悬空=2，回楼内条目逐级 +1）：
 * 父悬空上提挂楼根记 2、环防御收口 2（均对齐 comments-stats.ts depthHistogram 边界）。
 */
function depthOf(
  f: CommentRecord,
  byRpid: Map<string, CommentRecord>,
  memo: Map<string, number>,
  inProgress: Set<string>,
): number {
  const known = memo.get(f.rpid_str);
  if (known !== undefined) return known;
  if (inProgress.has(f.rpid_str)) return 2; // 环防御（不应发生）
  let d = 2;
  const parent = byRpid.get(f.parent_rpid);
  if (f.parent_rpid !== '0' && parent && parent.is_root !== 1) {
    inProgress.add(f.rpid_str);
    d = depthOf(parent, byRpid, memo, inProgress) + 1;
    inProgress.delete(f.rpid_str);
  }
  memo.set(f.rpid_str, d);
  return d;
}

/** 楼中楼缩进前缀（深度缩进;floorLine 与图片行的内容列共以此基准,+2 空格对齐正文续行）。 */
const floorIndent = (depth: number): string => '  '.repeat(Math.max(0, depth - 2));

/** content JSON 的 pictures[] → markdown 图片行(用户拍板 2026-10:图片本体不下载,URL 够了)。
 *  每图一行 `![图N](url)`,N 从 1 连续计(只数渲染出的行);URL img_src 优先、url 兜底
 *  (验收快照实测形态:元素含 img_src/img_width/...,无 url 键,兜底防形态漂移)。
 *  content 缺失/坏 JSON/pictures 非数组/单图两键皆缺 → 不出图片行,不炸导出。缩进随所在楼层内容列。 */
function pictureLines(contentJson: string | null, indent: string): string[] {
  if (!contentJson) return [];
  let pics: unknown;
  try {
    pics = (JSON.parse(contentJson) as { pictures?: unknown }).pictures;
  } catch {
    return []; // 坏 JSON 不应发生(content 由 jsonSnapshot 产出),防御:跳过不出行
  }
  if (!Array.isArray(pics)) return [];
  const out: string[] = [];
  for (const p of pics) {
    if (p == null || typeof p !== 'object') continue;
    const pic = p as { img_src?: unknown; url?: unknown };
    const url = typeof pic.img_src === 'string' && pic.img_src !== '' ? pic.img_src
      : (typeof pic.url === 'string' && pic.url !== '' ? pic.url : null);
    if (url) out.push(`${indent}![图${out.length + 1}](${url})`);
  }
  return out;
}

/** 楼中楼行：`- 【赞 N】@uname(UP主)[回复 @X][ · IP属地:Y]:内容[状态标注]`；多行 message 续行按内容列缩进成块。 */
function floorLine(f: CommentRecord, depth: number, byRpid: Map<string, CommentRecord>): string {
  const indent = floorIndent(depth);
  const ip = f.ip_location ? ` · IP属地:${f.ip_location}` : '';
  const msg = (f.message ?? '').replace(/\n/g, `\n${indent}  `);
  return `${indent}- 【赞 ${f.like_count}】@${f.uname ?? ''}${upTag(f)}${replyPrefix(f, byRpid)}${ip}:${msg}`
    + stateTags(f);
}

/** 孤儿楼层收集：根行整体不在库（含确认缺失根——行仍在库但组已不渲染）的楼中楼，归虚拟分组平铺。 */
function orphanFloorsOf(
  tree: CommentTree,
  rootByRpid: Map<string, CommentRecord>,
  confirmedMissing: (r: CommentRecord) => boolean,
): CommentRecord[] {
  const out: CommentRecord[] = [];
  for (const [rootRpid, floors] of tree.floorsByRoot) {
    const rootRow = rootByRpid.get(rootRpid);
    if (!rootRow || confirmedMissing(rootRow)) out.push(...floors);
  }
  return out;
}

/** 孤儿楼层行：父悬空（parent_rpid 非 0 且不在库）缀「(父评论已删除)」标注（§6.3 样例）。 */
function orphanFloorLine(f: CommentRecord, byRpid: Map<string, CommentRecord>): string {
  const dangling = f.parent_rpid !== '0' && !byRpid.has(f.parent_rpid);
  return floorLine(f, 2, byRpid) + (dangling ? '(父评论已删除)' : '');
}

/**
 * 渲染单视频评论区正文（§6.3 格式；纯函数，树序由 treeByVideo 保证：根赞降序、组内 ctime 升序）。
 * - 根分组：确认缺失根（missing_since 非空且 last_seen_at < missing_since，两轮完整轮均缺席）不出现；
 * - 其健在楼层与根行整体不在库的孤儿楼层，平铺归「## 根已删除的楼层(N 条)」虚拟分组，
 *   父悬空条目缀「(父评论已删除)」；
 * - 缩进 ≤3 层，更深拍平到第 3 层并保留「回复 @」前缀（前缀规则见 replyPrefix）。
 * - 正文块（根/楼）后附 content.pictures 的 markdown 图片行 `![图N](url)`（pictureLines;
 *   用户拍板图片本体不下载,URL 够了）；「回复 @」悬空兜底用 parent_reply_name 快照（replyPrefix）。
 */
export function renderCommentsMd(
  video: { title: string; source_vid: string },
  stats: BundleCommentsStats,
  tree: CommentTree,
): string {
  const byRpid = new Map<string, CommentRecord>();
  for (const r of tree.roots) byRpid.set(r.rpid_str, r);
  for (const floors of tree.floorsByRoot.values()) {
    for (const f of floors) byRpid.set(f.rpid_str, f);
  }
  const rootByRpid = new Map(tree.roots.map((r) => [r.rpid_str, r]));
  const memo = new Map<string, number>();
  const inProgress = new Set<string>();
  const confirmedMissing = (r: CommentRecord): boolean =>
    r.missing_since != null && r.last_seen_at < r.missing_since;

  const lines: string[] = [
    `# 评论区 · ${video.title}`,
    `> ${video.source_vid} · 采集 ${dateFromMs(stats.last_collected_at)}`
      + ` · 共 ${stats.total} 条(根 ${stats.roots} / 楼中楼 ${stats.total - stats.roots}`
      + `,覆盖率 ${pct(stats.coverage)},最高赞 ${stats.like_top})`,
    '> 根评论按点赞降序;楼中楼组内按时间。`[已折叠]` `[仅自己可见]` 为平台状态标注。',
    '',
  ];

  for (const root of tree.roots) {
    if (confirmedMissing(root)) continue;
    lines.push(rootHeader(root));
    const pics = pictureLines(root.content, ''); // 根正文后逐图一行(§6.3 图片行扩展)
    if (root.message) lines.push(root.message);  // 根正文原样（多行原样保留）
    lines.push(...pics);
    if (root.message || pics.length > 0) lines.push(''); // 正文块与楼层之间的空行分隔(有正文块才出)
    for (const f of tree.floorsByRoot.get(root.rpid_str) ?? []) {
      const depth = Math.min(depthOf(f, byRpid, memo, inProgress), 3); // ≤3 层，更深拍平
      lines.push(floorLine(f, depth, byRpid));
      lines.push(...pictureLines(f.content, `${floorIndent(depth)}  `)); // 楼层图片行缩进到内容列
    }
    lines.push('');
  }

  const orphans = orphanFloorsOf(tree, rootByRpid, confirmedMissing);
  if (orphans.length > 0) {
    lines.push(`## 根已删除的楼层(${orphans.length} 条)`);
    for (const f of orphans) {
      lines.push(orphanFloorLine(f, byRpid));
      lines.push(...pictureLines(f.content, '  ')); // 孤儿平铺恒 2 层 → 内容列 2 空格
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
