// jobs/collect-find-worker.ts 测试：多页 search（提前终止 + 页间 sleep 计数）、since_days/fans 管线
// 过滤（unknown_fans 保守保留）、tid/client_id 下发、collect=true 建任务（createTasksBatch 去重语义 +
// has_subtitle 跳过）、searchPage 错误归因（offline/timeout/执行失败/结构异常）、无在线扩展拒绝。
// requestCommand/listOnlineClients/sleep 全部依赖注入（对齐 collect-proxy 测试先例），零真扩展零等待。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 多页/提前终止/sleep 计数/过滤管线/unknown_fans/tid 下发/collect 建任务/错误归因/无在线拒绝 | 通过 | Phase 4 web 化 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { runCollectFindJob, type CollectFindJobDeps } from './collect-find-worker.js';
import type { JobCtx } from './runner.js';

interface SentCommand { clientId: string; action: string; params: Record<string, unknown>; timeout?: number }
type MockReply = { ok: true; data?: unknown } | { ok: false; error: string } | { offline: true } | { timeout: true };

function setup(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function makeDeps(opts: {
  online?: string[];
  reply?: (cmd: { action: string; params: Record<string, unknown> }) => MockReply;
  sleeps?: number[];
}): { deps: CollectFindJobDeps; sent: SentCommand[] } {
  const sent: SentCommand[] = [];
  const deps: CollectFindJobDeps = {
    requestCommand: async (clientId, action, params, timeoutMs) => {
      sent.push({ clientId, action, params, timeout: timeoutMs });
      const r = opts.reply?.({ action, params }) ?? { ok: true, data: {} };
      if ('offline' in r) return { ok: false, code: 'offline' };
      if ('timeout' in r) return { ok: false, code: 'timeout' };
      if (r.ok) return { ok: true, result: { ok: true, data: r.data } };
      return { ok: true, result: { ok: false, error: r.error } };
    },
    listOnlineClients: () => (opts.online ?? ['ext-1']).map((client_id) => ({ client_id })),
    ...(opts.sleeps !== undefined ? { sleep: async (ms: number) => { opts.sleeps!.push(ms); } } : {}),
  };
  return { deps, sent };
}

const ctx = (db: Database.Database): JobCtx => ({ db, jobId: 7, onProgress: () => {} });

const NOW_SEC = Math.floor(Date.now() / 1000);
// 合法 BV 号（/^BV[0-9A-Za-z]{10}$/，createTasksBatch 校验用）
const BV_KEEP1 = 'BV1AAAAAAAA1';
const BV_OLD = 'BV1BBBBBBBB2';
const BV_UNK = 'BV1CCCCCCCC3';
const BV_KEEP2 = 'BV1DDDDDDDD4';

test('多页 search：raw_total 拿够提前终止（不发起多余页 + 零 sleep）；指定 client_id 直用不查在线表', async () => {
  const db = setup();
  const sleeps: number[] = [];
  const { deps, sent } = makeDeps({
    online: [], // 不应被咨询（client_id 显式指定）
    sleeps,
    reply: ({ params }) => ({
      ok: true,
      data: {
        total: 2,
        items: [
          { bvid: BV_KEEP1, mid: 100, pubdate: NOW_SEC },
          { bvid: BV_OLD, mid: 200, pubdate: NOW_SEC },
        ].filter((_, i) => (params.page as number) === 1 || i === 0),
      },
    }),
  });
  try {
    const r = await runCollectFindJob(ctx(db), { keyword: '字幕', pages: 3, client_id: 'ext-9' }, deps);
    assert.equal(r.pages_fetched, 1, '首页已拿满 raw_total=2 → 不翻页');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.clientId, 'ext-9');
    assert.deepEqual(sent[0]!.params, { keyword: '字幕', page: 1, order: 'pubdate' }, 'search 下发参数（order 固定 pubdate）');
    assert.equal(r.raw_total, 2);
    assert.equal(r.candidates, 2);
    assert.equal(sleeps.length, 0, '未翻页无页间 sleep');
  } finally { db.close(); }
});

test('多页 search：空页提前终止 + 页间 sleep 在 2-4s 随机区间', async () => {
  const db = setup();
  const sleeps: number[] = [];
  const { deps, sent } = makeDeps({
    sleeps,
    reply: ({ params }) => (params.page as number) === 1
      ? { ok: true, data: { total: 40, items: [{ bvid: BV_KEEP1, mid: 100, pubdate: NOW_SEC }, { bvid: BV_OLD, mid: 200, pubdate: NOW_SEC }] } }
      : { ok: true, data: { total: 40, items: [] } }, // 第 2 页空 → 提前终止
  });
  try {
    const r = await runCollectFindJob(ctx(db), { keyword: 'kw', pages: 5 }, deps);
    assert.equal(r.pages_fetched, 2, '空页终止，page=3..5 不发');
    assert.equal(sent.length, 2);
    assert.equal(sleeps.length, 1, '只在第 1→2 页之间 sleep 一次');
    assert.ok(sleeps[0]! >= 2000 && sleeps[0]! <= 4000, `sleep 应在 2-4s 区间，实得 ${sleeps[0]}`);
  } finally { db.close(); }
});

test('过滤管线：since_days 剔旧 + min_fans 粉丝下限 + unknown_fans 保守保留计数 + exists/has_subtitle 标注', async () => {
  const db = setup();
  db.prepare("INSERT INTO creators (source, source_uid, name, fans, first_seen_at, updated_at) VALUES ('bilibili', '100', '大UP', 5000, 1, 1)").run();
  db.prepare("INSERT INTO creators (source, source_uid, name, fans, first_seen_at, updated_at) VALUES ('bilibili', '200', '小UP', 10, 1, 1)").run();
  // 库内预存 BV_KEEP1 有字幕轨（标注 exists=true/has_subtitle=true）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: BV_KEEP1, title: '已有字幕', creator: { source_uid: '100', name: '大UP' }, duration: 60, published_at: 1 },
    tracks: [{ lan: 'zh', lan_doc: '中文', track_type: 0, versions: [{ origin: 'external', payload: { body: [] } }] }],
  });
  const { deps } = makeDeps({
    reply: () => ({
      ok: true,
      data: {
        total: 4,
        items: [
          { bvid: BV_KEEP1, mid: 100, pubdate: NOW_SEC },               // fans=5000 过 min_fans，库内有字幕
          { bvid: BV_OLD, mid: 200, pubdate: NOW_SEC - 400 * 86400 },   // 旧视频 → since_days 剔除
          { bvid: BV_UNK, mid: 300, pubdate: NOW_SEC },                 // 无 creators 行 → fans 未知保留
          { bvid: BV_KEEP2, mid: 100, pubdate: NOW_SEC },               // fans=5000 过
        ],
      },
    }),
  });
  try {
    const r = await runCollectFindJob(ctx(db), { keyword: 'kw', since_days: 30, min_fans: 1000 }, deps);
    assert.equal(r.candidates, 4);
    assert.equal(r.filtered_since, 1, '旧视频被发布时间过滤');
    assert.equal(r.filtered_fans, 0, 'fans 未知不参与过滤（保守保留）');
    assert.equal(r.unknown_fans, 1, 'mid=300 无缓存计 unknown');
    assert.deepEqual(r.items.map((i) => i.bvid), [BV_KEEP1, BV_UNK, BV_KEEP2]);
    assert.deepEqual(r.items.map((i) => i.fans), [5000, null, 5000]);
    const keep1 = r.items.find((i) => i.bvid === BV_KEEP1)!;
    assert.equal(keep1.exists, true);
    assert.equal(keep1.has_subtitle, true, '库内已有轨 → has_subtitle 标注');
    assert.equal(r.items.find((i) => i.bvid === BV_UNK)!.exists, false, '未入库 → exists=false');
  } finally { db.close(); }
});

test('max_fans 上限过滤：粉丝超限剔除，unknown 仍保留', async () => {
  const db = setup();
  db.prepare("INSERT INTO creators (source, source_uid, name, fans, first_seen_at, updated_at) VALUES ('bilibili', '100', '大UP', 5000, 1, 1)").run();
  const { deps } = makeDeps({
    reply: () => ({ ok: true, data: { total: 2, items: [
      { bvid: BV_KEEP1, mid: 100, pubdate: NOW_SEC },
      { bvid: BV_UNK, mid: 300, pubdate: NOW_SEC },
    ] } }),
  });
  try {
    const r = await runCollectFindJob(ctx(db), { keyword: 'kw', max_fans: 100 }, deps);
    assert.equal(r.filtered_fans, 1, '5000 > max_fans=100 剔除');
    assert.deepEqual(r.items.map((i) => i.bvid), [BV_UNK], 'fans 未知保留');
  } finally { db.close(); }
});

test('tid 随 search 下发（CLI --tid 同参透传）', async () => {
  const db = setup();
  const { deps, sent } = makeDeps({ reply: () => ({ ok: true, data: { total: 0, items: [] } }) });
  try {
    await runCollectFindJob(ctx(db), { keyword: 'kw', tid: 171 }, deps);
    assert.equal(sent[0]!.params.tid, 171);
  } finally { db.close(); }
});

test('collect=true → createTasksBatch 建任务（库内有字幕跳过 / 未入库新建 / creator_client_id 落指定扩展）', async () => {
  const db = setup();
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: BV_KEEP1, title: '已有字幕', creator: { source_uid: '100', name: '大UP' }, duration: 60, published_at: 1 },
    tracks: [{ lan: 'zh', lan_doc: '中文', track_type: 0, versions: [{ origin: 'external', payload: { body: [] } }] }],
  });
  const { deps } = makeDeps({
    reply: () => ({ ok: true, data: { total: 2, items: [
      { bvid: BV_KEEP1, mid: 100, pubdate: NOW_SEC },
      { bvid: BV_KEEP2, mid: 100, pubdate: NOW_SEC },
    ] } }),
  });
  try {
    const r = await runCollectFindJob(ctx(db), { keyword: 'kw', collect: true, client_id: 'ext-1' }, deps);
    assert.deepEqual(r.collected, { created: 1, skipped: 1 }, '新建 1（BV_KEEP2），跳 1（BV_KEEP1 已有字幕）');
    const task = db.prepare("SELECT source, source_vid, status, creator_client_id FROM collect_tasks WHERE source_vid = ?").get(BV_KEEP2) as { source: string; source_vid: string; status: string; creator_client_id: string };
    assert.deepEqual(task, { source: 'bilibili', source_vid: BV_KEEP2, status: 'pending', creator_client_id: 'ext-1' });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM collect_tasks').get() as { n: number }).n, 1, '只建 1 个任务（跳过的不落行）');
  } finally { db.close(); }
});

test('searchPage 错误归因：offline / timeout / 扩展执行失败 / 回执结构异常 → 各自错误消息（带页号）', async () => {
  const db = setup();
  const cases: Array<{ mock: () => MockReply; match: RegExp }> = [
    { mock: () => ({ offline: true }), match: /search page=1 扩展离线（ext-1）/ },
    { mock: () => ({ timeout: true }), match: /search page=1 扩展回执超时/ },
    { mock: () => ({ ok: false, error: 'boom' }), match: /search page=1 扩展执行失败: boom/ },
    { mock: () => ({ ok: true, data: { total: 1 } }), match: /search page=1 回执结构异常（items 非数组）dataKeys=total/ },
  ];
  for (const c of cases) {
    const { deps } = makeDeps({ reply: c.mock });
    await assert.rejects(
      () => runCollectFindJob(ctx(db), { keyword: 'kw' }, deps),
      c.match,
      `应归因: ${c.match}`,
    );
  }
  db.close();
});

test('缺省 client 且无在线扩展 → 抛错拒绝执行（任务失败归因）', async () => {
  const db = setup();
  const { deps } = makeDeps({ online: [] });
  await assert.rejects(
    () => runCollectFindJob(ctx(db), { keyword: 'kw' }, deps),
    /no online client/,
  );
  db.close();
});

test('回执结构异常分支补全：data=null（dataKeys=null）与 data 非对象（dataKeys=原始串）各自归因', async () => {
  const db = setup();
  const cases: Array<{ mock: () => MockReply; match: RegExp }> = [
    { mock: () => ({ ok: true, data: null }), match: /回执结构异常（items 非数组）dataKeys=null/ },
    { mock: () => ({ ok: true, data: 'oops' }), match: /回执结构异常（items 非数组）dataKeys=oops/ },
  ];
  for (const c of cases) {
    const { deps } = makeDeps({ reply: c.mock });
    await assert.rejects(
      () => runCollectFindJob(ctx(db), { keyword: 'kw' }, deps),
      c.match,
      `应归因: ${c.match}`,
    );
  }
  db.close();
});

test('search 回执缺 total → 防御性按 0 计（raw_total=0 不触发提前终止）；collect=true 候选被 since_days 清空 → 不建任务（collected 不落键）', async () => {
  const db = setup();
  const { deps } = makeDeps({
    reply: () => ({ ok: true, data: { items: [{ bvid: BV_KEEP1, mid: 100, pubdate: NOW_SEC - 400 * 86400 }] } }),
  });
  try {
    const r = await runCollectFindJob(ctx(db), { keyword: 'kw', since_days: 30, collect: true, client_id: 'ext-1' }, deps);
    assert.equal(r.raw_total, 0, 'total 缺失 → 0');
    assert.equal(r.candidates, 1);
    assert.equal(r.filtered_since, 1, '400 天旧视频被 since_days 剔除 → 过滤后零候选');
    assert.equal(r.collected, undefined, 'collect=true 但过滤后零候选 → 不建任务不落 collected 键');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM collect_tasks').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('collect=true 全部跳过（库内已有字幕）→ created=0 skipped=2，不踢调度器', async () => {
  const db = setup();
  for (const vid of [BV_KEEP1, BV_KEEP2]) {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: vid, title: '已有字幕', creator: { source_uid: '100', name: '大UP' }, duration: 60, published_at: 1 },
      tracks: [{ lan: 'zh', lan_doc: '中文', track_type: 0, versions: [{ origin: 'external', payload: { body: [] } }] }],
    });
  }
  const { deps } = makeDeps({
    reply: () => ({ ok: true, data: { total: 2, items: [
      { bvid: BV_KEEP1, mid: 100, pubdate: NOW_SEC },
      { bvid: BV_KEEP2, mid: 100, pubdate: NOW_SEC },
    ] } }),
  });
  try {
    const r = await runCollectFindJob(ctx(db), { keyword: 'kw', collect: true, client_id: 'ext-1' }, deps);
    assert.deepEqual(r.collected, { created: 0, skipped: 2 });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM collect_tasks').get() as { n: number }).n, 0, '全跳过不建行');
  } finally { db.close(); }
});

test('search 条目缺 mid → 过 mids 归集时防御性过滤（不参与 fans 查询）', async () => {
  const db = setup();
  const { deps } = makeDeps({
    reply: () => ({ ok: true, data: { total: 1, items: [{ bvid: BV_KEEP1, pubdate: NOW_SEC }] } }),
  });
  try {
    const r = await runCollectFindJob(ctx(db), { keyword: 'kw' }, deps);
    assert.equal(r.candidates, 1);
    assert.equal(r.unknown_fans, 0, 'mid 缺失不入 mids 集，不计 unknown');
    assert.equal(r.items[0]!.fans, null, 'fans 仍标注 null（保守形态）');
  } finally { db.close(); }
});
