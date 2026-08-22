// creators HTTP handler 测试：起 handler 直挂的 server（同 tags.test.ts 范式，不经 main.ts Origin 守卫），真 fetch 走 HTTP。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 列表（q/sort/分页/非法值回落）+ 详情 404 + 打分类（400/200/uid 编码/scope 过滤） | 通过 | |

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

test('creators 列表：默认 total/items + q 模糊（name/uid）+ sort=fans/video_count + 非法 sort 回落 + 分页', async () => {
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

    // 非法 sort → 回落 first_seen（不 500）
    r = await call(port, 'GET', '/api/creators?sort=bogus');
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 2);

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
    let r = await call(port, 'POST', '/api/creators/by-uid/100/category', { scope: 'bogus', name: '财经' });
    assert.equal(r.status, 400);
    r = await call(port, 'POST', '/api/creators/by-uid/100/category', { scope: 'agent' });
    assert.equal(r.status, 400);

    // 200：给已入库 UP 打 agent 分类（分类不存在则建）
    r = await call(port, 'POST', '/api/creators/by-uid/100/category', { scope: 'agent', name: '财经' });
    assert.equal(r.status, 200);
    assert.equal(r.json.creator.category_agent_name, '财经');

    // uid 含特殊字符（URL 编码后仍命中）；不存在的 UP → 建最小行
    r = await call(port, 'POST', `/api/creators/by-uid/${encodeURIComponent('uid/空间')}/category`, { scope: 'human', name: '待观察' });
    assert.equal(r.status, 200);
    assert.equal(r.json.creator.category_human_name, '待观察');
    assert.equal(r.json.creator.source_uid, 'uid/空间');

    // 列表按分类 + scope 过滤：agent 财经只 UP甲；scope 非法 → 过滤忽略
    r = await call(port, 'GET', '/api/creators?category=%E8%B4%A2%E7%BB%8F&scope=agent'); // 财经
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].name, 'UP甲');
    r = await call(port, 'GET', '/api/creators?category=%E8%B4%A2%E7%BB%8F&scope=bogus');
    assert.equal(r.json.total, 3); // 不过滤（含新建的最小行 UP）

    // 详情路由只认 GET：POST /api/creators/:id → 404
    r = await call(port, 'POST', '/api/creators/100', {});
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});
