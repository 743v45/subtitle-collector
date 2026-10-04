// 评论树形组装（shapeTree）：db 层 treeByVideo 输出 → 带派生列（楼层深度/「回复 @」指向/
// 回复对象已删除）的组装树。消费方两处：cli/commands/comments.ts renderTree（§6.3 缩进文本，
// 字节锁定测试在 comments.test.ts）与 http/queries.ts（web 评论子路由 JSON，P2-5）——
// cli 与 http 都可 import db（depcruise 禁反向），共享逻辑按任务口径下沉本模块。
// 语义逐条对齐 CLI tree 渲染：
// - depth：parent 链逐层上溯，父为根/缺失即停，≤3 拍平（更深保留「回复 @」前缀，§6.3）
// - reply_to：dialog≠'0' 且 ≠自身 且作者在树 → 作者名，否则 null（渲染省略「回复 @」，§2.4）
// - parent_missing：parent_rpid≠'0' 且 ≠dialog_rpid（纯字段比较，不查存在性——「回复对象已
//   删除」标注，与 CLI floorLine 判定一致）
// - 孤儿组：root_rpid 组的根不在树内（根已删，§3.4 不丢弃）→ 全组收 orphans，depth 恒 1、
//   reply_to 恒 null（同 CLI floorLine(f,1,null)）；被截根组不算孤儿（根在树内）
// - limit：>0 只截根数（0/缺省=全部）；counts 恒全树口径；truncated=发生截根
import type { CommentRecord, CommentTree } from './comments.js';

/** 楼中楼节点：评论行 + 组装派生列（depth/reply_to/parent_missing）。 */
export interface CommentFloorNode extends CommentRecord {
  depth: number;            // 楼层深度（parent 链 ≤3 拍平）
  reply_to: string | null;  // 「回复 @」指向作者名（dialog 定位；'0'/自身/悬空 → null）
  parent_missing: boolean;  // 回复对象已删除（parent≠'0' 且 ≠dialog，纯字段比较）
}

/** 根评论节点：评论行 + 所组楼中楼（组内 ctime 升序由 treeByVideo 保证）。 */
export interface CommentRootNode extends CommentRecord {
  floors: CommentFloorNode[];
}

/** 组装结果：roots=展示根组（limit 已截）、orphans=根已删的楼层组、counts=全树口径。 */
export interface ShapedTree {
  roots: CommentRootNode[];
  orphans: CommentFloorNode[];
  counts: { rows: number; roots: number; floors: number };
  truncated: boolean;
}

/** 楼层深度（parent 链，≤3 层，更深拍平；guard 防环；自 CLI floorDepth 原样搬迁）。 */
function floorDepth(f: CommentRecord, byRpid: Map<string, CommentRecord>): number {
  let depth = 1;
  let cur: CommentRecord | undefined = f;
  const guard = new Set<string>();
  while (cur && cur.parent_rpid !== '0' && !guard.has(cur.parent_rpid)) {
    guard.add(cur.parent_rpid);
    const p = byRpid.get(cur.parent_rpid);
    if (!p || p.is_root === 1) break;
    depth++;
    cur = p;
  }
  return Math.min(depth, 3);
}

/** rpid → 记录索引（根 + 全部楼中楼；floorDepth/replyToOf 查询用）。 */
function indexByRpid(tree: CommentTree): Map<string, CommentRecord> {
  const byRpid = new Map<string, CommentRecord>();
  for (const r of tree.roots) byRpid.set(r.rpid_str, r);
  for (const list of tree.floorsByRoot.values()) for (const f of list) byRpid.set(f.rpid_str, f);
  return byRpid;
}

/** 「回复 @」对话指向作者名（dialog 定位；'0'/自身/悬空 → null；自 CLI dialogAuthorOf 搬迁）。 */
function replyToOf(f: CommentRecord, byRpid: Map<string, CommentRecord>): string | null {
  if (f.dialog_rpid === '0' || f.dialog_rpid === f.rpid_str) return null;
  return byRpid.get(f.dialog_rpid)?.uname ?? null;
}

/** 回复对象是否已删（parent≠'0' 且 ≠dialog；纯字段比较，同 CLI floorLine 判定）。 */
function parentMissingOf(f: CommentRecord): boolean {
  return f.parent_rpid !== '0' && f.parent_rpid !== f.dialog_rpid;
}

function shapeFloor(f: CommentRecord, byRpid: Map<string, CommentRecord>): CommentFloorNode {
  return { ...f, depth: floorDepth(f, byRpid), reply_to: replyToOf(f, byRpid), parent_missing: parentMissingOf(f) };
}

/**
 * db 树（treeByVideo 输出）→ 组装树。limit>0 只截根数（0/缺省=全部）；counts 恒全树口径；
 * truncated=发生截根。roots/orphans 节点携带派生列，消费方免再组 byRpid 索引。
 */
export function shapeTree(tree: CommentTree, opts: { limit?: number } = {}): ShapedTree {
  const limit = opts.limit ?? 0;
  const byRpid = indexByRpid(tree);
  const floors = [...tree.floorsByRoot.values()].reduce((a, l) => a + l.length, 0);
  const shown = limit > 0 ? tree.roots.slice(0, limit) : tree.roots;
  const shownRootIds = new Set(shown.map((r) => r.rpid_str));
  const roots = shown.map((r) => ({
    ...r,
    floors: (tree.floorsByRoot.get(r.rpid_str) ?? []).map((f) => shapeFloor(f, byRpid)),
  }));
  const orphanGroups = [...tree.floorsByRoot.entries()].filter(([rid]) => !shownRootIds.has(rid) && !byRpid.has(rid));
  const orphans = orphanGroups
    .flatMap(([, l]) => l)
    .map((f) => ({ ...f, depth: 1, reply_to: null, parent_missing: parentMissingOf(f) }));
  return {
    roots,
    orphans,
    counts: { rows: tree.roots.length + floors, roots: tree.roots.length, floors },
    truncated: limit > 0 && tree.roots.length > limit,
  };
}
