// db/comments-tree.ts 树形组装（shapeTree）单测：楼层深度拍平、「回复 @」指向、
// 回复对象已删除、孤儿楼层组、limit 截根、counts 全树口径。
// 消费方两处：http/queries.ts（web 评论子路由 JSON）与 cli/commands/comments.ts
// renderTree（§6.3 缩进文本，字节锁定测试在 comments.test.ts——shapeTree 语义改动会先红在那边）。
// 跑法：cd apps/collector-server && node --test --import tsx src/db/comments-tree.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 全要素组装 / 四层链拍平 / limit 截根 / 空树（4 组） | 通过 | 夹具与 cli renderTree 字节锁定测试同源（2026-10-05） |
// | R2 | reply_to 悬空兜底（悬空+parent_reply_name 快照 → 快照；在库优先/皆无/自身·0 恒 null 维持） | 通过 | 2026-10-07 媒体信息轻量增强，语义对齐 bundle-comments.ts replyPrefix |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeTree } from './comments-tree.js';
import type { CommentRecord, CommentTree } from './comments.js';

// CommentRecord 全列构造器（缺省值与 cli comments.test.ts rec() 同源）
function rec(o: Partial<CommentRecord> & { rpid_str: string }): CommentRecord {
  return {
    id: 0, video_id: 1, root_rpid: '0', parent_rpid: '0', dialog_rpid: '0', is_root: 1,
    mid_str: null, uname: null, parent_reply_name: null, member: null, message: null, content: null, like_count: 0,
    rcount: 0, reply_total: 0, ctime_s: null, ip_location: null, state: 0, invisible: 0,
    folded: 0, up_like: 0, up_reply: 0, is_up: 0, pin_kind: null, first_seen_at: 0,
    last_seen_at: 0, first_page: null, first_sort: null, batch_id: null, missing_since: null, ...o,
  };
}

// 全要素树：根 101（UP酱，赞 20）/ 102（张三，赞 10）；101 组楼 201-205（含悬空父 999、
// 悬空 dialog 888、二层链）+ 102 组直回楼 206 + 孤儿组 301（根 777 不在树）。
function fullTree(): CommentTree {
  const rootUp = rec({ rpid_str: '101', uname: 'UP酱', is_up: 1, like_count: 20, ip_location: '上海', ctime_s: 1_700_000_000, up_reply: 1, message: '根正文', pin_kind: 'upper' });
  const rootZ = rec({ rpid_str: '102', uname: '张三', like_count: 10, ctime_s: 1_700_000_100, state: 5 });
  const f1 = rec({ rpid_str: '201', root_rpid: '101', parent_rpid: '101', dialog_rpid: '101', is_root: 0, uname: '李四', message: '楼1', ctime_s: 1_700_000_200, like_count: 3 });
  const f2 = rec({ rpid_str: '202', root_rpid: '101', parent_rpid: '999', dialog_rpid: '101', is_root: 0, uname: '王五', message: '楼2', ctime_s: 1_700_000_300 });
  const f3 = rec({ rpid_str: '203', root_rpid: '101', parent_rpid: '201', dialog_rpid: '201', is_root: 0, uname: '赵六', message: '楼3', state: 17, ctime_s: 1_700_000_400 });
  const f4 = rec({ rpid_str: '204', root_rpid: '101', parent_rpid: '202', dialog_rpid: '203', is_root: 0, uname: '钱七', message: '楼4', folded: 1, ctime_s: 1_700_000_500 });
  const f5 = rec({ rpid_str: '205', root_rpid: '101', parent_rpid: '999', dialog_rpid: '888', is_root: 0, uname: null, message: '楼5', ctime_s: 1_700_000_550 });
  const f6 = rec({ rpid_str: '206', root_rpid: '102', parent_rpid: '102', dialog_rpid: '102', is_root: 0, uname: '孙八', message: '楼6', ctime_s: 1_700_000_650 });
  const orphan = rec({ rpid_str: '301', root_rpid: '777', parent_rpid: '777', dialog_rpid: '777', is_root: 0, uname: '孤儿', message: '孤楼', ctime_s: 1_700_000_600 });
  return {
    roots: [rootUp, rootZ],
    floorsByRoot: new Map([['101', [f1, f2, f3, f4, f5]], ['102', [f6]], ['777', [orphan]]]),
  };
}

test('shapeTree：全要素组装（楼层深度/回复指向/对象已删/孤儿组/counts 全树口径）', () => {
  const s = shapeTree(fullTree());
  assert.deepEqual(s.counts, { rows: 9, roots: 2, floors: 7 }, 'counts 恒全树口径');
  assert.equal(s.truncated, false, '未传 limit 不置截断');
  // 根序保持 treeByVideo 输入序（like DESC 已在 db 层保证，shape 不重排）
  assert.deepEqual(s.roots.map((r) => r.rpid_str), ['101', '102']);
  const floors101 = s.roots[0].floors;
  assert.deepEqual(floors101.map((f) => f.rpid_str), ['201', '202', '203', '204', '205'], '组内楼序保持 ctime 升序输入');
  // f1 直回根：dialog=101 → 指向根作者；parent=根 → 深度 1，对象未删
  assert.equal(floors101[0].depth, 1);
  assert.equal(floors101[0].reply_to, 'UP酱');
  assert.equal(floors101[0].parent_missing, false);
  // f2 parent 999 悬空 → 深度停在 1；parent 999 ≠ dialog 101 → 对象已删
  assert.equal(floors101[1].depth, 1);
  assert.equal(floors101[1].reply_to, 'UP酱');
  assert.equal(floors101[1].parent_missing, true);
  // f3 parent=201（楼）→ 深度 2，指向 201 作者；parent=dialog → 未删
  assert.equal(floors101[2].depth, 2);
  assert.equal(floors101[2].reply_to, '李四');
  assert.equal(floors101[2].parent_missing, false);
  // f4 parent=202（楼，其父链 999 悬空）→ 链断即停深度 2；指向 203 作者；parent≠dialog → 已删
  assert.equal(floors101[3].depth, 2);
  assert.equal(floors101[3].reply_to, '赵六');
  assert.equal(floors101[3].parent_missing, true);
  // f5 dialog=888 悬空 → 无指向；parent 999 ≠ dialog 888 → 已删
  assert.equal(floors101[4].depth, 1);
  assert.equal(floors101[4].reply_to, null);
  assert.equal(floors101[4].parent_missing, true);
  // 102 组直回楼：dialog=根 102 → 指向根作者
  const floors102 = s.roots[1].floors;
  assert.equal(floors102[0].depth, 1);
  assert.equal(floors102[0].reply_to, '张三');
  assert.equal(floors102[0].parent_missing, false);
  // 孤儿组（根 777 不在树）→ depth 恒 1、reply_to 恒 null（同 CLI floorLine(f,1,null) 语义）
  assert.deepEqual(s.orphans.map((f) => f.rpid_str), ['301']);
  assert.equal(s.orphans[0].depth, 1);
  assert.equal(s.orphans[0].reply_to, null);
  // 孤儿 parent=777 且 dialog=777（同指）→ 不算「对象已删」（纯字段比较，同 CLI）
  assert.equal(s.orphans[0].parent_missing, false);
});

test('shapeTree：四层 parent 链第 4 层拍平到 3；dialog=自身/0 → 无指向', () => {
  const root = rec({ rpid_str: 'R', uname: '根作者', like_count: 5 });
  const a = rec({ rpid_str: 'A', root_rpid: 'R', parent_rpid: 'R', dialog_rpid: 'R', is_root: 0, uname: '甲', ctime_s: 1 });
  const b = rec({ rpid_str: 'B', root_rpid: 'R', parent_rpid: 'A', dialog_rpid: 'A', is_root: 0, uname: '乙', ctime_s: 2 });
  const c = rec({ rpid_str: 'C', root_rpid: 'R', parent_rpid: 'B', dialog_rpid: 'B', is_root: 0, uname: '丙', ctime_s: 3 });
  const d = rec({ rpid_str: 'D', root_rpid: 'R', parent_rpid: 'C', dialog_rpid: 'C', is_root: 0, uname: '丁', ctime_s: 4 });
  const self = rec({ rpid_str: 'S', root_rpid: 'R', parent_rpid: 'R', dialog_rpid: 'S', is_root: 0, uname: '戊', ctime_s: 5 });
  const zero = rec({ rpid_str: 'Z', root_rpid: 'R', parent_rpid: 'R', dialog_rpid: '0', is_root: 0, uname: '己', ctime_s: 6 });
  const s = shapeTree({ roots: [root], floorsByRoot: new Map([['R', [a, b, c, d, self, zero]]]) });
  assert.deepEqual(
    s.roots[0].floors.map((f) => [f.rpid_str, f.depth]),
    [['A', 1], ['B', 2], ['C', 3], ['D', 3], ['S', 1], ['Z', 1]],
    'D 在第 4 层拍平到 3（§6.3：更深保留「回复 @」前缀）',
  );
  const byId = new Map(s.roots[0].floors.map((f) => [f.rpid_str, f]));
  assert.equal(byId.get('A')!.parent_missing, false, 'parent=根 → 未删');
  assert.equal(byId.get('D')!.parent_missing, false, 'parent=C 在树 → 未删');
  assert.equal(byId.get('S')!.reply_to, null, 'dialog=自身 → 无指向');
  assert.equal(byId.get('Z')!.reply_to, null, "dialog='0' → 无指向");
  assert.equal(byId.get('B')!.reply_to, '甲');
  assert.equal(byId.get('D')!.reply_to, '丙');
});

test('shapeTree reply_to 悬空兜底：dialog 悬空+parent_reply_name 快照 → 快照；在库优先 uname；皆无/自身·0 恒 null', () => {
  const root = rec({ rpid_str: 'R', uname: '根作者', like_count: 5 });
  const a = rec({ rpid_str: 'A', root_rpid: 'R', parent_rpid: 'R', dialog_rpid: 'A', is_root: 0, uname: '甲', ctime_s: 0 });
  // dialog 指向在库行（A，uname 甲）→ 现状 uname 优先，快照不参与
  const inDb = rec({ rpid_str: 'inDb', root_rpid: 'R', parent_rpid: 'A', dialog_rpid: 'A', is_root: 0, uname: '回库', parent_reply_name: '快照不该出现', ctime_s: 1 });
  // dialog 悬空（888 不在树）+ 快照非空 → 快照兜底（B 站楼内互复 dialog==parent，快照即被回复者名）
  const ghost = rec({ rpid_str: 'ghost', root_rpid: 'R', parent_rpid: '888', dialog_rpid: '888', is_root: 0, uname: '悬快照', parent_reply_name: '已删君', ctime_s: 2 });
  // 悬空且无快照 → 维持现状 null（渲染省略「回复 @」）
  const bare = rec({ rpid_str: 'bare', root_rpid: 'R', parent_rpid: 'gone', dialog_rpid: 'gone', is_root: 0, uname: '无摘要', parent_reply_name: null, ctime_s: 3 });
  // dialog=自身即使误带快照也恒 null（B 站免渲染「回复 @根作者」）
  const self = rec({ rpid_str: 'self', root_rpid: 'R', parent_rpid: 'R', dialog_rpid: 'self', is_root: 0, uname: '直根', parent_reply_name: '不该出现', ctime_s: 4 });
  // 指向行在库但 uname null + 快照非空 → 快照兜底（与 bundle replyPrefix「uname 优先否则快照」同序）
  const anonT = rec({ rpid_str: 'anonT', root_rpid: 'R', parent_rpid: 'R', dialog_rpid: 'anonT', is_root: 0, uname: null, ctime_s: 5 });
  const anon = rec({ rpid_str: 'anon', root_rpid: 'R', parent_rpid: 'anonT', dialog_rpid: 'anonT', is_root: 0, uname: '回匿名', parent_reply_name: '匿名快照', ctime_s: 6 });
  const s = shapeTree({ roots: [root], floorsByRoot: new Map([['R', [a, inDb, ghost, bare, self, anonT, anon]]]) });
  const byId = new Map(s.roots[0].floors.map((f) => [f.rpid_str, f]));
  assert.equal(byId.get('inDb')!.reply_to, '甲', '指向行在库 → 用其 uname（现状不变，快照不泄入）');
  assert.equal(byId.get('ghost')!.reply_to, '已删君', '悬空 → parent_reply_name 快照兜底');
  assert.equal(byId.get('bare')!.reply_to, null, '悬空且快照缺失 → 维持省略（现状不变）');
  assert.equal(byId.get('self')!.reply_to, null, 'dialog=自身恒省略（快照不泄入）');
  assert.equal(byId.get('anon')!.reply_to, '匿名快照', '在库但无名 → 快照兜底（uname 优先否则快照，与 bundle 同序）');
});

test('shapeTree：limit 截根——被截根组不进孤儿、counts 仍全树、truncated 置位', () => {
  const s = shapeTree(fullTree(), { limit: 1 });
  assert.deepEqual(s.roots.map((r) => r.rpid_str), ['101'], '只保留点赞前 1 根');
  assert.equal(s.truncated, true);
  assert.deepEqual(s.counts, { rows: 9, roots: 2, floors: 7 }, 'counts 不随截根缩水');
  assert.deepEqual(s.orphans.map((f) => f.rpid_str), ['301'], '真孤儿组不受 limit 影响');
  assert.ok(!s.orphans.some((f) => f.rpid_str === '206'), '被截根（102）的楼不是孤儿——根在树内');
  // limit=0 → 不限
  const all = shapeTree(fullTree(), { limit: 0 });
  assert.equal(all.roots.length, 2);
  assert.equal(all.truncated, false);
  // limit 大于根数 → 不置 truncated
  const roomy = shapeTree(fullTree(), { limit: 99 });
  assert.equal(roomy.truncated, false);
  assert.equal(roomy.roots.length, 2);
});

test('shapeTree：空树 → 全空 + truncated false', () => {
  const s = shapeTree({ roots: [], floorsByRoot: new Map() });
  assert.deepEqual(s.roots, []);
  assert.deepEqual(s.orphans, []);
  assert.deepEqual(s.counts, { rows: 0, roots: 0, floors: 0 });
  assert.equal(s.truncated, false);
});
