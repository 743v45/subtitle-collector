import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { handleTagsHttp } from './tags.js';
import { handleSettingsHttp } from './settings.js';
import { handleQueryHttp } from './queries.js';

// 起 handler 直挂的测试 server（不经 main.ts 的 Origin 守卫，聚焦 handler 逻辑）
function setup(): Promise<{ port: number; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-tags-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: 't', creator: { source_uid: '1', name: 'up' }, extra: { tags: [{ tag_id: 1, tag_name: 'B站自带' }] }, duration: 10, published_at: 1700000000000 },
    tracks: [],
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const p = req.url ?? '';
    if (p.startsWith('/api/tags')) { void handleTagsHttp(req, res, db); return; }
    if (p.startsWith('/api/settings')) { void handleSettingsHttp(req, res, db); return; }
    void handleQueryHttp(req, res, db);
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

test('tags API 全链路：apply → list → rename → 优先级 → 单视频打标/移除 → delete', async () => {
  const { port, cleanup } = await setup();
  try {
    // 1. 批量 apply（batch 档）
    let r = await call(port, 'POST', '/api/tags/apply', {
      items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['ai', '面试题'], source: 'batch',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.inserted, 2);

    // 2. bili 档只读 → 400
    r = await call(port, 'POST', '/api/tags/apply', {
      items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['x'], source: 'bili',
    });
    assert.equal(r.status, 400);

    // 3. 不存在的视频 → 404 + missing
    r = await call(port, 'POST', '/api/tags/apply', {
      items: [{ source: 'bilibili', source_vid: 'BVnope' }], names: ['x'], source: 'manual',
    });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json.missing, [{ source: 'bilibili', source_vid: 'BVnope' }]);

    // 4. list：计数正确
    r = await call(port, 'GET', '/api/tags');
    assert.equal(r.json.items.length, 2);
    const aiTag = r.json.items.find((t: any) => t.name === 'ai');
    assert.equal(aiTag.counts.batch, 1);

    // 5. 单视频打标（manual 档，详情页路径）
    r = await call(port, 'POST', '/api/videos/bilibili/BV1/tags', { names: ['ai'], source: 'manual' });
    assert.equal(r.status, 200);
    assert.equal(r.json.inserted, 1);

    // 6. 优先级 GET/PUT
    r = await call(port, 'GET', '/api/settings/tag-priority');
    assert.deepEqual(r.json.priority, ['manual', 'batch', 'bili', 'ai']);
    r = await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['ai', 'manual', 'bili', 'batch'] });
    assert.equal(r.status, 200);
    r = await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['manual', 'batch'] });
    assert.equal(r.status, 400);
    // 回默认
    await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['manual', 'batch', 'bili', 'ai'] });

    // 7. rename：撞名 409
    const tagId = aiTag.id;
    r = await call(port, 'PATCH', `/api/tags/${tagId}`, { name: '面试题' });
    assert.equal(r.status, 409);
    r = await call(port, 'PATCH', `/api/tags/${tagId}`, { name: '人工智能' });
    assert.equal(r.status, 200);
    assert.equal(r.json.tag.name, '人工智能');

    // 8. 单视频移除（query 参数，指定档）
    r = await call(port, 'DELETE', '/api/videos/bilibili/BV1/tags?name=人工智能&source=batch');
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, 1);

    // 9. 批量 remove 省略 source → 全档
    r = await call(port, 'POST', '/api/tags/remove', {
      items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['人工智能'],
    });
    assert.equal(r.json.removed, 1);

    // 10. delete 标签（面试题）
    const mjt = (await call(port, 'GET', '/api/tags')).json.items.find((t: any) => t.name === '面试题');
    r = await call(port, 'DELETE', `/api/tags/${mjt.id}`);
    assert.equal(r.status, 200);
    r = await call(port, 'DELETE', `/api/tags/${mjt.id}`);
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});

test('富化：列表 tag_details 按优先级 winner dedupe + 优先级翻转 + 详情全档', async () => {
  const { port, cleanup } = await setup();
  try {
    // BV1（setup 已入库，extra 无 tags）打 manual + ai 同名「人工智能」
    await call(port, 'POST', '/api/videos/bilibili/BV1/tags', { names: ['人工智能'], source: 'manual' });
    await call(port, 'POST', '/api/videos/bilibili/BV1/tags', { names: ['人工智能'], source: 'ai' });

    // 列表：默认优先级 manual > ... > ai → 人工智能 winner = manual；bili「B站自带」独立展示
    let r = await call(port, 'GET', '/api/videos?source=bilibili&source_vid=BV1&size=50');
    let item = r.json.items.find((i: any) => i.source_vid === 'BV1');
    assert.deepEqual(item.tag_details, [
      { name: '人工智能', source: 'manual' },
      { name: 'B站自带', source: 'bili' },
    ]);
    assert.deepEqual(item.tags, ['人工智能', 'B站自带']);

    // 翻转优先级（ai 最高）→ 人工智能 winner 变 ai（后端 dedupe 生效，前端零逻辑）
    await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['ai', 'batch', 'bili', 'manual'] });
    r = await call(port, 'GET', '/api/videos?source=bilibili&source_vid=BV1&size=50');
    item = r.json.items.find((i: any) => i.source_vid === 'BV1');
    assert.deepEqual(item.tag_details, [
      { name: '人工智能', source: 'ai' },
      { name: 'B站自带', source: 'bili' },
    ]);
    await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['manual', 'batch', 'bili', 'ai'] });

    // 详情：全档不去重（manual + ai 两条都在，按优先级排）+ bili 档来自 extra（回归：extra 是 JSON 字符串须 parse）
    r = await call(port, 'GET', '/api/videos/bilibili/BV1');
    assert.deepEqual(r.json.tag_details, [
      { name: '人工智能', source: 'manual' },
      { name: 'B站自带', source: 'bili' },
      { name: '人工智能', source: 'ai' },
    ]);
  } finally { cleanup(); }
});
