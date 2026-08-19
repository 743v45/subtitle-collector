import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../db/migrate.js';
import { extractVideoUrl, expandShortLink, parseVideoUrl, createTask, createTasksBatch, expandUpperVideos, getTask, listTasks, resetDispatched, type FetchLike, type UpperExpandDeps } from './tasks.js';

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

test('expandUpperVideos：分页循环拉全量（page 参数对齐扩展契约）+ 已采标注', async () => {
  const { db, cleanup } = setupDb();
  try {
    // 库里已有 BV2（该 UP 已采 1 条）
    db.prepare("INSERT INTO creators (source, source_uid, name, first_seen_at, updated_at) VALUES ('bilibili', '296399504', 'UP甲', 1, 1)").run();
    const cid = (db.prepare("SELECT id FROM creators WHERE source_uid='296399504'").get() as { id: number }).id;
    db.prepare("INSERT INTO videos (source, source_vid, creator_id, title, first_seen_at, updated_at) VALUES ('bilibili', 'BV2xx411c7mD', ?, '已采视频', 1, 1)").run(cid);

    const deps = fakePagedCommand({
      1: { total: 3, items: [
        { bvid: 'BV1xx411c7mD', title: '视频一', created: 1700000000, play: 100, length: '5:30' },
        { bvid: 'BV2xx411c7mD', title: '已采视频', created: 1700000100, play: 200, length: '6:00' },
      ] },
      2: { total: 3, items: [
        { bvid: 'BV3xx411c7mD', title: '视频三', created: 1700000200, play: 300, length: '7:00' },
      ] },
    });
    const r = await expandUpperVideos(db, '296399504', deps);
    assert.equal(r.total, 3);
    assert.equal(r.items.length, 3);
    assert.deepEqual(r.items.map((x) => x.collected), [false, true, false]);
    assert.equal(r.items[0].title, '视频一');
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
    const r = await expandUpperVideos(db, '296399504', deps);
    const bvids = r.items.map((x) => x.bvid);
    assert.equal(new Set(bvids).size, bvids.length, '结果必须无重复 bvid');
    assert.deepEqual(bvids.sort(), ['BV1aa411c7mD', 'BV1bb411c7mD', 'BV1cc411c7mD']);
  } finally { cleanup(); }
});

test('expandUpperVideos：扩展离线抛错；单页回执失败抛错', async () => {
  const { db, cleanup } = setupDb();
  try {
    await assert.rejects(
      expandUpperVideos(db, '296399504', { listClients: () => [], requestCommand: async () => ({ ok: false, code: 'offline' as const }), sleep: async () => {} }),
      /扩展离线/,
    );
    await assert.rejects(
      expandUpperVideos(db, '296399504', {
        listClients: () => [{ client_id: 'ext-A' }],
        requestCommand: async () => ({ ok: true, result: { ok: false, error: 'arc/search -412' } }),
        sleep: async () => {},
      }),
      /-412/,
    );
  } finally { cleanup(); }
});
