import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { extractVideoUrl, expandShortLink, parseVideoUrl, createTask, createTasksBatch, findActiveTask, pickClientForTask, commandTimeoutMs, expandUpperVideos, getTask, retryTask, listTasks, resetDispatched, attachTaskScheduler, kickTaskScheduler, type FetchLike, type UpperExpandDeps } from './tasks.js';
import { registerWsBridge, type WsBridge } from './wsBridge.js';

// 测试桥注册：tasks.ts 不再 import ws/server（分层规则 server-tasks-no-upward），pushTask 经
// getWsBridge() 调 broadcastEvent——本测试不加载 ws/server，须注册 fake（no-op）桥。
const broadcast: Array<Record<string, unknown>> = [];
registerWsBridge({
  listClients: () => [],
  requestCommand: async () => ({ ok: false, code: 'offline' }),
  broadcastEvent: (msg) => { broadcast.push(msg); },
} satisfies WsBridge);

function setupDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'collector-tasks-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db); // schema.sql 含 collect_tasks 建表
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// ── extractVideoUrl：从粘贴文本提取视频 URL ──

test('extractVideoUrl：从 B 站分享文案提取 b23.tv 短链', () => {
  const text = '【我又整了个新活!】 https://b23.tv/AbCdEfG 快来看!';
  assert.equal(extractVideoUrl(text), 'https://b23.tv/AbCdEfG');
});

test('extractVideoUrl：裸 URL 直接命中', () => {
  assert.equal(extractVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD'), 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(extractVideoUrl('https://youtu.be/dQw4w9WgXcQ'), 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(extractVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('extractVideoUrl：非视频站 URL / 无 URL → null', () => {
  assert.equal(extractVideoUrl('https://example.com/foo'), null);
  assert.equal(extractVideoUrl('没有链接的纯文本'), null);
  assert.equal(extractVideoUrl(''), null);
});

// ── expandShortLink：短链跟随重定向 ──

test('expandShortLink：b23.tv 重定向到视频页（取 Response.url）', async () => {
  // Response 构造器不支持设置 url（只读,反映真实网络请求）,mock 返回带 url 字段的类 Response 对象
  const fetcher: FetchLike = async () => ({ url: 'https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.999' } as unknown as Response);
  const out = await expandShortLink('https://b23.tv/AbCdEfG', fetcher);
  assert.equal(out, 'https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.999');
});

test('expandShortLink：短链 fetch 抛错（网络失败）→ 原样返回（后续解析 400 错误可见）；res.url 空 → 兜底原 URL', async () => {
  const boom: FetchLike = async () => { throw new Error('network down'); };
  assert.equal(await expandShortLink('https://b23.tv/AbCdEfG', boom), 'https://b23.tv/AbCdEfG');
  // URL 本身非法（new URL 抛错）→ 同样原样返回
  assert.equal(await expandShortLink('不是URL', boom), '不是URL');
  const emptyUrl: FetchLike = async () => ({ url: '' } as unknown as Response);
  assert.equal(await expandShortLink('https://youtu.be/dQw4w9WgXcQ', emptyUrl), 'https://youtu.be/dQw4w9WgXcQ');
});

test('expandShortLink：非短链域名原样返回（不发请求）', async () => {
  let called = false;
  const fetcher: FetchLike = async () => { called = true; return new Response(''); };
  const out = await expandShortLink('https://www.bilibili.com/video/BV1xx411c7mD', fetcher);
  assert.equal(out, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(called, false);
});

test('expandShortLink：fetch 失败回退原 URL', async () => {
  const fetcher: FetchLike = async () => { throw new Error('network down'); };
  const out = await expandShortLink('https://b23.tv/AbCdEfG', fetcher);
  assert.equal(out, 'https://b23.tv/AbCdEfG');
});

// ── parseVideoUrl：标准 URL → 平台 + 视频 ID ──

test('parseVideoUrl：B 站 /video/BV 路径', () => {
  const t = parseVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.999');
  assert.deepEqual(t, { source: 'bilibili', source_vid: 'BV1xx411c7mD', url: 'https://www.bilibili.com/video/BV1xx411c7mD' });
});

test('parseVideoUrl：B 站 ?bvid= 查询参数', () => {
  const t = parseVideoUrl('https://www.bilibili.com/?bvid=BV1xx411c7mD');
  assert.equal(t?.source, 'bilibili');
  assert.equal(t?.source_vid, 'BV1xx411c7mD');
});

test('parseVideoUrl：YouTube watch / shorts / youtu.be / music', () => {
  assert.deepEqual(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s'), { source: 'youtube', source_vid: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.deepEqual(parseVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), { source: 'youtube', source_vid: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.deepEqual(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?si=abc'), { source: 'youtube', source_vid: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.equal(parseVideoUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ')?.source_vid, 'dQw4w9WgXcQ');
});

test('parseVideoUrl：不可识别 → null', () => {
  assert.equal(parseVideoUrl('https://b23.tv/AbCdEfG'), null); // 未展开的短链解析不出
  assert.equal(parseVideoUrl('https://www.bilibili.com/video/av170001'), null); // av 号不支持（第一阶段只支持 BV）
  assert.equal(parseVideoUrl('https://www.youtube.com/channel/UCxxx'), null);
  assert.equal(parseVideoUrl('https://example.com'), null);
  assert.equal(parseVideoUrl('不是URL'), null);
});

// ── 任务 CRUD ──

test('createTask/getTask/listTasks：建 pending 任务、按 id 倒序列出', () => {
  const { db, cleanup } = setupDb();
  try {
    const t1 = createTask(db, { source: 'bilibili', source_vid: 'BV1xx411c7mD', url: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    const t2 = createTask(db, { source: 'youtube', source_vid: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    assert.equal(t1.status, 'pending');
    assert.equal(t1.source, 'bilibili');
    assert.equal(getTask(db, t1.id)?.source_vid, 'BV1xx411c7mD');
    assert.equal(getTask(db, 99999), null);

    const { total, items } = listTasks(db, 20);
    assert.equal(total, 2);
    assert.equal(items[0].id, t2.id); // 倒序：最新在前
    assert.equal(items[1].id, t1.id);
  } finally { cleanup(); }
});

test('resetDispatched：dispatched → pending，终态不动', () => {
  const { db, cleanup } = setupDb();
  try {
    const t = createTask(db, { source: 'bilibili', source_vid: 'BV1xx411c7mD', url: 'https://x' });
    db.prepare("UPDATE collect_tasks SET status='dispatched', client_id='ext-A' WHERE id=?").run(t.id);
    const t2 = createTask(db, { source: 'youtube', source_vid: 'dQw4w9WgXcQ', url: 'https://x' });
    db.prepare("UPDATE collect_tasks SET status='succeeded', finished_at=? WHERE id=?").run(Date.now(), t2.id);

    resetDispatched(db);
    assert.equal(getTask(db, t.id)?.status, 'pending');
    assert.equal(getTask(db, t.id)?.client_id, null);
    assert.equal(getTask(db, t2.id)?.status, 'succeeded'); // 终态不受影响
  } finally { cleanup(); }
});

// ── findActiveTask：单条创建未终态去重（判据与批量端点一致）──

test('findActiveTask：pending/dispatched 命中；终态与跨 source 不命中', () => {
  const { db, cleanup } = setupDb();
  try {
    const p = createTask(db, { source: 'bilibili', source_vid: 'BV1aa411c7mD', url: 'https://x' }); // pending
    const d = createTask(db, { source: 'bilibili', source_vid: 'BV1bb411c7mD', url: 'https://x' });
    db.prepare("UPDATE collect_tasks SET status='dispatched' WHERE id=?").run(d.id);
    createTask(db, { source: 'youtube', source_vid: 'BV1cc411c7mD', url: 'https://x' }); // 同 vid 不同 source（youtube 校验宽松也可建行）

    assert.equal(findActiveTask(db, 'bilibili', 'BV1aa411c7mD')?.id, p.id); // pending 命中
    assert.equal(findActiveTask(db, 'bilibili', 'BV1bb411c7mD')?.id, d.id); // dispatched 命中
    assert.equal(findActiveTask(db, 'bilibili', 'BV1cc411c7mD'), null);     // source 域隔离（bilibili 侧无此 vid 的在途任务）
    assert.equal(findActiveTask(db, 'bilibili', 'BV1zz411c7mD'), null);     // 无任务

    // 终态允许重采：succeeded / failed 不命中
    db.prepare("UPDATE collect_tasks SET status='succeeded', finished_at=? WHERE id=?").run(Date.now(), p.id);
    db.prepare("UPDATE collect_tasks SET status='failed', error='x', finished_at=? WHERE id=?").run(Date.now(), d.id);
    assert.equal(findActiveTask(db, 'bilibili', 'BV1aa411c7mD'), null);
    assert.equal(findActiveTask(db, 'bilibili', 'BV1bb411c7mD'), null);
  } finally { cleanup(); }
});

test('findActiveTask：多条在途（异常态）取最新一条', () => {
  const { db, cleanup } = setupDb();
  try {
    const t1 = createTask(db, { source: 'bilibili', source_vid: 'BV1aa411c7mD', url: 'https://x' });
    const t2 = createTask(db, { source: 'bilibili', source_vid: 'BV1aa411c7mD', url: 'https://x' });
    assert.equal(findActiveTask(db, 'bilibili', 'BV1aa411c7mD')?.id, t2.id); // ORDER BY id DESC
    void t1;
  } finally { cleanup(); }
});

// ── createTasksBatch：批量建任务（popup/web 按 UP 批量采集）──

test('createTasksBatch：批量建 pending 任务；pending/dispatched 去重，终态允许重采', () => {
  const { db, cleanup } = setupDb();
  try {
    // 已有 pending（BV100）与 succeeded（BV200）任务
    const p = createTask(db, { source: 'bilibili', source_vid: 'BV1aa411c7mD', url: 'https://x' });
    const s = createTask(db, { source: 'bilibili', source_vid: 'BV1bb411c7mD', url: 'https://x' });
    db.prepare("UPDATE collect_tasks SET status='succeeded', finished_at=? WHERE id=?").run(Date.now(), s.id);

    const r = createTasksBatch(db, [
      p.source_vid,        // pending 去重 → skipped
      s.source_vid,        // succeeded 允许重采 → created
      'BV1cc411c7mD',      // 新建 → created
      'BV1cc411c7mD',      // 重复 → 忽略
      'av170001',          // 非 BV 格式 → 忽略
      123,                 // 非字符串 → 忽略
    ]);
    assert.equal(r.created.length, 2);
    assert.deepEqual(r.skipped, [p.source_vid]);
    assert.equal(r.created[0].source_vid, s.source_vid);
    assert.equal(r.created[0].status, 'pending');
    assert.equal(r.created[1].source_vid, 'BV1cc411c7mD');
    const { total } = listTasks(db, 20);
    assert.equal(total, 4); // 2 已有 + 2 新建
  } finally { cleanup(); }
});

test('createTasksBatch：空数组 / 非数组输入零任务', () => {
  const { db, cleanup } = setupDb();
  try {
    assert.equal(createTasksBatch(db, []).created.length, 0);
    assert.equal(createTasksBatch(db, undefined).created.length, 0);
    assert.equal(createTasksBatch(db, 'BV1aa411c7mD').created.length, 0); // 字符串非数组
  } finally { cleanup(); }
});

test('createTasksBatch：source=youtube（11 位 vid 校验 + watch URL + 独立去重域）', () => {
  const { db, cleanup } = setupDb();
  try {
    const r = createTasksBatch(db, [
      'gaDdrDdczO4',   // 合法 11 位 → created
      'gaDdrDdczO4',   // 重复 → 忽略
      'short',         // 非 11 位 → 忽略
      'BV1aa411c7mD',  // B 站 BV 串在 youtube 域非法（12 位）→ 忽略
    ], 'youtube');
    assert.equal(r.created.length, 1);
    assert.equal(r.created[0].source, 'youtube');
    assert.equal(r.created[0].source_vid, 'gaDdrDdczO4');
    assert.equal(r.created[0].url, 'https://www.youtube.com/watch?v=gaDdrDdczO4');
    // youtube 侧再次提交同 vid（pending 未终态）→ skipped
    const r3 = createTasksBatch(db, ['gaDdrDdczO4'], 'youtube');
    assert.equal(r3.created.length, 0);
    assert.deepEqual(r3.skipped, ['gaDdrDdczO4']);
  } finally { cleanup(); }
});

test('retryTask：failed/limited 原地重置回 pending（行 id/batch 不变,旧执行结果清空）', () => {
  const { db, cleanup } = setupDb();
  try {
    // 批量建两个任务 → 手工落成 failed/limited 终态（带 error/result/finished_at 残留 + 执行者）
    const r = createTasksBatch(db, ['llwTBpPqo9A', 'gaDdrDdczO4'], 'youtube');
    const [t1, t2] = r.created;
    db.prepare("UPDATE collect_tasks SET status = 'failed', error = 'YouTube 采集超时（45s）', finished_at = 123, client_id = 'ext-A' WHERE id = ?").run(t1.id);
    db.prepare("UPDATE collect_tasks SET status = 'limited', result = '{\"reason\":\"pot_limited\"}', finished_at = 456 WHERE id = ?").run(t2.id);

    // 重试：原行重置回 pending——行 id 不变（批次卡/聚焦视图随该行更新,不出现 failed+succeeded 双行）
    const rt = retryTask(db, t1.id);
    assert.equal(rt!.id, t1.id);
    assert.equal(rt!.status, 'pending');
    assert.equal(rt!.batch_id, t1.batch_id); // batch_id 保留原值（重试不换批不换行）
    assert.equal(rt!.client_id, 'ext-A');    // 上次执行者保留（重试优先派回原扩展的线索）
    assert.equal(rt!.error, null);       // 旧失败原因清空
    assert.equal(rt!.finished_at, null); // 旧完成时间清空
    const rl = retryTask(db, t2.id);
    assert.equal(rl!.status, 'pending');
    assert.equal(rl!.result, null);      // 旧受限回执清空

    // 聚焦视图按原批次筛：成员数不变（重试不膨胀批次——旧「并入原批」方案会 +1 行）
    const focus = listTasks(db, 50, 0, { batchId: t1.batch_id! });
    assert.equal(focus.items.length, 2);
    assert.ok(focus.items.every((t) => t.status === 'pending'));
  } finally { cleanup(); }
});

test('retryTask：succeeded/pending/dispatched/不存在 均拒绝（返回 null,行不动）', () => {
  const { db, cleanup } = setupDb();
  try {
    const r = createTasksBatch(db, ['llwTBpPqo9A', 'gaDdrDdczO4', 'F3lL98Pj90o'], 'youtube');
    const [s, p, d] = r.created;
    db.prepare("UPDATE collect_tasks SET status = 'succeeded', result = '{}' , finished_at = 1 WHERE id = ?").run(s.id);
    db.prepare("UPDATE collect_tasks SET status = 'dispatched', client_id = 'ext-A' WHERE id = ?").run(d.id);
    // succeeded 重采走建新任务（保留成功历史）;pending/dispatched 在途不可重入;未知 id 不存在
    assert.equal(retryTask(db, s.id), null);
    assert.equal(retryTask(db, p.id), null);
    assert.equal(retryTask(db, d.id), null);
    assert.equal(retryTask(db, 99999), null);
    for (const t of [s, p, d]) {
      const row = getTask(db, t.id)!;
      assert.equal(row.status, t.id === s.id ? 'succeeded' : t.id === d.id ? 'dispatched' : 'pending');
    }
  } finally { cleanup(); }
});

test('retryTask：库内已有字幕轨 → 直接置 succeeded 免重采（不重置 pending 不派发）', () => {
  const { db, cleanup } = setupDb();
  try {
    // 视频已入库且有 1 轨字幕,任务行挂在 failed（回执迟到/超时误杀但扩展实际落库的场景）
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'llwTBpPqo9A', title: '已落库', creator: { source_uid: 'uc123', name: 'UP' }, extra: {}, duration: 100, published_at: 1 },
      tracks: [{ lan: 'en', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://a' }] }],
    });
    const t = createTask(db, { source: 'youtube', source_vid: 'llwTBpPqo9A', url: 'https://www.youtube.com/watch?v=llwTBpPqo9A' });
    db.prepare("UPDATE collect_tasks SET status = 'failed', error = 'YouTube 采集超时（45s）', finished_at = 1 WHERE id = ?").run(t.id);

    const rt = retryTask(db, t.id)!;
    assert.equal(rt.status, 'succeeded'); // 短路：库内有轨直接成功,不重新采集
    assert.ok(rt.finished_at != null);
    const r = JSON.parse(rt.result!) as { reason: string; tracks: number };
    assert.equal(r.reason, 'already_collected');
    assert.equal(r.tracks, 1);

    // limited = 0 轨入库：库内无轨不会被短路 → 正常重置 pending 重新采集
    const t2 = createTask(db, { source: 'youtube', source_vid: 'gaDdrDdczO4', url: 'https://www.youtube.com/watch?v=gaDdrDdczO4' });
    db.prepare("UPDATE collect_tasks SET status = 'limited', finished_at = 1 WHERE id = ?").run(t2.id);
    assert.equal(retryTask(db, t2.id)!.status, 'pending');
  } finally { cleanup(); }
});

// ── expandUpperVideos：经扩展 WS 代理拉 UP 全量列表 + 标注已采 ──

// fake requestCommand：模拟真实扩展契约（background.js list-upper-videos action 读
// msg.page / msg.page_size，缺省回落 pn=1 / ps=30）。回归 BUG（2026-08-19）：server 曾发明
// pn/ps 参数名 → 扩展永远收到 page=undefined → 每页都回第 1 页 → 列表 30 条重复 N 遍。
function fakePagedCommand(pages: Record<number, any>): UpperExpandDeps {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  return {
    listClients: () => [{ client_id: 'ext-A' }],
    requestCommand: async (_cid, action, params) => {
      calls.push({ action, params });
      const page = Number(params.page ?? 1); // 对齐真实扩展：page 缺省 = 第 1 页
      const data = pages[page];
      if (!data) return { ok: false, code: 'timeout' as const };
      return { ok: true, result: { ok: true, data } };
    },
    sleep: async () => {}, // 测试不等待节流
    pageGapMs: 0,
    // @ts-expect-error 测试探针：透出调用记录
    calls,
  };
}

test('expandUpperVideos：分页循环拉全量（page 参数对齐扩展契约）+ 已采标注', async () => {  const { db, cleanup } = setupDb();
  try {
    // 库里已有 BV2（该 UP 已采 1 条）
    db.prepare("INSERT INTO creators (source, source_uid, name, first_seen_at, updated_at) VALUES ('bilibili', '296399504', 'UP甲', 1, 1)").run();
    const cid = (db.prepare("SELECT id FROM creators WHERE source_uid='296399504'").get() as { id: number }).id;
    db.prepare("INSERT INTO videos (source, source_vid, creator_id, title, first_seen_at, updated_at) VALUES ('bilibili', 'BV2xx411c7mD', ?, '已采视频', 1, 1)").run(cid);

    const deps = fakePagedCommand({
      1: { total: 3, items: [
        { bvid: 'BV1xx411c7mD', title: '视频一', created: 1700000000, play: 100, length: '5:30', pic: '//i0.hdslb.com/bfs/a.jpg' },
        { bvid: 'BV2xx411c7mD', title: '已采视频', created: 1700000100, play: 200, length: '6:00', pic: 'https://i0.hdslb.com/bfs/b.jpg' },
      ] },
      2: { total: 3, items: [
        { bvid: 'BV3xx411c7mD', title: '视频三', created: 1700000200, play: 300, length: '7:00' }, // 无 pic → null
      ] },
    });
    const r = await expandUpperVideos(db, { source: 'bilibili', mid: '296399504' }, deps);
    assert.equal(r.total, 3);
    assert.equal(r.items.length, 3);
    assert.deepEqual(r.items.map((x) => x.collected), [false, true, false]);
    assert.equal(r.items[0].title, '视频一');
    // 封面透传："//" 协议头相对形式归一 https:；完整 URL 原样；缺失 → null
    assert.deepEqual(r.items.map((x) => x.pic), ['https://i0.hdslb.com/bfs/a.jpg', 'https://i0.hdslb.com/bfs/b.jpg', null]);
    // 分页正确（契约）：两次调用分别带 page=1 / page=2
    const calls = (deps as any).calls as Array<{ action: string; params: Record<string, unknown> }>;
    assert.equal(calls.length, 2);
    assert.equal(calls[0].params.page, 1);
    assert.equal(calls[1].params.page, 2);
  } finally { cleanup(); }
});

test('expandUpperVideos：分页重叠（页间新投稿位移）按 bvid 去重 + 连续无新页终止', async () => {
  const { db, cleanup } = setupDb();
  try {
    // 第 1 页 A+B；第 2 页重复 B（位移重叠）+ C；第 3 页起全重复 → 无新页终止，不死循环
    const page1 = [
      { bvid: 'BV1aa411c7mD', title: 'A', created: 1, play: 1, length: '1:00' },
      { bvid: 'BV1bb411c7mD', title: 'B', created: 2, play: 2, length: '2:00' },
    ];
    const deps = fakePagedCommand({
      1: { total: 3, items: page1 },
      2: { total: 3, items: [
        { bvid: 'BV1bb411c7mD', title: 'B', created: 2, play: 2, length: '2:00' }, // 重叠
        { bvid: 'BV1cc411c7mD', title: 'C', created: 3, play: 3, length: '3:00' },
      ] },
      // 第 3 页起返回 page1 的重复（模拟扩展回落/风控下的重复页）
      3: { total: 3, items: page1 },
      4: { total: 3, items: page1 },
      5: { total: 3, items: page1 },
    });
    const r = await expandUpperVideos(db, { source: 'bilibili', mid: '296399504' }, deps);
    const bvids = r.items.map((x) => x.bvid);
    assert.equal(new Set(bvids).size, bvids.length, '结果必须无重复 bvid');
    assert.deepEqual(bvids.sort(), ['BV1aa411c7mD', 'BV1bb411c7mD', 'BV1cc411c7mD']);
  } finally { cleanup(); }
});

test('expandUpperVideos：扩展离线抛错；单页回执失败抛错', async () => {
  const { db, cleanup } = setupDb();
  try {
    await assert.rejects(
      expandUpperVideos(db, { source: 'bilibili', mid: '296399504' }, { listClients: () => [], requestCommand: async () => ({ ok: false, code: 'offline' as const }), sleep: async () => {} }),
      /扩展离线/,
    );
    await assert.rejects(
      expandUpperVideos(db, { source: 'bilibili', mid: '296399504' }, {
        listClients: () => [{ client_id: 'ext-A' }],
        requestCommand: async () => ({ ok: true, result: { ok: false, error: 'arc/search -412' } }),
        sleep: async () => {},
      }),
      /-412/,
    );
  } finally { cleanup(); }
});

// ── YouTube 频道展开（2026-08-24 web 批量入口）：一次 list-yt-channel-videos 全量回执 ──
// 断言：vid→bvid 映射、collected 按 youtube 命中、creator 最小行落库（不存在时）、channel 回传。
test('expandUpperVideos YouTube：全量回执映射 + collected 标注 + creator 最小行 + channel 回传', async () => {
  const { db, cleanup } = setupDb();
  try {
    // 库里已有 ytvid1（该频道已采 1 条）
    db.prepare("INSERT INTO creators (source, source_uid, name, first_seen_at, updated_at) VALUES ('youtube', 'UCtest_channel_id_000001', '频道已有行', 1, 1)").run();
    const cid = (db.prepare("SELECT id FROM creators WHERE source_uid='UCtest_channel_id_000001'").get() as { id: number }).id;
    db.prepare("INSERT INTO videos (source, source_vid, creator_id, title, first_seen_at, updated_at) VALUES ('youtube', 'ytvid00001', ?, '已采', 1, 1)").run(cid);

    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const deps: UpperExpandDeps = {
      listClients: () => [{ client_id: 'ext-A' }],
      requestCommand: async (_cid, action, params) => {
        calls.push({ action, params });
        return {
          ok: true as const,
          result: { ok: true, data: {
            channel_id: 'UCtest_channel_id_000001',
            channel_name: '测试频道',
            total: 2,
            items: [
              { vid: 'ytvid00001', title: '已采', created: 1700000000, play: 100, length: '5:30' },
              { vid: 'ytvid00002', title: '未采', created: 1700000100, play: 200, length: '6:00' },
            ],
          } },
        };
      },
      sleep: async () => {},
    };
    const r = await expandUpperVideos(db, { source: 'youtube', ident: { channelId: 'UCtest_channel_id_000001' } }, deps);
    assert.equal(r.total, 2);
    assert.deepEqual(r.items.map((x) => x.bvid), ['ytvid00001', 'ytvid00002']);
    assert.deepEqual(r.items.map((x) => x.collected), [true, false]);
    assert.deepEqual(r.channel, { id: 'UCtest_channel_id_000001', name: '测试频道' });
    // 契约：action=list-yt-channel-videos + ident 透传 + refresh=true（web 展开绕过 1h 缓存）
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'list-yt-channel-videos');
    assert.deepEqual(calls[0].params.ident, { channelId: 'UCtest_channel_id_000001' });
    assert.equal(calls[0].params.refresh, true);
    // creator 已存在 → 名字不被覆盖（最小行只建不更新）
    assert.equal((db.prepare("SELECT name FROM creators WHERE source_uid='UCtest_channel_id_000001'").get() as { name: string }).name, '频道已有行');
  } finally { cleanup(); }
});

test('expandUpperVideos YouTube：creator 不存在 → 落最小行（批量任务的 UP 筛选归属）；回执失败抛错', async () => {
  const { db, cleanup } = setupDb();
  try {
    const deps: UpperExpandDeps = {
      listClients: () => [{ client_id: 'ext-A' }],
      requestCommand: async () => ({
        ok: true as const,
        result: { ok: true, data: { channel_id: 'UCnew_channel_id_0000002', channel_name: '新频道', total: 1, items: [{ vid: 'ytvid0000A', title: 'x' }] } },
      }),
      sleep: async () => {},
    };
    await expandUpperVideos(db, { source: 'youtube', ident: { handle: '@newch' } }, deps);
    const row = db.prepare("SELECT source, name FROM creators WHERE source_uid='UCnew_channel_id_0000002'").get() as { source: string; name: string };
    assert.deepEqual(row, { source: 'youtube', name: '新频道' });

    await assert.rejects(
      expandUpperVideos(db, { source: 'youtube', ident: { handle: '@bad' } }, {
        listClients: () => [{ client_id: 'ext-A' }],
        requestCommand: async () => ({ ok: true, result: { ok: false, error: 'yt-channel 拉取失败' } }),
        sleep: async () => {},
      }),
      /拉取失败/,
    );
  } finally { cleanup(); }
});

// ── expandUpperVideos 客户端选择（2026-08-23 任务派发池）：优先可派池，池空回退任意在线 ──

test('expandUpperVideos：优先选接受任务派发的客户端（批量编排落在采集机，不占仅上报客户端）', async () => {
  const { db, cleanup } = setupDb();
  try {
    const used: string[] = [];
    const deps: UpperExpandDeps = {
      // 仅上报客户端排在首位：也不能被 clients[0] 直选（它是用户的日常机，列表拉取的
      // B 站 API 配额/风控压力应落在专职采集机上）
      listClients: () => [{ client_id: 'ext-off', task_dispatch_enabled: false }, { client_id: 'ext-on' }],
      requestCommand: async (cid) => {
        used.push(cid);
        return { ok: true, result: { ok: true, data: { total: 1, items: [{ bvid: 'BV1xx411c7mD', title: 't' }] } } };
      },
      sleep: async () => {},
      pageGapMs: 0,
    };
    const r = await expandUpperVideos(db, { source: 'bilibili', mid: '296399504' }, deps);
    assert.equal(r.total, 1);
    assert.deepEqual(used, ['ext-on'], '应选可派池内的 ext-on 而非首位的 ext-off');
  } finally { cleanup(); }
});

test('expandUpperVideos：池空（全仅上报）回退任意在线（纯 API 查询无标签页干扰，不必拒绝）', async () => {
  const { db, cleanup } = setupDb();
  try {
    const used: string[] = [];
    const deps: UpperExpandDeps = {
      listClients: () => [{ client_id: 'ext-off', task_dispatch_enabled: false }],
      requestCommand: async (cid) => {
        used.push(cid);
        return { ok: true, result: { ok: true, data: { total: 1, items: [{ bvid: 'BV1xx411c7mD', title: 't' }] } } };
      },
      sleep: async () => {},
      pageGapMs: 0,
    };
    const r = await expandUpperVideos(db, { source: 'bilibili', mid: '296399504' }, deps);
    assert.equal(r.total, 1);
    assert.deepEqual(used, ['ext-off'], '唯一在线客户端虽仅上报，列表查询仍可用它');
  } finally { cleanup(); }
});

// ── pickClientForTask：任务归属（2026-08-21 多客户端 sticky;2026-08-22 加上次执行者软偏好）──
// 语义：creator 在线 → 永远归 creator（忙则 wait 本轮跳过，不给别人）；无 creator →
// 上次执行者在线且空闲 → 回原扩展（忙/离线不等待）→ 都没有 → 任意空闲。
// 2026-08-23 加任务派发池：仅上报（task_dispatch_enabled=false）客户端不入池——
// creator/执行者/任意空闲三级选择全在池内进行；字段缺省视为接受（旧扩展 fail-open）。

test('pickClientForTask：creator 在线 → 归 creator（即便别人空闲/曾是执行者）', () => {
  const clients = [{ client_id: 'ext-A' }, { client_id: 'ext-B' }];
  assert.deepEqual(pickClientForTask({ creator_client_id: 'ext-B', client_id: 'ext-A' }, clients, new Map()), { clientId: 'ext-B' });
});

test('pickClientForTask：creator 在线但忙 → wait（不给别人）', () => {
  const clients = [{ client_id: 'ext-A' }, { client_id: 'ext-B' }];
  assert.equal(pickClientForTask({ creator_client_id: 'ext-B', client_id: null }, clients, new Map([['ext-B', 7]])), 'wait');
});

test('pickClientForTask：creator 离线 → 降级上次执行者/任意空闲', () => {
  const clients = [{ client_id: 'ext-A' }];
  assert.deepEqual(pickClientForTask({ creator_client_id: 'ext-X', client_id: null }, clients, new Map()), { clientId: 'ext-A' });
});

test('pickClientForTask：无 creator、上次执行者在线空闲 → 优先回原扩展（重试不换环境）', () => {
  const clients = [{ client_id: 'ext-A' }, { client_id: 'ext-B' }];
  // 上次执行者 ext-B 不在列表首位——仍应选它（软偏好,非任意空闲的 find-first）
  assert.deepEqual(pickClientForTask({ creator_client_id: null, client_id: 'ext-B' }, clients, new Map()), { clientId: 'ext-B' });
});

test('pickClientForTask：上次执行者忙 → 回落任意空闲（软偏好不 wait 不空转）', () => {
  const clients = [{ client_id: 'ext-A' }, { client_id: 'ext-B' }];
  assert.deepEqual(pickClientForTask({ creator_client_id: null, client_id: 'ext-B' }, clients, new Map([['ext-B', 9]])), { clientId: 'ext-A' });
});

test('pickClientForTask：上次执行者离线 → 任意空闲', () => {
  const clients = [{ client_id: 'ext-A' }];
  assert.deepEqual(pickClientForTask({ creator_client_id: null, client_id: 'ext-X' }, clients, new Map()), { clientId: 'ext-A' });
});

test('pickClientForTask：无 creator 无执行者（CLI/旧任务）→ 任意空闲（现状语义）', () => {
  const clients = [{ client_id: 'ext-A' }, { client_id: 'ext-B' }];
  assert.deepEqual(pickClientForTask({ creator_client_id: null, client_id: null }, clients, new Map()), { clientId: 'ext-A' });
});

test('pickClientForTask：全忙 → null', () => {
  assert.equal(pickClientForTask({ creator_client_id: null, client_id: 'ext-A' }, [{ client_id: 'ext-A' }], new Map([['ext-A', 1]])), null);
});

// ── 任务派发池（2026-08-23 仅上报状态）：仅上报客户端从三级选择中全部剔除 ──

test('pickClientForTask：creator 仅上报 → 视同不可派，回落任意空闲（不 wait）', () => {
  // 关掉接任务的意图就是「别在我这台跑」——任务该去别的机器，而非等创建者恢复
  const clients = [{ client_id: 'ext-A', task_dispatch_enabled: false }, { client_id: 'ext-B' }];
  assert.deepEqual(pickClientForTask({ creator_client_id: 'ext-A', client_id: null }, clients, new Map()), { clientId: 'ext-B' });
});

test('pickClientForTask：上次执行者仅上报 → 回落任意空闲（软偏好不越权）', () => {
  const clients = [{ client_id: 'ext-A' }, { client_id: 'ext-B', task_dispatch_enabled: false }];
  assert.deepEqual(pickClientForTask({ creator_client_id: null, client_id: 'ext-B' }, clients, new Map()), { clientId: 'ext-A' });
});

test('pickClientForTask：仅上报客户端不被「任意空闲」选中（跳过取池内首个）', () => {
  const clients = [
    { client_id: 'ext-A', task_dispatch_enabled: false },
    { client_id: 'ext-B', task_dispatch_enabled: false },
    { client_id: 'ext-C' },
  ];
  assert.deepEqual(pickClientForTask({ creator_client_id: null, client_id: null }, clients, new Map()), { clientId: 'ext-C' });
});

test('pickClientForTask：全部仅上报 → null（任务留 pending 等恢复，对齐扩展全离线行为）', () => {
  const clients = [{ client_id: 'ext-A', task_dispatch_enabled: false }];
  assert.equal(pickClientForTask({ creator_client_id: 'ext-A', client_id: null }, clients, new Map()), null);
});

test('pickClientForTask：字段缺省（旧扩展 hello 不带 / 测试 mock 只给 client_id）→ 视为接受', () => {
  const clients = [{ client_id: 'ext-A' }, { client_id: 'ext-B', task_dispatch_enabled: true }];
  assert.deepEqual(pickClientForTask({ creator_client_id: 'ext-A', client_id: null }, clients, new Map()), { clientId: 'ext-A' });
});

test('createTasksBatch：creator_client_id 透传到任务行；不传为 null', () => {
  const { db, cleanup } = setupDb();
  try {
    const r = createTasksBatch(db, ['BV1dd411c7mD'], 'bilibili', 'ext-A');
    assert.equal(r.created[0].creator_client_id, 'ext-A');
    const r2 = createTasksBatch(db, ['BV1ee411c7mD']);
    assert.equal(r2.created[0].creator_client_id, null);
  } finally { cleanup(); }
});

// ── commandTimeoutMs：按平台分档的执行预算（覆盖扩展全链路，防假失败）──
test('commandTimeoutMs：youtube 长预算（后台 tab+自限+宽限）、bilibili 短预算', () => {
  assert.equal(commandTimeoutMs('youtube'), 180_000);
  assert.equal(commandTimeoutMs('bilibili'), 90_000);
});

test('commandTimeoutMs：随 settings 配置联动（youtube 预算 = 无进展窗口 + 135s 余量）', () => {
  const t = { bilibili: 120_000, youtube: 90_000 };
  assert.equal(commandTimeoutMs('youtube', t), 225_000); // 90s 窗口 + 135s 余量（关 tab/INGEST）
  assert.equal(commandTimeoutMs('bilibili', t), 120_000); // B 站直接用配置预算（API 拉取无自限）
});

// ── listTasks 多维筛选（2026-08-22 历史页）：creator/q 是入库元数据维度 ──
// 契约：未入库任务（无 videos 行）无 UP/标题归属，creator/q 筛不中；status/source/since/
// until/batchId 走 t.* 列覆盖未入库任务。批次补全：筛选只作用种子，种子涉及的批次成员
// 全量带出（「n/m 完成」分母完整，与 status 跨状态拉齐语义一致）。

// 样本：2 UP（Alpha uid=1 / Beta uid=11，防 uid '1' LIKE 误匹配 '11'），2 已入库视频 +
// 4 未入库任务（含 3 条批次 B）。created_at 全部 INSERT 直写为确定值（T 基准毫秒）。
function setupFilterDb(): {
  db: Database.Database; cleanup: () => void;
  ids: { alphaBatch: number; nobat1: number; nobat2: number; beta: number; nolib: number; yt: number };
} {
  const { db, cleanup } = setupDb();
  const T = 1_700_000_000_000;
  const ing = (sv: string, title: string, uid: string, name: string) =>
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: sv, title, creator: { source_uid: uid, name }, extra: {}, duration: 100, published_at: T },
      tracks: [],
    });
  ing('BV1ALPHA0001', 'Alpha 视频一', '1', 'Alpha UP');   // uid '1'
  ing('BV1BETA00001', 'Beta 视频标题', '11', 'Beta UP');  // uid '11'（防误匹配回归样本）

  // 任务行直插（绕开 createTask 的 Date.now()；created_at 确定性）
  const ins = db.prepare(
    'INSERT INTO collect_tasks (source, source_vid, url, status, created_at, batch_id, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const run = (source: string, sv: string, status: string, createdAt: number, batchId: string | null) => {
    const url = source === 'youtube' ? `https://www.youtube.com/watch?v=${sv}` : `https://www.bilibili.com/video/${sv}`;
    const fin = status === 'succeeded' || status === 'failed' ? createdAt + 10_000 : null;
    return Number(ins.run(source, sv, url, status, createdAt, batchId, fin).lastInsertRowid);
  };
  const ids = {
    alphaBatch: run('bilibili', 'BV1ALPHA0001', 'succeeded', T + 4000, 'batch-test-1'), // 已入库（Alpha）批次成员
    nobat1: run('bilibili', 'BV1NOBAT001x', 'pending', T + 5000, 'batch-test-1'),       // 未入库批次成员
    nobat2: run('bilibili', 'BV1NOBAT002x', 'failed', T + 6000, 'batch-test-1'),        // 未入库批次成员
    beta: run('bilibili', 'BV1BETA00001', 'succeeded', T + 2000, null),                 // 已入库（Beta）单任务
    nolib: run('bilibili', 'BV1NOLIB0001', 'pending', T + 3000, null),                  // 未入库单任务
    yt: run('youtube', 'dQw4w9WgXcQ', 'failed', T + 7000, null),                        // 未入库 youtube 任务
  };
  return { db, cleanup, ids };
}

const vids = (items: Array<{ source_vid: string }>) => items.map((i) => i.source_vid);

test('listTasks 多维：creator 名字模糊（LIKE 命中/不命中）', () => {
  const { db, cleanup, ids } = setupFilterDb();
  try {
    const alpha = listTasks(db, 50, 0, { creator: 'Alpha' });
    assert.equal(alpha.total, 1);                          // 种子：只有已入库的 alpha 批次成员
    assert.ok(alpha.items.some((t) => t.id === ids.alphaBatch));       // 种子在结果里（items 按id desc,补全成员可能在前）
    assert.deepEqual(vids(alpha.items).sort(), ['BV1ALPHA0001', 'BV1NOBAT001x', 'BV1NOBAT002x'].sort()); // 批次补全拉齐整批

    const beta = listTasks(db, 50, 0, { creator: 'Beta' });
    assert.equal(beta.total, 1);
    assert.equal(beta.items[0].id, ids.beta);              // 单任务无批次,无补全

    assert.equal(listTasks(db, 50, 0, { creator: '不存在' }).total, 0);
  } finally { cleanup(); }
});

test('listTasks 多维：creator_uid 精确（uid "1" 不误匹配 "11"）', () => {
  const { db, cleanup, ids } = setupFilterDb();
  try {
    const by1 = listTasks(db, 50, 0, { creatorUid: '1' });
    assert.equal(by1.total, 1);
    assert.equal(by1.items.find((t) => t.id === ids.alphaBatch)!.source_vid, 'BV1ALPHA0001'); // 精确 uid=1，不命中 Beta(uid=11)

    const by11 = listTasks(db, 50, 0, { creatorUid: '11' });
    assert.equal(by11.total, 1);
    assert.equal(by11.items[0].source_vid, 'BV1BETA00001');
  } finally { cleanup(); }
});

test('listTasks 多维：未入库任务契约——标题维度筛不中/UP 归属列筛得中，t.* 列维度覆盖', () => {
  const { db, cleanup, ids } = setupFilterDb();
  try {
    // q 按库内标题：命中 alpha 视频标题
    assert.equal(listTasks(db, 50, 0, { q: 'Alpha 视频' }).total, 1);
    // q 的 vid 段匹配 t.source_vid：未入库任务按 BV 号/vid 搜得中（2026-08-22 补：按 BV 号找任务）
    assert.equal(listTasks(db, 50, 0, { q: 'NOLIB' }).total, 1);
    assert.equal(listTasks(db, 50, 0, { q: 'dQw4w9WgXcQ' }).total, 1);
    // q 的标题维度不含未入库任务：无归属无标题的任务用「词不在任何标题里」验证
    assert.equal(listTasks(db, 50, 0, { q: '根本不存在的标题词' }).total, 0);
    // creator 筛选不含未入库任务（setupFilterDb 直插的任务行 creator_uid 为 NULL，无 UP 归属）
    const alpha = listTasks(db, 50, 0, { creator: 'Alpha' });
    assert.ok(!alpha.items.some((t) => t.id === ids.nolib || t.id === ids.yt));

    // t.* 列维度覆盖未入库任务
    const pend = listTasks(db, 50, 0, { status: ['pending'] });
    assert.equal(pend.total, 2);                                 // nolib + nobat1（批次成员）
    assert.deepEqual(vids(pend.items).sort(), ['BV1NOLIB0001', 'BV1NOBAT001x', 'BV1ALPHA0001', 'BV1NOBAT002x'].sort()); // 补全带出批次其余成员
    const yt = listTasks(db, 50, 0, { source: 'youtube' });
    assert.equal(yt.total, 1);
    assert.equal(yt.items[0].id, ids.yt);                        // 未入库 youtube 任务按平台筛得中
    assert.equal(listTasks(db, 50, 0, { source: 'bilibili' }).total, 5);
  } finally { cleanup(); }
});

test('listTasks 多维：batchScope 批量/单点过滤（batch_id 空/非空，t.* 列覆盖未入库任务）', () => {
  const { db, cleanup, ids } = setupFilterDb();
  try {
    // batch：只留批次成员（3 条 batch-test-1），与状态组合时补全跨状态拉齐整批
    const batch = listTasks(db, 50, 0, { batchScope: 'batch' });
    assert.equal(batch.total, 3);
    assert.deepEqual(vids(batch.items).sort(), ['BV1ALPHA0001', 'BV1NOBAT001x', 'BV1NOBAT002x'].sort());

    // single：只留单点任务（含未入库的 nolib/yt；种子无批次 → 无补全）
    const single = listTasks(db, 50, 0, { batchScope: 'single' });
    assert.equal(single.total, 3);
    assert.deepEqual(vids(single.items).sort(), ['BV1BETA00001', 'BV1NOLIB0001', 'dQw4w9WgXcQ'].sort());

    // 与状态维度组合：pending 的单点任务只有 nolib（nobat1 是 pending 但属批次）
    const pendingSingle = listTasks(db, 50, 0, { batchScope: 'single', status: ['pending'] });
    assert.equal(pendingSingle.total, 1);
    assert.equal(pendingSingle.items[0].id, ids.nolib);
  } finally { cleanup(); }
});

test('listTasks 富化：creator_source_uid 回填（任务卡 UP 外链）——入库/任务行/无归属三路径', () => {
  const { db, cleanup, ids } = setupFilterDb();
  try {
    // 未入库但任务行带 creator_uid（popup 按 UP 批量的形态）
    const withUid = createTasksBatch(db, ['BV1UIDBAT01x'], 'bilibili', null, '11');
    const { items } = listTasks(db, 50, 0, {});
    assert.equal(items.find((t) => t.id === ids.alphaBatch)!.creator_source_uid, '1');          // 已入库：videos→creators
    assert.equal(items.find((t) => t.id === withUid.created[0].id)!.creator_source_uid, '11'); // 未入库：t.creator_uid 冗余列兜底
    assert.equal(items.find((t) => t.id === ids.nolib)!.creator_source_uid, null);             // 无归属：null
  } finally { cleanup(); }
});

test('listTasks 多维：任务行 creator_uid 冗余列——未入库/失败任务按 UP 筛得中（盲区修复）', () => {
  const { db, cleanup } = setupFilterDb();
  try {
    // 模拟「popup 按 UP 批量」：显式 creator_uid 建批次（视频未入库，任务直接带归属）
    const batch = createTasksBatch(db, ['BV1NEWBAT01x', 'BV1NEWBAT02x'], 'bilibili', null, '1');
    assert.equal(batch.created.length, 2);
    for (const t of batch.created) assert.equal(t.creator_uid, '1'); // 建任务即带归属

    // 未入库任务（creator_uid=1）经冗余列筛得中：creator 精确 + 名字模糊（经 ct 关联资料行）
    const byUid = listTasks(db, 50, 0, { creatorUid: '1' });
    assert.ok(byUid.items.some((t) => t.source_vid === 'BV1NEWBAT01x'));
    assert.ok(byUid.items.some((t) => t.source_vid === 'BV1ALPHA0001')); // 已入库 alpha 同归属也命中
    const byName = listTasks(db, 50, 0, { creator: 'Alpha' });
    assert.ok(byName.items.some((t) => t.source_vid === 'BV1NEWBAT01x')); // 名字模糊经 ct.name 命中未入库行
    // 回显：未入库但资料行在库（P2 采过）→ creator_name 有值
    const row = byName.items.find((t) => t.source_vid === 'BV1NEWBAT01x')!;
    assert.equal(row.creator_name, 'Alpha UP');
    assert.equal(row.title, null); // 未入库 title 仍 null

    // uid '1' 不误匹配 '11'（冗余列精确等值）
    const by11 = listTasks(db, 50, 0, { creatorUid: '11' });
    assert.ok(!by11.items.some((t) => t.source_vid === 'BV1NEWBAT01x'));
  } finally { cleanup(); }
});

test('createTask 建任务查库回填 creator_uid（重采场景：视频已入库，新任务立即可按 UP 筛）', () => {
  const { db, cleanup } = setupFilterDb();
  try {
    // BV1BETA00001 已入库（uid '11'）→ 重采建任务自动带归属（失败重试场景的关键路径）
    const t = createTask(db, { source: 'bilibili', source_vid: 'BV1BETA00001', url: 'https://x' });
    assert.equal(t.creator_uid, '11');
    // 未入库视频建任务：无归属可查 → null
    const t2 = createTask(db, { source: 'bilibili', source_vid: 'BV1NEVERSEEN', url: 'https://x' });
    assert.equal(t2.creator_uid, null);
    // 显式 creatorUid 优先于查库（合集视频属于别人合集但提交方已知 UP 的场景由调用方保证）
    const t3 = createTask(db, { source: 'bilibili', source_vid: 'BV1ALPHA0001', url: 'https://x' }, null, null, '999');
    assert.equal(t3.creator_uid, '999');
  } finally { cleanup(); }
});

test('ingestVideo 回填任务行 creator_uid（先建任务后入库：pending 行获得归属）', () => {
  const { db, cleanup } = setupFilterDb();
  try {
    // 未入库视频先建任务（无归属），再 ingest → 任务行回填归属
    createTask(db, { source: 'bilibili', source_vid: 'BV1LATEING001', url: 'https://x' });
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1LATEING001', title: '迟到入库', creator: { source_uid: '11', name: 'Beta UP' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [],
    });
    const row = db.prepare("SELECT creator_uid FROM collect_tasks WHERE source_vid = 'BV1LATEING001'").get() as { creator_uid: string | null };
    assert.equal(row.creator_uid, '11');
    // 已有显式归属的行不被覆盖（COALESCE 语义：只补 NULL）
    createTask(db, { source: 'bilibili', source_vid: 'BV1KEEPUID001', url: 'https://x' }, null, null, '999');
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1KEEPUID001', title: '保持显式', creator: { source_uid: '11', name: 'Beta UP' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [],
    });
    const row2 = db.prepare("SELECT creator_uid FROM collect_tasks WHERE source_vid = 'BV1KEEPUID001'").get() as { creator_uid: string | null };
    assert.equal(row2.creator_uid, '999');
  } finally { cleanup(); }
});

test('迁移 v11：存量任务行按库内归属回填 creator_uid', () => {
  const { db, cleanup } = setupFilterDb();
  try {
    // setupFilterDb 用 migrate() 建库（新 schema 自带列），回填 UPDATE 会在 runMigrations 之外——
    // 手动重放 v11 回填语句验证语义（幂等：再跑一次不改变已有值）
    db.prepare(`UPDATE collect_tasks
       SET creator_uid = (SELECT c.source_uid FROM videos v JOIN creators c ON c.id = v.creator_id
                          WHERE v.source = collect_tasks.source AND v.source_vid = collect_tasks.source_vid)
       WHERE creator_uid IS NULL`).run();
    const alphaRow = db.prepare("SELECT creator_uid FROM collect_tasks WHERE source_vid = 'BV1ALPHA0001'").get() as { creator_uid: string | null };
    const nolibRow = db.prepare("SELECT creator_uid FROM collect_tasks WHERE source_vid = 'BV1NOLIB0001'").get() as { creator_uid: string | null };
    assert.equal(alphaRow.creator_uid, '1');     // 已入库 → 回填归属
    assert.equal(nolibRow.creator_uid, null);    // 未入库 → 无归属可补
  } finally { cleanup(); }
});

test('listTasks 多维：since/until 边界（毫秒，含边界值）', () => {
  const { db, cleanup } = setupFilterDb();
  try {
    const T = 1_700_000_000_000;
    const mid = listTasks(db, 50, 0, { since: T + 2500, until: T + 3500 }); // 窗口不沾批次（4000+）
    assert.equal(mid.total, 1);
    assert.equal(mid.items[0].source_vid, 'BV1NOLIB0001');

    assert.equal(listTasks(db, 50, 0, { since: T + 3000 }).total, 5); // 含边界：nolib(3000)+alphaBatch(4000)+nobat1(5000)+nobat2(6000)+yt(7000)
    assert.equal(listTasks(db, 50, 0, { until: T + 2000 }).total, 1); // 含边界：beta(2000)
  } finally { cleanup(); }
});

test('listTasks 多维：batchId 聚焦（total=批成员数，单批分页补全语义）', () => {
  const { db, cleanup } = setupFilterDb();
  try {
    const all = listTasks(db, 50, 0, { batchId: 'batch-test-1' });
    assert.equal(all.total, 3);                                  // WHERE 计数 = 批成员数
    assert.equal(all.items.length, 3);                           // 种子=整批，补全 no-op

    // 单批分页：limit=2 切种子，补全仍拉齐整批（跨页重复展示是既定语义，与 status 筛选一致）
    const p1 = listTasks(db, 2, 0, { batchId: 'batch-test-1' });
    assert.equal(p1.total, 3);
    assert.equal(p1.items.length, 3);
    const p2 = listTasks(db, 2, 2, { batchId: 'batch-test-1' });
    assert.equal(p2.items.length, 3);
    assert.deepEqual(new Set(vids(p1.items)), new Set(vids(p2.items))); // 两页批成员集合一致
  } finally { cleanup(); }
});

test('listTasks 多维：组合筛选（creator+status / creator+since）', () => {
  const { db, cleanup, ids } = setupFilterDb();
  try {
    const combo = listTasks(db, 50, 0, { creator: 'Alpha', status: ['succeeded'] });
    assert.equal(combo.total, 1);
    assert.equal(combo.items.find((t) => t.id === ids.alphaBatch)!.source_vid, 'BV1ALPHA0001');

    const T = 1_700_000_000_000;
    assert.equal(listTasks(db, 50, 0, { creator: 'Alpha', since: T + 4500 }).total, 0); // alpha 任务 4000 < 4500
  } finally { cleanup(); }
});

test('listTasks 多维：批次补全跨筛选拉齐（种子命中即整批带出，锁定现状语义）', () => {
  const { db, cleanup } = setupFilterDb();
  try {
    // creator:'Alpha' 种子只有 alphaBatch（succeeded），同批 pending/failed 成员不满足筛选仍被补全带出
    const r = listTasks(db, 50, 0, { creator: 'Alpha', status: ['pending'] });
    assert.equal(r.total, 0);                                    // WHERE 计数：无「Alpha 且 pending」的种子
    // 换 status:succeeded 种子命中 → 整批带出（跨状态拉齐）
    const r2 = listTasks(db, 50, 0, { creator: 'Alpha', status: ['succeeded'] });
    assert.equal(r2.total, 1);
    assert.equal(r2.items.length, 3);
    assert.deepEqual(vids(r2.items).sort(), ['BV1ALPHA0001', 'BV1NOBAT001x', 'BV1NOBAT002x'].sort());
  } finally { cleanup(); }
});

test('listTasks 多维：items 带 creator_name（已入库有名，未入库 null）', () => {
  const { db, cleanup, ids } = setupFilterDb();
  try {
    const all = listTasks(db, 50, 0);
    assert.equal(all.items.find((t) => t.id === ids.alphaBatch)!.creator_name, 'Alpha UP');
    assert.equal(all.items.find((t) => t.id === ids.beta)!.creator_name, 'Beta UP');
    assert.equal(all.items.find((t) => t.id === ids.nolib)!.creator_name, null);
    assert.equal(all.items.find((t) => t.id === ids.yt)!.creator_name, null);
    // 单查/getTask 同形状
    assert.equal(getTask(db, ids.alphaBatch)!.creator_name, 'Alpha UP');
  } finally { cleanup(); }
});

// ── dispatchTask 打标（2026-08-23）：bilibili no_subtitle 回执 → 自动打 no-subtitle 系统标 ──
// 前提：pending 的 bilibili 任务 + 视频元信息已入库（扩展 ingest 先行）；操作：调度器派发，mock 回执 reason=no_subtitle；
// 断言：任务终态 succeeded 且视频带 no-subtitle system 档标（远期 ASR 定位锚点）；youtube 回执不打（无此语义）。
test('dispatchTask：bilibili no_subtitle 回执 → succeeded + no-subtitle 系统标', async () => {
  const { db, cleanup } = setupDb();
  // mock 桥：requestCommand 返回确认无字幕回执
  registerWsBridge({
    listClients: () => [{ client_id: 'ext-ns', ext_version: null, reporting_enabled: true, task_dispatch_enabled: true, connected: true }],
    requestCommand: async () => ({ ok: true, result: { ok: true, data: { reason: 'no_subtitle', tracks: 0, ingested: true } } }),
    broadcastEvent: () => {},
  } satisfies WsBridge);
  try {
    // 视频行先入库（扩展链路：fetch-subtitle 无字幕时也 ingest 元信息）
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1ns', title: '无字幕视频', extra: {}, duration: 5, published_at: 1700000000000 },
      tracks: [],
    });
    createTask(db, { source: 'bilibili', source_vid: 'BV1ns', url: 'https://b23.tv/x' }, 'ext-ns');
    attachTaskScheduler(db);
    kickTaskScheduler(); // 调度器无首跑（SWEEP_MS 定时 + kick 驱动），kick 触发立即派发
    // 轮询等调度器异步完成派发（串行链：dispatch → 回执 → 打标，正常毫秒级，上限 2s 防挂）
    for (let i = 0; i < 40; i++) {
      const t = getTask(db, (db.prepare('SELECT id FROM collect_tasks').get() as { id: number }).id);
      if (t?.status === 'succeeded') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const tagged = db.prepare(
      `SELECT 1 FROM video_tags vt JOIN tags t ON t.id = vt.tag_id JOIN videos v ON v.id = vt.video_id
       WHERE v.source_vid = 'BV1ns' AND t.name = 'no-subtitle' AND vt.source = 'system'`,
    ).get();
    assert.equal(tagged != null, true, 'no_subtitle 回执后带 no-subtitle system 标');
  } finally { cleanup(); }
});

// ── dispatchTask 打标平台对齐（2026-08-24）：youtube no_subtitle 回执同样打标 ──
// 背景：0.1.19 起扩展两平台都上报 0 轨回执（reason=no_subtitle），server 侧条件残留 bilibili 限定属半截子工程。
// 前提/操作/断言同上用例，source 换 youtube。
test('dispatchTask：youtube no_subtitle 回执 → succeeded + no-subtitle 系统标（两平台对齐）', async () => {
  const { db, cleanup } = setupDb();
  registerWsBridge({
    listClients: () => [{ client_id: 'ext-ns', ext_version: null, reporting_enabled: true, task_dispatch_enabled: true, connected: true }],
    requestCommand: async () => ({ ok: true, result: { ok: true, data: { reason: 'no_subtitle', tracks: 0, ingested: true } } }),
    broadcastEvent: () => {},
  } satisfies WsBridge);
  try {
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'ytns1', title: 'yt 无字幕视频', extra: {}, duration: 5, published_at: 1700000000000 },
      tracks: [],
    });
    createTask(db, { source: 'youtube', source_vid: 'ytns1', url: 'https://www.youtube.com/watch?v=ytns1' }, 'ext-ns');
    attachTaskScheduler(db);
    kickTaskScheduler();
    for (let i = 0; i < 40; i++) {
      const t = getTask(db, (db.prepare('SELECT id FROM collect_tasks').get() as { id: number }).id);
      if (t?.status === 'succeeded') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const tagged = db.prepare(
      `SELECT 1 FROM video_tags vt JOIN tags t ON t.id = vt.tag_id JOIN videos v ON v.id = vt.video_id
       WHERE v.source = 'youtube' AND v.source_vid = 'ytns1' AND t.name = 'no-subtitle' AND vt.source = 'system'`,
    ).get();
    assert.equal(tagged != null, true, 'YouTube 无字幕同样进 ASR 圈选锚点');
  } finally { cleanup(); }
});
