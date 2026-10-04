// http/comments.ts 端点测试（C2，规格唯一来源 docs/plans/comments/PLAN.md §4.1/§5.2/§7.1）：
// POST /api/comments/ingest（服务端 parseReplyRow 解析归一 + upsert 幂等 + full_scan 触发 missing 对账
// + pins 仅 full 轮清打 + 批量事务原子性）+ GET /api/comments/count（0 评论 200 非 404 / 水位只看根）
// + GET /api/comments/verify（纯库内校验，R4 分母走 rcount 快照）。
// 夹具：临时文件库 + migrate + ingestVideo 种子；真实 HTTP server 直挂 handler（经 runHandler 兜底，
// 对齐 main.ts 生产装配——事务中途失败的 500 归一依赖它）。§2.3 映射前的原始条目形态由 rawReply 构造。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | ingest 200/400 族/404 + missing 四态 + pins 清打 + 事务回滚 + count/verify 全形态 + 缺省容错 | 通过 | 2026-10-04 C2 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import type { CommentRecord } from '../db/comments.js';
import { handleCommentsHttp } from './comments.js';
import { runHandler } from './http-util.js';

// 起 handler 直挂的测试 server（不经 main.ts 的 Origin/Bearer 守卫，聚焦 handler 逻辑；
// 但保留 runHandler 兜底——生产装配同款，事务中途异常的 500 归一由它承担）
function setup(): Promise<{ port: number; db: Database.Database; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-comments-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '测试视频', creator: { source_uid: 'u1', name: 'UP主' }, duration: 60, published_at: 1700000000000 },
    tracks: [],
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void runHandler(res, () => handleCommentsHttp(req, res, db));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        db,
        cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
      });
    });
  });
}

async function ingest(port: number, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/comments/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function get(port: number, sub: string, bvid?: string): Promise<{ status: number; json: any }> {
  const qs = bvid === undefined ? '' : `?bvid=${encodeURIComponent(bvid)}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/comments/${sub}${qs}`);
  return { status: res.status, json: await res.json().catch(() => null) };
}

let seq = 0;
/** §2.3 映射前的原始条目子集（根评论缺省形态；键对齐 PLAN §2.3 字段字典，全角冒号 location 实测形态） */
function rawReply(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq++;
  return {
    rpid_str: `r${seq}`,
    root_str: '0',
    parent_str: '0',
    dialog_str: '0',
    mid_str: '100',
    member: { uname: '用户A', level_info: { current_level: 6 } },
    content: { message: '正文' },
    like: 5,
    rcount: 0,
    count: 0,
    ctime: 1000,
    state: 0,
    invisible: false,
    folder: { is_folded: false },
    up_action: { like: false, reply: false },
    reply_control: { location: 'IP属地：上海' },
    ...over,
  };
}

/** 楼中楼直接回复根（§2.4：root=楼根、parent=楼根、dialog=自身） */
function rawFloor(rpid: string, root: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return rawReply({ rpid_str: rpid, root_str: root, parent_str: root, dialog_str: rpid, ...over });
}

/** §4.1 ingest 请求体契约（缺省 partial 轮形态；over 后置覆盖，replies 单独参数便批量构造） */
function ingestBody(over: Record<string, unknown> = {}, replies?: unknown[]): Record<string, unknown> {
  return {
    bvid: 'BV1',
    oid: '117373419915771',
    upper_mid: '3493260618106936',
    fetched_at: 1727913600000,
    batch_id: 'batch-1',
    sort: 'time',
    page: 1,
    full_scan: false,
    scan_start: 1727913600000,
    pins: [],
    replies: replies ?? [rawReply()],
    ...over,
  };
}

const getRow = (db: Database.Database, rpid: string): CommentRecord =>
  db.prepare('SELECT * FROM comments WHERE rpid_str = ?').get(rpid) as CommentRecord;
const countRows = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM comments').get() as { c: number }).c;

// ── ingest 正常路径 ──

test('comments ingest：正常 200（§2.3 解析归一落位 + inserted/updated 计数 + 幂等重采首采列保留）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 1. 首次 ingest：根 r1/r2（r2 是 UP 主本尊）+ 楼 r1c1 → inserted=3；partial 轮 missing=null
    const rows = [
      rawReply({ rpid_str: 'r1', ctime: 1000 }),
      rawReply({ rpid_str: 'r2', mid_str: '3493260618106936', ctime: 5000, folder: { is_folded: true } }),
      rawFloor('r1c1', 'r1', { ctime: 6000, reply_control: { location: 'IP属地：河北' } }),
    ];
    const r = await ingest(port, ingestBody({}, rows));
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.video_id, 1);
    assert.deepEqual(
      { inserted: r.json.inserted, updated: r.json.updated, missing: r.json.missing },
      { inserted: 3, updated: 0, missing: null },
      'full_scan:false → missing 回执 null',
    );

    // 2. §2.3 解析归一落位断言：五 ID *_str / 全角冒号 location 切分 / folded 只认 is_folded / is_up String 直读
    const row1 = getRow(db, 'r1');
    assert.equal(row1.ip_location, '上海', '「IP属地：上海」按全角冒号切末段');
    assert.equal(row1.is_root, 1);
    assert.equal(row1.uname, '用户A', 'member.uname 提级冗余列');
    const row2 = getRow(db, 'r2');
    assert.equal(row2.is_up, 1, 'mid_str===String(upper_mid) → is_up=1');
    assert.equal(row2.folded, 1, 'folder.is_folded=true → folded=1');
    const floor = getRow(db, 'r1c1');
    assert.equal(floor.is_root, 0);
    assert.equal(floor.root_rpid, 'r1');
    assert.equal(floor.parent_rpid, 'r1');
    assert.equal(floor.dialog_rpid, 'r1c1', '直回根 dialog=自身（§2.4）');
    assert.equal(floor.ip_location, '河北');
    assert.equal(floor.first_page, 1, '首采页序落位');
    assert.equal(floor.first_sort, 'time');
    assert.equal(floor.batch_id, 'batch-1');
    assert.equal(floor.last_seen_at, 1727913600000);

    // 3. 幂等重采：同 rpid like 变化 → updated=3/inserted=0；观测列更新、首采列（first_seen_at/
    //    batch_id/first_page）保留、last_seen_at 推进到本批 fetched_at
    const r2 = await ingest(port, ingestBody({ fetched_at: 1727913700000, batch_id: 'batch-2', page: 2 }, [
      rawReply({ rpid_str: 'r1', like: 99 }),
      rawReply({ rpid_str: 'r2', like: 1, mid_str: '3493260618106936', ctime: 5000, folder: { is_folded: true } }),
      rawFloor('r1c1', 'r1', { like: 7, ctime: 6000 }),
    ]));
    assert.equal(r2.status, 200);
    assert.deepEqual({ inserted: r2.json.inserted, updated: r2.json.updated }, { inserted: 0, updated: 3 });
    const after = getRow(db, 'r1');
    assert.equal(after.like_count, 99, '观测列 like 更新');
    assert.equal(after.first_seen_at, 1727913600000, '首采列 first_seen_at 保留');
    assert.equal(after.batch_id, 'batch-1', '首采批次保留');
    assert.equal(after.first_page, 1, '首采页序保留');
    assert.equal(after.last_seen_at, 1727913700000, 'last_seen_at 推进到本批 fetched_at');
  } finally { cleanup(); }
});

// ── ingest 校验与容错 ──

test('comments ingest：body 校验 400 族（缺 bvid / 缺空 replies / full_scan 缺 scan_start / pins 非法 / 全无效条目）+ 视频 404 + 非 ingest 路径 404', async () => {
  const { port, cleanup } = await setup();
  try {
    const valid = [rawReply()];
    // 缺 bvid / 空串 bvid → 400
    assert.equal((await ingest(port, ingestBody({ bvid: undefined }, valid))).status, 400);
    assert.equal((await ingest(port, ingestBody({ bvid: '' }, valid))).status, 400);
    // 缺 replies / replies 空数组 / replies 非数组 → 400
    assert.equal((await ingest(port, { bvid: 'BV1', oid: '1' })).status, 400, '缺 replies');
    assert.equal((await ingest(port, ingestBody({}, []))).status, 400, 'replies 空数组');
    assert.equal((await ingest(port, { bvid: 'BV1', replies: 'nope' })).status, 400, 'replies 非数组');
    // full_scan:true 缺 scan_start → 400（对账缺扫描起始，missing_since 无基准）
    assert.equal((await ingest(port, ingestBody({ full_scan: true, scan_start: undefined }, valid))).status, 400);
    // pins 非数组 / 条目非对象 / 缺 rpid_str / kind 非法 → 400
    assert.equal((await ingest(port, ingestBody({ pins: 'nope' }, valid))).status, 400);
    assert.equal((await ingest(port, ingestBody({ pins: [42] }, valid))).status, 400);
    assert.equal((await ingest(port, ingestBody({ pins: [{ kind: 'upper' }] }, valid))).status, 400);
    assert.equal((await ingest(port, ingestBody({ pins: [{ rpid_str: 'r1', kind: 'bump' }] }, valid))).status, 400);
    // 条目全无效（非对象）→ 400；五 ID 皆缺（rpid_str/rpid 双缺）→ 解析行 rpid null 拦截 → 400
    assert.equal((await ingest(port, ingestBody({}, ['junk', 42, null]))).status, 400);
    assert.equal((await ingest(port, ingestBody({}, [rawReply({ rpid_str: undefined })]))).status, 400);
    // 视频不在库 → 404（错误含 source/bvid 定位）
    const nf = await ingest(port, ingestBody({ bvid: 'BVnope' }, valid));
    assert.equal(nf.status, 404);
    assert.match(nf.json.error, /video not found: bilibili\/BVnope/);
    // 非 ingest 路径（GET 同路径 / 未知子路径）→ 404
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/comments/ingest`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/comments/unknown`)).status, 404);
  } finally { cleanup(); }
});

test('comments ingest：缺省字段容错（fetched_at 缺省取服务器时间 / upper_mid 数值形态与 null / batch_id、sort、page 缺省 null / 个别脏条目丢弃不整批失败）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    const before = Date.now();
    // 1. upper_mid 数值形态：String(100)==='100'===mid_str → is_up=1（§2.3 upper.mid 无 *_str，String 直读防御）
    //    rpid 显式覆盖：rawReply 的 seq 自增跨测试共享，断言按显式 rpid 定位
    let r = await ingest(port, { bvid: 'BV1', replies: [rawReply({ rpid_str: 'r1', mid_str: '100' })], upper_mid: 100 });
    assert.equal(r.status, 200);
    assert.equal(getRow(db, 'r1').is_up, 1);
    // 2. upper_mid null → 不可判定，INSERT 落 0；batch_id/sort/page 缺省 null
    r = await ingest(port, { bvid: 'BV1', replies: [rawReply({ rpid_str: 'r2', mid_str: '200' })], upper_mid: null });
    assert.equal(r.status, 200);
    const row2 = getRow(db, 'r2');
    assert.equal(row2.is_up, 0);
    assert.equal(row2.batch_id, null);
    assert.equal(row2.first_page, null);
    assert.equal(row2.first_sort, null);
    // 3. fetched_at 缺省 → 服务器当前时间
    r = await ingest(port, { bvid: 'BV1', replies: [rawReply({ rpid_str: 'r3' })] });
    assert.equal(r.status, 200);
    assert.ok(getRow(db, 'r3').last_seen_at >= before, 'fetched_at 缺省取服务器当前时间');
    // 4. 混批容错：脏条目（非对象）丢弃计数、有效条目照常入库（stderr 留痕，不整批 400）
    r = await ingest(port, ingestBody({}, ['junk', rawReply({ rpid_str: 'rMix' })]));
    assert.equal(r.status, 200);
    assert.equal(r.json.inserted, 1, '脏条目丢弃、有效条目入库');
    assert.equal(getRow(db, 'rMix').rpid_str, 'rMix');
  } finally { cleanup(); }
});

// ── full_scan missing 对账 / pins 清打 ──

test('comments ingest：full_scan 触发 missing 对账（候选→确认→恢复四态；楼中楼行不参与）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 轮 1（partial，full_scan:false）：根 r1/r2 + 楼 r1c1 入库，fetched_at=1000
    let r = await ingest(port, ingestBody({ fetched_at: 1000, batch_id: 'b1' }, [
      rawReply({ rpid_str: 'r1', ctime: 100 }),
      rawReply({ rpid_str: 'r2', ctime: 200 }),
      rawFloor('r1c1', 'r1', { ctime: 300 }),
    ]));
    assert.deepEqual(r.json.missing, null);

    // 轮 2（完整轮，scan_start=2000）：只见 r1 → r2 置候选；楼 r1c1 同样缺席但不置候选（§3.3 仅根参与）
    r = await ingest(port, ingestBody({ fetched_at: 2000, full_scan: true, scan_start: 2000 }, [
      rawReply({ rpid_str: 'r1', ctime: 100 }),
    ]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.missing, { candidates: 1, restored: 1, confirmed: 0 });
    assert.equal(getRow(db, 'r2').missing_since, 2000, '缺席根置候选 missing_since=scan_start');
    assert.equal(getRow(db, 'r1c1').missing_since, null, '楼中楼行不参与 missing（根删整楼结构性不可达，§3.3）');

    // 轮 3（完整轮，scan_start=3000）：r2 仍未再见 → 确认缺失（last_seen 1000 < missing_since 2000，两轮均完整）
    r = await ingest(port, ingestBody({ fetched_at: 3000, full_scan: true, scan_start: 3000 }, [
      rawReply({ rpid_str: 'r1', ctime: 100 }),
    ]));
    assert.deepEqual(r.json.missing, { candidates: 0, restored: 1, confirmed: 1 });

    // 轮 4（完整轮，scan_start=4000）：r2 重新出现 → 恢复（missing_since 清空）
    r = await ingest(port, ingestBody({ fetched_at: 4000, full_scan: true, scan_start: 4000 }, [
      rawReply({ rpid_str: 'r1', ctime: 100 }),
      rawReply({ rpid_str: 'r2', ctime: 200 }),
    ]));
    assert.deepEqual(r.json.missing, { candidates: 0, restored: 2, confirmed: 0 });
    assert.equal(getRow(db, 'r2').missing_since, null, '重见恢复：missing_since 清空');
  } finally { cleanup(); }
});

test('comments ingest：full_scan:false 不动 missing 与 pins（partial 轮只入库，§3.3 守卫 3）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 轮 1：根 r1/r2 入库（fetched_at=1000）
    await ingest(port, ingestBody({ fetched_at: 1000 }, [
      rawReply({ rpid_str: 'r1' }), rawReply({ rpid_str: 'r2' }),
    ]));
    // 轮 2（完整轮）：仅 r1 → r2 置候选 missing_since=2000
    await ingest(port, ingestBody({ fetched_at: 2000, full_scan: true, scan_start: 2000 }, [
      rawReply({ rpid_str: 'r1' }),
    ]));
    assert.equal(getRow(db, 'r2').missing_since, 2000);
    // 轮 3（partial）：full_scan:false 只带 r1 → r2 的 missing_since 原值不动、回执 missing:null
    let r = await ingest(port, ingestBody({ fetched_at: 3000, full_scan: false }, [rawReply({ rpid_str: 'r1' })]));
    assert.deepEqual(r.json.missing, null);
    assert.equal(getRow(db, 'r2').missing_since, 2000, 'partial 轮不参与对账计数');
    // partial 轮携带 pins → 不清不打（置顶变更只在 full 轮生效，§3.3）
    r = await ingest(port, ingestBody({ fetched_at: 3100, pins: [{ rpid_str: 'r1', kind: 'upper' }] }, [
      rawReply({ rpid_str: 'r1' }),
    ]));
    assert.equal(r.status, 200);
    assert.equal(getRow(db, 'r1').pin_kind, null, 'partial 轮 pins 忽略');
  } finally { cleanup(); }
});

test('comments ingest：full 轮 pins 先清后打（撤销/换条目生效；引用不存在行不报错）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // full 轮 1：三根入库 + 置顶 r2（upper）、r3（admin）
    let r = await ingest(port, ingestBody({ full_scan: true, scan_start: 1000, pins: [
      { rpid_str: 'r2', kind: 'upper' }, { rpid_str: 'r3', kind: 'admin' },
    ] }, [
      rawReply({ rpid_str: 'r1' }), rawReply({ rpid_str: 'r2' }), rawReply({ rpid_str: 'r3' }),
    ]));
    assert.equal(r.status, 200);
    assert.equal(getRow(db, 'r2').pin_kind, 'upper');
    assert.equal(getRow(db, 'r3').pin_kind, 'admin');
    assert.equal(getRow(db, 'r1').pin_kind, null);

    // full 轮 2：置顶换成 r1（vote）+ 引用不存在行 rGHOST → 旧置顶清空、新置顶落位、幽灵引用不报错
    r = await ingest(port, ingestBody({ fetched_at: 2000, full_scan: true, scan_start: 2000, pins: [
      { rpid_str: 'r1', kind: 'vote' }, { rpid_str: 'rGHOST', kind: 'upper' },
    ] }, [rawReply({ rpid_str: 'r1' })]));
    assert.equal(r.status, 200);
    assert.equal(getRow(db, 'r1').pin_kind, 'vote');
    assert.equal(getRow(db, 'r2').pin_kind, null, '旧置顶先清');
    assert.equal(getRow(db, 'r3').pin_kind, null, '旧置顶先清');
  } finally { cleanup(); }
});

test('comments ingest：批量事务原子性（中途写失败全回滚，无半批入库；回滚后库可用）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 触发器模拟中途约束失败：rBAD 行 INSERT 时 RAISE(ABORT) → upsertComments 单事务整体回滚
    db.exec(`CREATE TRIGGER fail_at_rbad BEFORE INSERT ON comments WHEN NEW.rpid_str = 'rBAD'
             BEGIN SELECT RAISE(ABORT, 'simulated mid-batch failure'); END;`);
    const r = await ingest(port, ingestBody({}, [
      rawReply({ rpid_str: 'ok1' }),
      rawReply({ rpid_str: 'ok2' }),
      rawReply({ rpid_str: 'rBAD' }),
      rawReply({ rpid_str: 'ok3' }),
    ]));
    assert.equal(r.status, 500, 'runHandler 兜底：未预期异常归一 500（生产 main.ts 同款装配）');
    assert.equal(countRows(db), 0, 'ok1/ok2 先执行但须随事务回滚，零半批残留');
    assert.equal(db.inTransaction, false, '事务不残留打开状态');

    // 回滚后库可用：撤销触发器重发（去掉 rBAD）→ 正常 200 全量入库
    db.exec('DROP TRIGGER fail_at_rbad');
    const r2 = await ingest(port, ingestBody({}, [
      rawReply({ rpid_str: 'ok1' }), rawReply({ rpid_str: 'ok2' }), rawReply({ rpid_str: 'ok3' }),
    ]));
    assert.equal(r2.status, 200);
    assert.equal(r2.json.inserted, 3);
  } finally { cleanup(); }
});

// ── count / verify 读端点 ──

test('comments count：在库无评论 200 全 0 / 有评论 200 计数（水位只看根）/ 不在库 404 / 缺参 400', async () => {
  const { port, cleanup } = await setup();
  try {
    // 1. 视频在库、零评论 → 200 全 0（非 404；§4.3 步 0 以 rows 分流 full/incremental 依赖）
    let r = await get(port, 'count', 'BV1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, rows: 0, roots: 0, max_ctime_s: null });

    // 2. 入库 2 根（ctime 1000/5000）+ 1 楼（ctime 9999）→ rows=3 roots=2，max_ctime_s=5000
    //    （楼中楼回复不抬水位——老楼追新会把水位抬高于任何根，增量首页即判停，§4.3）
    await ingest(port, ingestBody({}, [
      rawReply({ rpid_str: 'r1', ctime: 1000 }),
      rawReply({ rpid_str: 'r2', ctime: 5000 }),
      rawFloor('r1c1', 'r1', { ctime: 9999 }),
    ]));
    r = await get(port, 'count', 'BV1');
    assert.deepEqual(r.json, { ok: true, rows: 3, roots: 2, max_ctime_s: 5000 });

    // 3. 不在库 → 404；4. 缺 bvid 参数 / 空参 → 400
    r = await get(port, 'count', 'BVnope');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /video not found/);
    assert.equal((await get(port, 'count')).status, 400);
  } finally { cleanup(); }
});

test('comments verify：纯库内校验 200（dangling 夹具回执字段 + R4 rcount 快照分母）/ 只读幂等 / 不在库 404 / 缺参 400', async () => {
  const { port, cleanup } = await setup();
  try {
    // 夹具：根 r1（rcount=3）+ 楼 r1c1（直回根 dialog=自身，不算悬空）+ 楼 r1c2（parent/dialog 指向库外行）
    await ingest(port, ingestBody({}, [
      rawReply({ rpid_str: 'r1', rcount: 3 }),
      rawFloor('r1c1', 'r1'),
      rawReply({ rpid_str: 'r1c2', root_str: 'r1', parent_str: 'rGONE', dialog_str: 'rGONE2' }),
    ]));
    const r = await get(port, 'verify', 'BV1');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.bvid, 'BV1');
    assert.deepEqual(r.json.counts, {
      roots: 1, floors: 2, total: 3, pins: 0,
      missing_candidates: 0, missing_confirmed: 0,
    });
    assert.equal(r.json.integrity.orphan_floor, 0);
    assert.equal(r.json.integrity.triple_inconsistent, 0);
    assert.equal(r.json.integrity.dangling_parent, 1, 'parent 指向库外行 → dangling_parent（R2）');
    assert.equal(r.json.integrity.dangling_dialog, 1, 'dialog 指向库外行且非自身 → dangling_dialog（R3）');
    // R4 纯库内口径：分母=根行 rcount 快照（3），实采 2 楼 → mismatch 1 + coverage 0.6667
    assert.equal(r.json.integrity.rcount_mismatch, 1);
    assert.deepEqual(r.json.integrity.rcount_mismatch_samples, ['r1(缺 1,分母=rcount fallback)']);
    assert.equal(r.json.coverage.ratio, 0.6667);
    // 只读：verify 后库内行数不变（无副作用，§5.2 入口 2）
    assert.equal((await get(port, 'count', 'BV1')).json.rows, 3, 'verify 无副作用');
    // 不在库 → 404；缺参 → 400
    assert.equal((await get(port, 'verify', 'BVnope')).status, 404);
    assert.equal((await get(port, 'verify')).status, 400);
  } finally { cleanup(); }
});
