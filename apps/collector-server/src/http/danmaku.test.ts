// http/danmaku.ts 端点测试（2026-10-07 弹幕解冻，规格唯一来源 docs/plans/danmaku/PLAN.md §4.1/§5.3）：
// POST /api/danmaku/ingest（白名单映射 + 批次级 cid/page 盖章 + upsert 幂等 + 缺 id_str 跳过计数
// + 字段容错 + 批量事务原子性）+ GET /api/danmaku/count（0 行 200 非 404 / 多 P pages 聚合）
// + GET /api/danmaku/verify（§5.3 纯库内统计 R1-R5，只读无副作用）
// + GET /api/danmaku/list（全量轻量列表：白名单四字段不泄漏 id_str/mid_hash / 多 P 排序 / 0 行 200 非 404；
//   popup 展示/复制消费，2026-10-07 用户现场指令追加）。
// 夹具：临时文件库 + migrate（v22 含 danmaku 表）+ ingestVideo 种子；真实 HTTP server 直挂 handler
// （经 runHandler 兜底，对齐 main.ts 生产装配——事务中途失败的 500 归一依赖它）。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | ingest 200/幂等/skipped/容错/400 族/404 + count 三形态 + verify R1-R5/只读/404 + 事务原子性 | 通过 | 2026-10-07 弹幕 HTTP 层 |
// | R2 | list 200 白名单映射/多 P 排序/0 行形态/404/400 | 通过 | 2026-10-07 popup 全量列表端点追加 |

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
import type { DanmakuRecord } from '../db/danmaku.js';
import { handleDanmakuHttp } from './danmaku.js';
import { runHandler } from './http-util.js';

// 起 handler 直挂的测试 server（不经 main.ts 的 Origin/Bearer 守卫，聚焦 handler 逻辑；
// 但保留 runHandler 兜底——生产装配同款，事务中途异常的 500 归一由它承担）
function setup(): Promise<{ port: number; db: Database.Database; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-danmaku-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '测试视频', creator: { source_uid: 'u1', name: 'UP主' }, duration: 60, published_at: 1700000000000 },
    tracks: [],
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void runHandler(res, () => handleDanmakuHttp(req, res, db));
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
  const res = await fetch(`http://127.0.0.1:${port}/api/danmaku/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function get(port: number, sub: string, bvid?: string): Promise<{ status: number; json: any }> {
  const qs = bvid === undefined ? '' : `?bvid=${encodeURIComponent(bvid)}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/danmaku/${sub}${qs}`);
  return { status: res.status, json: await res.json().catch(() => null) };
}

let seq = 0;
/** §4.1 ingest 条目契约（解析归一后形态，cli/bili-danmaku.ts 产物子集；条目本身不带 cid/page——分 P 定位在批次级）；over 后置覆盖 */
function dm(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq++;
  return {
    id_str: `d${seq}`,
    progress_ms: 1000 * seq,
    mode: 1,
    fontsize: 25,
    color: 16777215,
    mid_hash: 'crc32ab',
    content: `弹幕${seq}`,
    ctime_s: 1700000000 + seq,
    weight: 6,
    pool: 0,
    action: null,
    ...over,
  };
}

/** §4.1 ingest 请求体契约（over 后置覆盖，danmakus 单独参数便批量构造） */
function ingestBody(over: Record<string, unknown> = {}, danmakus?: unknown[]): Record<string, unknown> {
  return {
    bvid: 'BV1',
    cid: 111,
    page: 1,
    fetched_at: 1728273600000,
    batch_id: 'batch-1',
    danmakus: danmakus ?? [dm()],
    ...over,
  };
}

const getRow = (db: Database.Database, idStr: string): DanmakuRecord =>
  db.prepare('SELECT * FROM danmaku WHERE id_str = ?').get(idStr) as DanmakuRecord;
const countRows = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM danmaku').get() as { c: number }).c;

// ── ingest 正常路径 ──

test('弹幕 ingest：正常 200（白名单映射落位 + 批次级 cid/page 盖章 + inserted 计数 + 首采列）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    const rows = [
      dm({ id_str: 'd1', progress_ms: 837, mode: 1, fontsize: 25, color: 16777215, mid_hash: 'crc1', content: '前方高能', ctime_s: 1593092327, weight: 6, pool: 0, action: null }),
      dm({ id_str: 'd2', progress_ms: 210563, ctime_s: 1791348874, weight: 9 }),
    ];
    const r = await ingest(port, ingestBody({ batch_id: 'b-1', fetched_at: 1728273600000 }, rows));
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.video_id, 1);
    assert.deepEqual(
      { inserted: r.json.inserted, updated: r.json.updated, skipped: r.json.skipped },
      { inserted: 2, updated: 0, skipped: 0 },
    );

    // 白名单落位：批次级 cid/page 盖章到每行（条目本身不带分 P 定位，PLAN §4.1）
    const d1 = getRow(db, 'd1');
    assert.equal(d1.video_id, 1);
    assert.equal(d1.cid, 111);
    assert.equal(d1.page, 1);
    assert.equal(d1.progress_ms, 837);
    assert.equal(d1.mode, 1);
    assert.equal(d1.fontsize, 25);
    assert.equal(d1.color, 16777215);
    assert.equal(d1.mid_hash, 'crc1');
    assert.equal(d1.content, '前方高能');
    assert.equal(d1.ctime_s, 1593092327);
    assert.equal(d1.weight, 6);
    assert.equal(d1.pool, 0);
    assert.equal(d1.action, null);
    assert.equal(d1.first_seen_at, 1728273600000, '首采 first_seen_at = fetched_at');
    assert.equal(d1.last_seen_at, 1728273600000, '首采 last_seen_at = fetched_at');
    assert.equal(d1.batch_id, 'b-1', '首采批次落位');
  } finally { cleanup(); }
});

test('弹幕 ingest：幂等二次 ingest（updated 计数 + 观测列刷新 + 首采列 first_seen_at/batch_id 保留）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 轮 1：首采 d1
    await ingest(port, ingestBody({ fetched_at: 1000, batch_id: 'b-1' }, [
      dm({ id_str: 'd1', content: '初版', progress_ms: 100 }),
    ]));
    // 轮 2：同 id_str 重现（内容/progress 变化）→ updated=1/inserted=0；观测列刷新、首采列保留
    const r = await ingest(port, ingestBody({ fetched_at: 2000, batch_id: 'b-2' }, [
      dm({ id_str: 'd1', content: 'B 站侧修正', progress_ms: 150 }),
    ]));
    assert.equal(r.status, 200);
    assert.deepEqual({ inserted: r.json.inserted, updated: r.json.updated }, { inserted: 0, updated: 1 });
    const row = getRow(db, 'd1');
    assert.equal(row.content, 'B 站侧修正', '观测列 content 刷新');
    assert.equal(row.progress_ms, 150, '观测列 progress 刷新');
    assert.equal(row.first_seen_at, 1000, '首采列 first_seen_at 保留');
    assert.equal(row.batch_id, 'b-1', '首采批次保留（重采不动）');
    assert.equal(row.last_seen_at, 2000, 'last_seen_at 推进到本批 fetched_at');
  } finally { cleanup(); }
});

// ── ingest 校验与容错 ──

test('弹幕 ingest：缺 id_str 条目跳过计入 skipped（混批有效条目照常入库 + 全无效 200 零写入）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 混批：1 有效 + 1 缺 id_str + 1 非对象 → inserted=1 skipped=2（条目级脏数据不整批 400）
    let r = await ingest(port, ingestBody({}, [dm({ id_str: 'dMix' }), dm({ id_str: undefined }), 'junk']));
    assert.equal(r.status, 200);
    assert.deepEqual({ inserted: r.json.inserted, skipped: r.json.skipped }, { inserted: 1, skipped: 2 });
    assert.equal(getRow(db, 'dMix').id_str, 'dMix', '有效条目照常入库');

    // 全部无效 → 200 零写入（skipped 计满；upsert 空数组防御，不开事务）
    r = await ingest(port, ingestBody({}, [42, null, {}]));
    assert.equal(r.status, 200);
    assert.deepEqual(
      { inserted: r.json.inserted, updated: r.json.updated, skipped: r.json.skipped },
      { inserted: 0, updated: 0, skipped: 3 },
    );
    assert.equal(countRows(db), 1, '全无效批零写入');
  } finally { cleanup(); }
});

test('弹幕 ingest：字段容错（null/undefined/非法类型 → null 落库，不做隐式转换、不整批 400）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    const r = await ingest(port, ingestBody({}, [dm({
      id_str: 'dTol',
      progress_ms: null,   // null 直落 null
      mode: undefined,     // undefined（JSON 序列化后为缺失键）→ null
      fontsize: '25',      // 字符串数字不收（非法类型 → null）
      color: { v: 1 },     // 对象 → null
      mid_hash: '',        // 空串 → null
      content: 123,        // 非字符串 → null
      weight: null,
      pool: undefined,
      action: 7,           // 非字符串 → null
    })]));
    assert.equal(r.status, 200);
    assert.equal(r.json.inserted, 1);
    const row = getRow(db, 'dTol');
    assert.deepEqual(
      {
        progress_ms: row.progress_ms, mode: row.mode, fontsize: row.fontsize, color: row.color,
        mid_hash: row.mid_hash, content: row.content, weight: row.weight, pool: row.pool, action: row.action,
      },
      {
        progress_ms: null, mode: null, fontsize: null, color: null,
        mid_hash: null, content: null, weight: null, pool: null, action: null,
      },
      '容错字段全部落 null',
    );
  } finally { cleanup(); }
});

test('弹幕 ingest：body 校验 400 族（六必填字段缺失/形态错）+ 视频 404 + 非 ingest 路径 404', async () => {
  const { port, cleanup } = await setup();
  try {
    const valid = [dm()];
    // 缺 bvid / 空串 → 400
    assert.equal((await ingest(port, ingestBody({ bvid: undefined }, valid))).status, 400);
    assert.equal((await ingest(port, ingestBody({ bvid: '' }, valid))).status, 400);
    // 缺 cid / 非数值 cid / 缺 page → 400（批次级分 P 定位必带，§4.1）
    assert.equal((await ingest(port, ingestBody({ cid: undefined }, valid))).status, 400);
    assert.equal((await ingest(port, ingestBody({ cid: '111' }, valid))).status, 400, '字符串数字不收');
    assert.equal((await ingest(port, ingestBody({ page: undefined }, valid))).status, 400);
    // 缺 fetched_at / 缺 batch_id → 400（与 comments 缺省容错不同：弹幕批次由 CLI 统一构造，严格必带）
    assert.equal((await ingest(port, ingestBody({ fetched_at: undefined }, valid))).status, 400);
    assert.equal((await ingest(port, ingestBody({ batch_id: undefined }, valid))).status, 400);
    // 缺 danmakus / 空数组 / 非数组 → 400（数组级缺失是调用方 bug；条目级脏数据走 skipped 容错）
    assert.equal((await ingest(port, { bvid: 'BV1', cid: 1, page: 1, fetched_at: 1, batch_id: 'b' })).status, 400, '缺 danmakus');
    assert.equal((await ingest(port, ingestBody({}, []))).status, 400, 'danmakus 空数组');
    assert.equal((await ingest(port, { bvid: 'BV1', cid: 1, page: 1, fetched_at: 1, batch_id: 'b', danmakus: 'nope' })).status, 400, 'danmakus 非数组');
    // body 非 JSON 对象 → 400
    assert.equal((await ingest(port, null)).status, 400);
    // 400 回执形态：{ ok:false, error }
    const bad = await ingest(port, ingestBody({ bvid: '' }, valid));
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.error, /bvid/);
    // 视频不在库 → 404（错误含 source/bvid 定位；弹幕挂 videos.id，先采视频再谈弹幕，PLAN §4.1）
    const nf = await ingest(port, ingestBody({ bvid: 'BVnope' }, valid));
    assert.equal(nf.status, 404);
    assert.match(nf.json.error, /video not found: bilibili\/BVnope/);
    // 非 ingest 路径（GET 同路径 / 未知子路径）→ 404
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/danmaku/ingest`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/danmaku/unknown`)).status, 404);
  } finally { cleanup(); }
});

// ── count / verify 读端点 ──

test('弹幕 count：0 行形态 200（非 404）/ 多 P pages 聚合 200 / 按 video 隔离 / 不在库 404 / 缺参 400', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 1. 视频在库、零弹幕 → 200 rows:0/pages:[]（PLAN §4.1 明示非 404；步 0 count 哨兵依赖）
    let r = await get(port, 'count', 'BV1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, bvid: 'BV1', rows: 0, pages: [], max_ctime_s: null, min_progress_ms: null, max_progress_ms: null });

    // 2. 多 P：P1(cid 111) 2 行 + P2(cid 222/page 2) 1 行 → pages 按 cid,page 升序聚合 + 时间轴水位
    await ingest(port, ingestBody({ cid: 111, page: 1, batch_id: 'b1', fetched_at: 1000 }, [
      dm({ id_str: 'c1', progress_ms: 837, ctime_s: 1593092327 }),
      dm({ id_str: 'c2', progress_ms: 210563, ctime_s: 1791348874 }),
    ]));
    await ingest(port, ingestBody({ cid: 222, page: 2, batch_id: 'b2', fetched_at: 2000 }, [
      dm({ id_str: 'c3', progress_ms: 5000, ctime_s: 1600000000 }),
    ]));
    r = await get(port, 'count', 'BV1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      ok: true, bvid: 'BV1', rows: 3,
      pages: [{ cid: 111, page: 1, rows: 2 }, { cid: 222, page: 2, rows: 1 }],
      max_ctime_s: 1791348874, min_progress_ms: 837, max_progress_ms: 210563,
    });

    // 3. 第二视频在库无弹幕 → 0 行形态（对照，证明聚合按 video_id 隔离）
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV2', title: '对照视频', creator: { source_uid: 'u1', name: 'UP主' }, duration: 60, published_at: 1700000000000 },
      tracks: [],
    });
    const empty = await get(port, 'count', 'BV2');
    assert.deepEqual(empty.json, { ok: true, bvid: 'BV2', rows: 0, pages: [], max_ctime_s: null, min_progress_ms: null, max_progress_ms: null });

    // 4. 不在库 → 404；缺 bvid 参数 → 400
    r = await get(port, 'count', 'BVnope');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /video not found/);
    assert.equal((await get(port, 'count')).status, 400);
  } finally { cleanup(); }
});

test('弹幕 verify：§5.3 统计 200（R1 负 progress/R3 分布分位/R4 直方图峰值/R5 ctime）/ 只读幂等 / 不在库 404 / 缺参 400', async () => {
  const { port, cleanup } = await setup();
  try {
    // 夹具 5 行：v4 高级弹幕（mode 7）负时间点——不进 R1 计数、不进直方图、进 min（原值保留口径）；
    // v5 普通弹幕负时间点 → R1 negative_progress=1；v2/v3 同落 60000ms 桶 → 峰值 2 行
    await ingest(port, ingestBody({ cid: 111, page: 1 }, [
      dm({ id_str: 'v1', progress_ms: 30000, mode: 1, weight: 6, ctime_s: 1593092327 }),
      dm({ id_str: 'v2', progress_ms: 90000, mode: 1, weight: 6, ctime_s: 1593092400 }),
      dm({ id_str: 'v3', progress_ms: 90000, mode: 5, weight: 9, ctime_s: 1600000000 }),
      dm({ id_str: 'v4', progress_ms: -1, mode: 7, weight: 10, ctime_s: 1791348874 }),
      dm({ id_str: 'v5', progress_ms: -5, mode: 1, weight: 2, ctime_s: 1593099999 }),
    ]));
    const r = await get(port, 'verify', 'BV1');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.bvid, 'BV1');
    assert.deepEqual(r.json.counts, { rows: 5, pages: 1, by_page: [{ cid: 111, page: 1, rows: 5 }] });
    assert.equal(r.json.timeline.min_progress_ms, -5, 'min 取全部非空原值（含负值，§2.3 原值保留）');
    assert.equal(r.json.timeline.max_progress_ms, 90000);
    assert.deepEqual(
      r.json.timeline.histogram_60s,
      [{ from_ms: 0, rows: 1 }, { from_ms: 60000, rows: 2 }],
      '直方图只收 progress>=0 的行（负值无分钟位置，R1 单独计数）',
    );
    assert.deepEqual(r.json.timeline.peak_minute, { from_ms: 60000, rows: 2 });
    assert.deepEqual(r.json.mode, { '1': 3, '5': 1, '7': 1 }, 'mode 分布（NULL 不入，键为十进制字符串）');
    assert.deepEqual(r.json.weight, { p50: 6, p90: 10, max: 10 }, 'nearest-rank 分位（升序 [2,6,6,9,10]）');
    assert.deepEqual(r.json.integrity, { dup_id: 0, negative_progress: 1 }, 'R1 只计非高级弹幕（mode<7）负时间点');
    assert.deepEqual(r.json.ctime, { min_s: 1593092327, max_s: 1791348874 });
    // 只读：verify 后库内行数不变（无副作用，collect 收尾可安全自动调用）
    assert.equal((await get(port, 'count', 'BV1')).json.rows, 5, 'verify 无副作用');
    // 不在库 → 404；缺 bvid 参数 → 400
    assert.equal((await get(port, 'verify', 'BVnope')).status, 404);
    assert.equal((await get(port, 'verify')).status, 400);
  } finally { cleanup(); }
});

// ── list 读端点（popup 展示/复制消费，2026-10-07 用户现场指令追加）──

test('弹幕 list：200 全量行（白名单四字段映射不泄漏 id_str/mid_hash）+ 多 P 排序（cid 升序内 progress 升序）', async () => {
  const { port, cleanup } = await setup();
  try {
    // 多 P 乱序入库：先 P2(cid 222) 后 P1(cid 111)，P1 内 progress 乱序、含全 null 行——
    // 证明响应排序来自查询（§3.4 cid ASC, progress_ms ASC, id ASC；SQLite ASC 对 NULL 排最前）
    await ingest(port, ingestBody({ cid: 222, page: 2, batch_id: 'b2' }, [
      dm({ id_str: 'p2a', progress_ms: 5000, content: 'P2甲' }),
      dm({ id_str: 'p2b', progress_ms: 1000, content: 'P2乙' }),
    ]));
    await ingest(port, ingestBody({ cid: 111, page: 1, batch_id: 'b1' }, [
      dm({ id_str: 'p1a', progress_ms: 210563, content: '后发先至' }),
      dm({ id_str: 'p1b', progress_ms: 837, ctime_s: 1593092327, content: '前方高能' }),
      dm({ id_str: 'p1c', progress_ms: null, mode: null, content: null, ctime_s: null }),
    ]));

    const r = await get(port, 'list', 'BV1');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.bvid, 'BV1');
    assert.equal(r.json.rows, 5, 'rows = 全量总条数');
    assert.deepEqual(r.json.pages, [{ cid: 111, page: 1, rows: 3 }, { cid: 222, page: 2, rows: 2 }], 'pages 口径与 count 一致');

    // 白名单映射：每个条目只含四个键（防泄漏——id_str/mid_hash/fontsize/color/weight 等一律不出网）
    for (const d of r.json.danmakus) {
      assert.deepEqual(Object.keys(d).sort(), ['content', 'ctime_s', 'mode', 'progress_ms'], '条目仅白名单四键');
    }
    // 排序：cid 111 的三行在前（null 排最前 → 837 → 210563），cid 222 两行在后（1000 → 5000）
    assert.deepEqual(
      r.json.danmakus.map((d: { content: string | null }) => d.content),
      [null, '前方高能', '后发先至', 'P2乙', 'P2甲'],
    );
    // 条目形态抽查：正常行值原样 + 全 null 行原样（白名单字段可为 null，不做兜底填充）
    assert.deepEqual(r.json.danmakus[1], { progress_ms: 837, mode: 1, content: '前方高能', ctime_s: 1593092327 });
    assert.deepEqual(r.json.danmakus[0], { progress_ms: null, mode: null, content: null, ctime_s: null });
  } finally { cleanup(); }
});

test('弹幕 list：0 行形态 200（非 404，与 count 口径一致）/ 不在库 404 / 缺参 400', async () => {
  const { port, cleanup } = await setup();
  try {
    // 视频在库、零弹幕 → 200 空列表（非 404；popup 对未采视频可正常渲染空态）
    const r = await get(port, 'list', 'BV1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, bvid: 'BV1', rows: 0, pages: [], danmakus: [] });

    // 不在库 → 404（错误带 source/bvid 定位）；缺 bvid 参数 → 400
    const nf = await get(port, 'list', 'BVnope');
    assert.equal(nf.status, 404);
    assert.equal(nf.json.ok, false);
    assert.match(nf.json.error, /video not found: bilibili\/BVnope/);
    assert.equal((await get(port, 'list')).status, 400);
  } finally { cleanup(); }
});

// ── 批量事务原子性 ──

test('弹幕 ingest：批量事务原子性（中途写失败全回滚，无半批入库；回执 500 归一；回滚后库可用）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 触发器模拟中途约束失败：dBAD 行 INSERT 时 RAISE(ABORT) → upsertDanmaku 单事务整体回滚
    db.exec(`CREATE TRIGGER fail_at_dbad BEFORE INSERT ON danmaku WHEN NEW.id_str = 'dBAD'
             BEGIN SELECT RAISE(ABORT, 'simulated mid-batch failure'); END;`);
    const r = await ingest(port, ingestBody({}, [
      dm({ id_str: 'ok1' }),
      dm({ id_str: 'ok2' }),
      dm({ id_str: 'dBAD' }),
      dm({ id_str: 'ok3' }),
    ]));
    assert.equal(r.status, 500, 'runHandler 兜底：未预期异常归一 500（生产 main.ts 同款装配）');
    assert.equal(r.json.ok, false);
    assert.equal(countRows(db), 0, 'ok1/ok2 先执行但须随事务回滚，零半批残留');
    assert.equal(db.inTransaction, false, '事务不残留打开状态');

    // 回滚后库可用：撤销触发器重发（去掉 dBAD）→ 正常 200 全量入库
    db.exec('DROP TRIGGER fail_at_dbad');
    const r2 = await ingest(port, ingestBody({}, [
      dm({ id_str: 'ok1' }), dm({ id_str: 'ok2' }), dm({ id_str: 'ok3' }),
    ]));
    assert.equal(r2.status, 200);
    assert.equal(r2.json.inserted, 3);
  } finally { cleanup(); }
});
