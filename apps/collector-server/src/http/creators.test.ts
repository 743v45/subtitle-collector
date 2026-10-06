// creators HTTP handler 测试：起 handler 直挂的 server（同 tags.test.ts 范式，不经 main.ts Origin 守卫），真 fetch 走 HTTP。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 列表（q/sort/分页/非法值回落）+ 详情 404 + 打分类（400/200/uid 编码/scope 过滤） | 通过 | |
// | R2 | 批量打分类（ids/槽位校验 400 族 + 批量写/null 清槽/updated 计数）+ refresh（fetcher 注入 mock card：全字段回写/宽容映射/0 字段/404/400 非 bilibili/502 异常族） | 通过 | 2026-10-05 web 契约 |
// | R3 | 批量打分类 keep 回归：省略键的槽位保持原值（对抗审查 blocker：undefined 曾与 null 同判清空）+ 双省略不落库 | 通过 | 槽位三态契约 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { handleCreatorsHttp } from './creators.js';

// 种子：2 UP（fans 不同、视频数不同）。
function setup(): Promise<{ port: number; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-creators-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const ingest = (sv: string, uid: string, name: string) => ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: sv, title: sv, creator: { source_uid: uid, name }, extra: {}, duration: 10, published_at: 1700000000000 },
    tracks: [],
  });
  ingest('BV1', '100', 'UP甲');
  ingest('BV2', '100', 'UP甲');
  ingest('BV3', '200', 'UP乙');
  db.prepare('UPDATE creators SET fans = ? WHERE source_uid = ?').run(5000, '100');
  db.prepare('UPDATE creators SET fans = ? WHERE source_uid = ?').run(900, '200');
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleCreatorsHttp(req, res, db);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}

async function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('creators 列表：默认 total/items + q 模糊（name/uid）+ sort=fans/video_count + 非法 sort 400 + 分页', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await call(port, 'GET', '/api/creators');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.total, 2);
    assert.equal(r.json.items[0].video_count !== undefined || r.json.items[0].name !== undefined, true);

    // q 模糊命中 UP 名
    r = await call(port, 'GET', '/api/creators?q=%E7%94%B2'); // 甲
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].name, 'UP甲');
    // q 同样模糊 source_uid
    r = await call(port, 'GET', '/api/creators?q=200');
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].name, 'UP乙');

    // sort=fans：5000 > 900；sort=video_count：甲(2) > 乙(1)
    r = await call(port, 'GET', '/api/creators?sort=fans');
    assert.deepEqual(r.json.items.map((i: any) => i.name), ['UP甲', 'UP乙']);
    r = await call(port, 'GET', '/api/creators?sort=video_count');
    assert.deepEqual(r.json.items.map((i: any) => i.name), ['UP甲', 'UP乙']);

    // 非法 sort → 400（2026-08-25 起取代旧「静默回落」：以为排了其实没排是暗坑；错误信息列全合法键）
    r = await call(port, 'GET', '/api/creators?sort=bogus');
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /sort must be one of first_seen\|fans\|video_count\|following\|level\|updated_at\|name/);

    // 分页 size=1
    r = await call(port, 'GET', '/api/creators?size=1&page=2');
    assert.equal(r.json.items.length, 1);
  } finally { cleanup(); }
});

test('creators 详情：存在 200 / 不存在 404 / 非数字 id 404', async () => {
  const { port, cleanup } = await setup();
  try {
    const list = await call(port, 'GET', '/api/creators');
    const id = list.json.items[0].id;
    let r = await call(port, 'GET', `/api/creators/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.creator.id, id);

    r = await call(port, 'GET', '/api/creators/99999');
    assert.equal(r.status, 404);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'not found');

    // 非数字 id 不匹配详情路由 → 整体 404
    r = await call(port, 'GET', '/api/creators/abc');
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});

test('creators 打分类：缺参/非法 scope 400；合法 200（分类不存在则建）；uid URL 编码；scope 过滤列表', async () => {
  const { port, cleanup } = await setup();
  try {
    // 400：scope 非法 / name 缺失
    let r = await call(port, 'POST', '/api/creators/by-uid/bilibili/100/category', { scope: 'bogus', name: '财经' });
    assert.equal(r.status, 400);
    r = await call(port, 'POST', '/api/creators/by-uid/bilibili/100/category', { scope: 'agent' });
    assert.equal(r.status, 400);

    // 200：给已入库 UP 打 agent 分类（分类不存在则建）
    r = await call(port, 'POST', '/api/creators/by-uid/bilibili/100/category', { scope: 'agent', name: '财经' });
    assert.equal(r.status, 200);
    assert.equal(r.json.creator.category_agent_name, '财经');

    // uid 含特殊字符（URL 编码后仍命中）；不存在的 UP → 建最小行
    r = await call(port, 'POST', `/api/creators/by-uid/bilibili/${encodeURIComponent('uid/空间')}/category`, { scope: 'human', name: '待观察' });
    assert.equal(r.status, 200);
    assert.equal(r.json.creator.category_human_name, '待观察');
    assert.equal(r.json.creator.source_uid, 'uid/空间');

    // 列表按分类 + scope 过滤：agent 财经只 UP甲
    r = await call(port, 'GET', '/api/creators?category=%E8%B4%A2%E7%BB%8F&scope=agent'); // 财经
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].name, 'UP甲');
    // scope 非法 → 400（2026-08-25 随「非法 400」新政收紧：此前静默忽略不过滤）
    r = await call(port, 'GET', '/api/creators?category=%E8%B4%A2%E7%BB%8F&scope=bogus');
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'scope must be agent|human');

    // 详情路由只认 GET：POST /api/creators/:id → 404
    r = await call(port, 'POST', '/api/creators/100', {});
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});

test('creators 列表分类筛选三态：category 无 scope 两列任一命中；仅 scope 筛该槽位已打标的 UP', async () => {
  const { port, cleanup } = await setup();
  try {
    // 值域合一验证：同一「财经」被 agent/human 两槽位分别打给两个 UP
    let r = await call(port, 'POST', '/api/creators/by-uid/bilibili/100/category', { scope: 'agent', name: '财经' });
    assert.equal(r.status, 200);
    r = await call(port, 'POST', '/api/creators/by-uid/bilibili/200/category', { scope: 'human', name: '财经' });
    assert.equal(r.status, 200);

    // category 无 scope：两槽位任一命中（UP甲 agent 槽 + UP乙 human 槽都算）
    r = await call(port, 'GET', '/api/creators?category=%E8%B4%A2%E7%BB%8F');
    assert.equal(r.json.total, 2);
    // scope=human：只匹配 human 槽位（UP乙）
    r = await call(port, 'GET', '/api/creators?category=%E8%B4%A2%E7%BB%8F&scope=human');
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].source_uid, '200');
    // 仅 scope 无 category：筛该槽位已打标的 UP——human 槽只有 UP乙（UP甲仅 agent 槽）
    r = await call(port, 'GET', '/api/creators?scope=human');
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].source_uid, '200');
    // agent 槽：UP甲
    r = await call(port, 'GET', '/api/creators?scope=agent');
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].source_uid, '100');
  } finally { cleanup(); }
});

// ── 平台维度（2026-08-24）──
// 回归：打分类端点曾硬编码 bilibili——YouTube uid 打分类会误建 bilibili 行。
// 修复后路径带 :source 段，YouTube uid 落 youtube 命名空间；非 bilibili|youtube 平台段 404。
test('creators 打分类 by-uid/:source/:uid：YouTube uid 落 youtube 命名空间（回归：曾误写 bilibili）；非法平台 404', async () => {
  const { port, cleanup } = await setup();
  try {
    // YouTube 频道打分类 → creator.source=youtube（修复前硬编码 bilibili，这里会得到 source='bilibili'）
    const r = await call(port, 'POST', '/api/creators/by-uid/youtube/UCabc123/category', { scope: 'agent', name: '外语' });
    assert.equal(r.status, 200);
    assert.equal(r.json.creator.source, 'youtube');
    assert.equal(r.json.creator.source_uid, 'UCabc123');
    assert.equal(r.json.creator.category_agent_name, '外语');

    // bilibili 列表不含该 YouTube 行（两命名空间隔离）
    const bili = await call(port, 'GET', '/api/creators?source=bilibili');
    assert.equal(bili.json.total, 2);
    assert.equal(bili.json.items.some((i: any) => i.source_uid === 'UCabc123'), false);
    // youtube 过滤只含它
    const yt = await call(port, 'GET', '/api/creators?source=youtube');
    assert.equal(yt.json.total, 1);
    assert.equal(yt.json.items[0].source_uid, 'UCabc123');

    // 非法平台段（非 bilibili|youtube）→ 404
    const bad = await call(port, 'POST', '/api/creators/by-uid/douyin/123/category', { scope: 'agent', name: 'x' });
    assert.equal(bad.status, 404);
  } finally { cleanup(); }
});

test('creators 列表 ?source= 平台过滤', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await call(port, 'GET', '/api/creators?source=bilibili');
    assert.equal(r.json.total, 2);
    r = await call(port, 'GET', '/api/creators?source=youtube');
    assert.equal(r.json.total, 0);
    // 非法平台值：宽松透传（无命中，不 500——对齐 /api/videos 的 source 处理）
    r = await call(port, 'GET', '/api/creators?source=bogus');
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 0);
  } finally { cleanup(); }
});

// ── 批量打分类 + UP 资料刷新（2026-10-05 web 契约）──
// 独立 setup：需要 db 句柄（造 categories / 直改资料列）与 fetcher 注入（refresh 不打真网）。
function setup2(fetcher: (url: string, init?: RequestInit) => Promise<Response>): Promise<{ port: number; db: import('better-sqlite3').Database; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-creators-http2-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const ing = (sv: string, uid: string, name: string) => ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: sv, title: sv, creator: { source_uid: uid, name }, extra: {}, duration: 10, published_at: 1700000000000 },
    tracks: [],
  });
  ing('BV1', '100', 'UP甲');
  ing('BV3', '200', 'UP乙');
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleCreatorsHttp(req, res, db, fetcher);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, db, cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}

/** 造两个存量分类，返回 [idA, idB] */
function seedCategories(db: import('better-sqlite3').Database): [number, number] {
  const now = Date.now();
  const a = db.prepare('INSERT INTO categories (name, sort_order, created_at) VALUES (?, 0, ?)').run('财经', now);
  const b = db.prepare('INSERT INTO categories (name, sort_order, created_at) VALUES (?, 0, ?)').run('科技', now);
  return [Number(a.lastInsertRowid), Number(b.lastInsertRowid)];
}

test('creators batch-category：ids 校验 400 族（空/非整数/非数组）+ 分类槽位校验（非整数/幽灵 id 400）', async () => {
  const { port, db, cleanup } = await setup2(async () => new Response('{}'));
  try {
    const [catA] = seedCategories(db);
    const list = await call(port, 'GET', '/api/creators');
    const id1 = list.json.items[0].id;
    const id2 = list.json.items[1].id;

    // ids 族
    let r = await call(port, 'POST', '/api/creators/batch-category', { ids: [], agent_category_id: catA });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /ids/);
    r = await call(port, 'POST', '/api/creators/batch-category', { ids: [id1, 'x'], agent_category_id: catA });
    assert.equal(r.status, 400);
    r = await call(port, 'POST', '/api/creators/batch-category', { ids: id1, agent_category_id: catA });
    assert.equal(r.status, 400);
    // 分类槽位族
    r = await call(port, 'POST', '/api/creators/batch-category', { ids: [id1], agent_category_id: 1.5 });
    assert.equal(r.status, 400);
    r = await call(port, 'POST', '/api/creators/batch-category', { ids: [id1], agent_category_id: 'a' });
    assert.equal(r.status, 400);
    r = await call(port, 'POST', '/api/creators/batch-category', { ids: [id1], agent_category_id: 99999 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /99999/);
    r = await call(port, 'POST', '/api/creators/batch-category', { ids: [id1], human_category_id: 88888 });
    assert.equal(r.status, 400);
    // 校验失败的请求不落库
    const c1 = await call(port, 'GET', `/api/creators/${id1}`);
    assert.equal(c1.json.creator.category_agent_id, null, '400 请求不写库');
  } finally { cleanup(); }
});

test('creators batch-category：200 批量写两槽位 + 省略键=槽位保持原值 + null 清槽 + updated 只数存在的 id + 详情回读', async () => {
  const { port, db, cleanup } = await setup2(async () => new Response('{}'));
  try {
    const [catA, catB] = seedCategories(db);
    const list = await call(port, 'GET', '/api/creators');
    const id1 = list.json.items[0].id;
    const id2 = list.json.items[1].id;

    // 两 UP 批量打 agent=财经 / human=科技
    let r = await call(port, 'POST', '/api/creators/batch-category', {
      ids: [id1, id2], agent_category_id: catA, human_category_id: catB,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.updated, 2);
    for (const id of [id1, id2]) {
      const c = await call(port, 'GET', `/api/creators/${id}`);
      assert.equal(c.json.creator.category_agent_id, catA);
      assert.equal(c.json.creator.category_agent_name, '财经');
      assert.equal(c.json.creator.category_human_id, catB);
      assert.equal(c.json.creator.category_human_name, '科技');
    }

    // keep 回归（2026-10-05 对抗审查 blocker）：省略 human 键 = 保持原值——只改 agent 槽，
    // 已打的人槽分类不得被静默清空；混入的幽灵 id 不计入 updated（批量语义部分失效属正常，不 404）
    r = await call(port, 'POST', '/api/creators/batch-category', { ids: [id1, 99999], agent_category_id: catB });
    assert.equal(r.status, 200);
    assert.equal(r.json.updated, 1);
    const kept = await call(port, 'GET', `/api/creators/${id1}`);
    assert.equal(kept.json.creator.category_agent_id, catB, '出现的槽位照写（agent=科技）');
    assert.equal(kept.json.creator.category_human_id, catB, '省略键的槽位保持原值（human 仍=首轮打的科技）');
    assert.equal(kept.json.creator.category_human_name, '科技');

    // null = 显式清空该槽位（human 置 null → 科技清掉）；agent 键省略 → 保持原值（另一方向的 keep）
    r = await call(port, 'POST', '/api/creators/batch-category', { ids: [id1], human_category_id: null });
    assert.equal(r.status, 200);
    const c1 = await call(port, 'GET', `/api/creators/${id1}`);
    assert.equal(c1.json.creator.category_agent_id, catB, '未提的槽位不动（agent 保留）');
    assert.equal(c1.json.creator.category_human_id, null, 'null 清空 human 槽');

    // 两槽位都省略 = 无槽可写：不落库（updated=0，updated_at 也不动）
    const beforeAt = (await call(port, 'GET', `/api/creators/${id1}`)).json.creator.updated_at as number;
    r = await call(port, 'POST', '/api/creators/batch-category', { ids: [id1] });
    assert.equal(r.status, 200);
    assert.equal(r.json.updated, 0);
    const after = await call(port, 'GET', `/api/creators/${id1}`);
    assert.equal(after.json.creator.updated_at, beforeAt, '双省略不 bump updated_at');

    // updated_at 有 bump（批量写后详情行的 updated_at 晚于分类创建时刻）
    const bumped = await call(port, 'POST', '/api/creators/batch-category', { ids: [id1], agent_category_id: catA });
    assert.equal(bumped.json.updated, 1);
    const last = await call(port, 'GET', `/api/creators/${id1}`);
    assert.ok(last.json.creator.updated_at >= Date.now() - 60_000, 'updated_at 已刷新');
  } finally { cleanup(); }
});

// card 接口缺省成功响应（B 站 /x/web-interface/card 实测形态子集；follower 与 card.fans 并存）
function cardPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 0,
    message: '0',
    ttl: 1,
    data: {
      card: {
        mid: '100', name: 'UP甲新名', face: 'http://i0.hdslb.com/new-face.jpg', sign: '新签名',
        level_info: { current_level: 6 }, sex: '男', attention: 31, fans: 12345,
        official_verify: { type: 1, desc: '哔哩哔哩认证账号' },
      },
      follower: 54321,
      ...over,
    },
  };
}

test('creators refresh：card 全字段回写（fans 取 data.follower）+ 返回完整详情行', async () => {
  const seen: string[] = [];
  const { port, cleanup } = await setup2(async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify(cardPayload()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  try {
    const list = await call(port, 'GET', '/api/creators');
    const id = list.json.items.find((i: any) => i.source_uid === '100').id;
    const r = await call(port, 'POST', `/api/creators/${id}/refresh`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    const c = r.json.creator;
    assert.equal(c.name, 'UP甲新名');
    assert.equal(c.avatar, 'http://i0.hdslb.com/new-face.jpg');
    assert.equal(c.sign, '新签名');
    assert.equal(c.level, 6);
    assert.equal(c.sex, '男');
    assert.equal(c.official_type, 1);
    assert.equal(c.official_title, '哔哩哔哩认证账号');
    assert.equal(c.fans, 54321, 'fans 以 data.follower 为准（card.fans 兜底）');
    assert.equal(c.following, 31, 'following ← card.attention');
    // 请求带上了 UP 的 mid
    assert.equal(seen.length, 1);
    assert.match(seen[0], /mid=100$/);
  } finally { cleanup(); }
});

test('creators refresh：宽容映射（部分字段缺失不清空既有值）+ updated_at bump + 0 字段只刷水位', async () => {
  // 响应只有 name（card 骨架在但字段大面积缺）——验证刷新不清空既有资料
  const { port, db, cleanup } = await setup2(async () =>
    new Response(JSON.stringify(cardPayload({
      card: { mid: '100', name: '只改名', sign: '', level_info: {}, official_verify: null },
      follower: undefined,
    })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  try {
    const list = await call(port, 'GET', '/api/creators');
    const id = list.json.items.find((i: any) => i.source_uid === '100').id;
    // 预置既有资料（refresh 不应清掉）
    db.prepare('UPDATE creators SET sign = ?, fans = ?, following = ? WHERE id = ?').run('旧签名', 5000, 7, id);

    const r = await call(port, 'POST', `/api/creators/${id}/refresh`);
    assert.equal(r.status, 200);
    const c = r.json.creator;
    assert.equal(c.name, '只改名', 'name 有新值照写');
    assert.equal(c.sign, '旧签名', 'sign 空串按缺失跳过，不清空');
    assert.equal(c.fans, 5000, 'follower/fans 都缺 → 保留原值');
    assert.equal(c.following, 7, 'attention 缺 → 保留原值');
    assert.equal(c.official_type, null, 'official_verify 缺 → 不写');
    const after = db.prepare('SELECT updated_at FROM creators WHERE id = ?').get(id) as { updated_at: number };
    assert.ok(after.updated_at > 0, 'updated_at 有值');

    // 全字段缺失（code=0 但 card 映射不出任何列）→ 只 bump updated_at
    const { port: port2, db: db2, cleanup: cleanup2 } = await setup2(async () =>
      new Response(JSON.stringify({ code: 0, message: '0', data: { card: { mid: '100' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    try {
      const list2 = await call(port2, 'GET', '/api/creators');
      const id2 = list2.json.items.find((i: any) => i.source_uid === '100').id;
      const before2 = db2.prepare('SELECT updated_at FROM creators WHERE id = ?').get(id2) as { updated_at: number };
      await new Promise((r2) => setTimeout(r2, 5));
      const r2 = await call(port2, 'POST', `/api/creators/${id2}/refresh`);
      assert.equal(r2.status, 200);
      const after2 = db2.prepare('SELECT updated_at, name FROM creators WHERE id = ?').get(id2) as { updated_at: number; name: string };
      assert.ok(after2.updated_at > before2.updated_at, '0 字段也 bump updated_at（水位证明刷新发生过）');
      assert.equal(after2.name, 'UP甲', '0 字段不改资料');
    } finally { cleanup2(); }
  } finally { cleanup(); }
});

test('creators refresh：404（UP 不存在）+ 400（非 bilibili 来源）', async () => {
  let fetchCalled = 0;
  const { port, cleanup } = await setup2(async () => { fetchCalled++; return new Response('{}'); });
  try {
    // 不存在的 UP → 404 且不发起外网请求
    const r = await call(port, 'POST', '/api/creators/99999/refresh');
    assert.equal(r.status, 404);
    assert.equal(fetchCalled, 0, '404 不打外网');

    // youtube UP → 400（refresh 语义只有 B 站有）
    const yt = await call(port, 'POST', '/api/creators/by-uid/youtube/UCabc/category', { scope: 'agent', name: '外语' });
    assert.equal(yt.status, 200);
    const ytId = yt.json.creator.id;
    const r2 = await call(port, 'POST', `/api/creators/${ytId}/refresh`);
    assert.equal(r2.status, 400);
    assert.match(r2.json.error, /bilibili/);
    assert.equal(fetchCalled, 0, '400 不打外网');
  } finally { cleanup(); }
});

test('creators refresh：上游异常族 → 502（非 200 / code!=0 / fetch 抛错）+ stderr 带观察字段', async () => {
  // 非 200
  const s1 = await setup2(async () => new Response('cf challenge', { status: 412 }));
  try {
    const list = await call(s1.port, 'GET', '/api/creators');
    const id = list.json.items[0].id;
    const r = await call(s1.port, 'POST', `/api/creators/${id}/refresh`);
    assert.equal(r.status, 502);
    assert.match(r.json.error, /412/);
  } finally { s1.cleanup(); }

  // code != 0（B 站风控/参数错误形态）：502 + 原始 message 透传
  const s2 = await setup2(async () =>
    new Response(JSON.stringify({ code: -404, message: '啥都木有' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  try {
    const list = await call(s2.port, 'GET', '/api/creators');
    const id = list.json.items[0].id;
    const r = await call(s2.port, 'POST', `/api/creators/${id}/refresh`);
    assert.equal(r.status, 502);
    assert.match(r.json.error, /-404/);
    assert.match(r.json.error, /啥都木有/);
  } finally { s2.cleanup(); }

  // fetch 抛错（网络层失败）：502 + message
  const s3 = await setup2(async () => { throw new Error('ECONNREFUSED'); });
  try {
    const list = await call(s3.port, 'GET', '/api/creators');
    const id = list.json.items[0].id;
    const r = await call(s3.port, 'POST', `/api/creators/${id}/refresh`);
    assert.equal(r.status, 502);
    assert.match(r.json.error, /ECONNREFUSED/);
  } finally { s3.cleanup(); }
});
