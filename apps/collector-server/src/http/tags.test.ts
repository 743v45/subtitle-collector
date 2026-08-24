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
import { handleStatsHttp } from './stats.js';

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
      items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['ai', '面试题'], scope: 'batch',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.inserted, 2);

    // 1.5 分支洼地：items/names 缺失或空数组 → 400（parseApplyBody 第一层校验）
    r = await call(port, 'POST', '/api/tags/apply', { names: ['x'] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /items.*required/);
    r = await call(port, 'POST', '/api/tags/apply', { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: [] });
    assert.equal(r.status, 400, '空 names 同层拦截');
    r = await call(port, 'POST', '/api/tags/apply', { items: [{ source: '', source_vid: '' }], names: ['x'] });
    assert.equal(r.status, 400, 'item 空字段第二层拦截');
    assert.match(r.json.error, /non-empty source/);

    // 2. bili 档只读 → 400
    r = await call(port, 'POST', '/api/tags/apply', {
      items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['x'], scope: 'bili',
    });
    assert.equal(r.status, 400);

    // 3. 不存在的视频 → 404 + missing
    r = await call(port, 'POST', '/api/tags/apply', {
      items: [{ source: 'bilibili', source_vid: 'BVnope' }], names: ['x'], scope: 'manual',
    });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json.missing, [{ source: 'bilibili', source_vid: 'BVnope' }]);

    // 4. list：计数正确
    r = await call(port, 'GET', '/api/tags');
    assert.equal(r.json.items.length, 2);
    const aiTag = r.json.items.find((t: any) => t.name === 'ai');
    assert.equal(aiTag.counts.batch, 1);

    // 5. 单视频打标（manual 档，详情页路径）
    r = await call(port, 'POST', '/api/videos/bilibili/BV1/tags', { names: ['ai'], scope: 'manual' });
    assert.equal(r.status, 200);
    assert.equal(r.json.inserted, 1);

    // 6. 优先级 GET/PUT（六档，含只读 season/system）
    r = await call(port, 'GET', '/api/settings/tag-priority');
    assert.deepEqual(r.json.priority, ['manual', 'batch', 'bili', 'season', 'ai', 'system']);
    r = await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['ai', 'manual', 'bili', 'season', 'batch', 'system'] });
    assert.equal(r.status, 200);
    r = await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['manual', 'batch'] });
    assert.equal(r.status, 400);
    // 五档（缺 system）不再合法 → 400
    r = await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['manual', 'batch', 'bili', 'season', 'ai'] });
    assert.equal(r.status, 400);
    // 回默认
    await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['manual', 'batch', 'bili', 'season', 'ai', 'system'] });

    // 7. rename：撞名 409
    const tagId = aiTag.id;
    r = await call(port, 'PATCH', `/api/tags/${tagId}`, { name: '面试题' });
    assert.equal(r.status, 409);
    r = await call(port, 'PATCH', `/api/tags/${tagId}`, { name: '人工智能' });
    assert.equal(r.status, 200);
    assert.equal(r.json.tag.name, '人工智能');

    // 8. 单视频移除（query 参数，指定档）
    r = await call(port, 'DELETE', '/api/videos/bilibili/BV1/tags?name=人工智能&scope=batch');
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
    assert.equal(r.json.ok, true);
    r = await call(port, 'DELETE', `/api/tags/${mjt.id}`);
    assert.equal(r.status, 404);
    // 404 的 body 与状态码语义一致（ok:false + error），不能是 ok:true
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'not found');
  } finally { cleanup(); }
});

test('富化：列表 tag_details 按优先级 winner dedupe + 优先级翻转 + 详情全档', async () => {
  const { port, cleanup } = await setup();
  try {
    // BV1（setup 已入库，extra 无 tags）打 manual + ai 同名「人工智能」
    await call(port, 'POST', '/api/videos/bilibili/BV1/tags', { names: ['人工智能'], scope: 'manual' });
    await call(port, 'POST', '/api/videos/bilibili/BV1/tags', { names: ['人工智能'], scope: 'ai' });

    // 列表：默认优先级 manual > ... > ai → 人工智能 winner = manual；bili「B站自带」独立展示
    let r = await call(port, 'GET', '/api/videos?source=bilibili&source_vid=BV1&size=50');
    let item = r.json.items.find((i: any) => i.source_vid === 'BV1');
    assert.deepEqual(item.tag_details, [
      { name: '人工智能', source: 'manual' },
      { name: 'B站自带', source: 'bili' },
    ]);
    assert.deepEqual(item.tags, ['人工智能', 'B站自带']);

    // 翻转优先级（ai 最高）→ 人工智能 winner 变 ai（后端 dedupe 生效，前端零逻辑）
    await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['ai', 'batch', 'bili', 'season', 'system', 'manual'] });
    r = await call(port, 'GET', '/api/videos?source=bilibili&source_vid=BV1&size=50');
    item = r.json.items.find((i: any) => i.source_vid === 'BV1');
    assert.deepEqual(item.tag_details, [
      { name: '人工智能', source: 'ai' },
      { name: 'B站自带', source: 'bili' },
    ]);
    await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['manual', 'batch', 'bili', 'season', 'ai', 'system'] });

    // 详情：全档不去重（manual + ai 两条都在，按优先级排）+ bili 档来自 extra（回归：extra 是 JSON 字符串须 parse）
    r = await call(port, 'GET', '/api/videos/bilibili/BV1');
    assert.deepEqual(r.json.tag_details, [
      { name: '人工智能', source: 'manual' },
      { name: 'B站自带', source: 'bili' },
      { name: '人工智能', source: 'ai' },
    ]);
  } finally { cleanup(); }
});

// ---- season 档（合集标签，只读实时读 extra.ugc_season.title）HTTP 层 ----
// 独立 setup：BV1 带合集 + bili 同名标签（验证同名 winner 按优先级取 bili）、BV2 带合集、BV3 无合集。
function setupSeason(): Promise<{ port: number; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-tags-season-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const ingest = (sv: string, extra: Record<string, unknown>) => ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: sv, title: sv, creator: { source_uid: '1', name: 'up' }, extra, duration: 10, published_at: 1700000000000 },
    tracks: [],
  });
  ingest('SV1', { ugc_season: { id: 1, title: 'AI前沿' }, tags: [{ tag_id: 1, tag_name: 'AI前沿' }] });
  ingest('SV2', { ugc_season: { id: 1, title: 'AI前沿' } });
  ingest('SV3', {});
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const p = req.url ?? '';
    if (p.startsWith('/api/tags')) { void handleTagsHttp(req, res, db); return; }
    if (p.startsWith('/api/settings')) { void handleSettingsHttp(req, res, db); return; }
    if (p.startsWith('/api/stats')) { void handleStatsHttp(req, res, db); return; }
    void handleQueryHttp(req, res, db);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}

test('season 档 HTTP：列表/详情富化 + 只读 400 + 过滤 + 聚合', async () => {
  const { port, cleanup } = await setupSeason();
  try {
    // 1. 列表富化：SV1 的 season「AI前沿」与 bili 同名 → winner = bili（默认序 bili > season）；SV2 独立 season 档
    let r = await call(port, 'GET', '/api/videos?size=50&sort=title');
    const sv1 = r.json.items.find((i: any) => i.source_vid === 'SV1');
    const sv2 = r.json.items.find((i: any) => i.source_vid === 'SV2');
    assert.deepEqual(sv1.tag_details, [{ name: 'AI前沿', source: 'bili' }]);
    assert.deepEqual(sv2.tag_details, [{ name: 'AI前沿', source: 'season' }]);

    // 2. 详情全档：SV1 展示 bili + season 两条（不去重）
    r = await call(port, 'GET', '/api/videos/bilibili/SV1');
    assert.deepEqual(r.json.tag_details, [
      { name: 'AI前沿', source: 'bili' },
      { name: 'AI前沿', source: 'season' },
    ]);

    // 3. 只读：单视频打标/移除 scope=season → 400；批量 apply 同理
    r = await call(port, 'POST', '/api/videos/bilibili/SV1/tags', { names: ['x'], scope: 'season' });
    assert.equal(r.status, 400);
    r = await call(port, 'DELETE', '/api/videos/bilibili/SV1/tags?name=x&scope=season');
    assert.equal(r.status, 400);
    r = await call(port, 'POST', '/api/tags/apply', { items: [{ source: 'bilibili', source_vid: 'SV1' }], names: ['x'], scope: 'season' });
    assert.equal(r.status, 400);

    // 4. 过滤分档：SV1 两档并存（bili + season 同名）→ season 档两视频都命中；bili 档只 SV1（SV2 无 bili）
    r = await call(port, 'GET', `/api/videos?tags=${encodeURIComponent('AI前沿')}&tag_source=season`);
    assert.equal(r.json.total, 2);
    r = await call(port, 'GET', `/api/videos?tags=${encodeURIComponent('AI前沿')}&tag_source=bili`);
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].source_vid, 'SV1');
    // 省略 tag_source（五档并查）→ SV1 + SV2
    r = await call(port, 'GET', `/api/videos?tags=${encodeURIComponent('AI前沿')}`);
    assert.equal(r.json.total, 2);

    // 5. 聚合 groupBy=tag：season 档并入（AI前沿 DISTINCT 2）
    r = await call(port, 'GET', '/api/stats?type=aggregate&groupBy=tag');
    const row = r.json.items.find((i: any) => i.key === 'AI前沿');
    assert.equal(row.count, 2);
  } finally { cleanup(); }
});

// ── 采集超时配置端点（2026-08-22）：GET/PUT /api/settings/collect-timeout ──
test('settings API：collect-timeout 默认值 → PUT 覆盖 → 非法 400', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await call(port, 'GET', '/api/settings/collect-timeout');
    assert.equal(r.status, 200);
    assert.deepEqual({ bilibili: r.json.bilibili, youtube: r.json.youtube }, { bilibili: 90_000, youtube: 45_000 });

    r = await call(port, 'PUT', '/api/settings/collect-timeout', { bilibili: 120_000, youtube: 90_000 });
    assert.equal(r.status, 200);
    r = await call(port, 'GET', '/api/settings/collect-timeout');
    assert.deepEqual({ bilibili: r.json.bilibili, youtube: r.json.youtube }, { bilibili: 120_000, youtube: 90_000 });

    // 越界（<15s）→ 400 失败可见;值不变
    r = await call(port, 'PUT', '/api/settings/collect-timeout', { bilibili: 5_000, youtube: 90_000 });
    assert.equal(r.status, 400);
    r = await call(port, 'GET', '/api/settings/collect-timeout');
    assert.equal(r.json.bilibili, 120_000);
  } finally { cleanup(); }
});

// ── parseApplyBody 校验分支：items/names 各非法形态 → 400 ──
test('POST /api/tags/apply|remove：body 各非法形态 → 400', async () => {
  const { port, cleanup } = await setup();
  try {
    // items 缺失 / names 缺失 / 空数组 → 400（apply 与 remove 同一 parseApplyBody）
    for (const path of ['/api/tags/apply', '/api/tags/remove']) {
      let r = await call(port, 'POST', path, { names: ['x'] });
      assert.equal(r.status, 400, `${path} items 缺失`);
      assert.equal(r.json.error, 'items:[{source,source_vid}] and names:string[] required');
      r = await call(port, 'POST', path, { items: [], names: ['x'] });
      assert.equal(r.status, 400, `${path} items 空数组`);
      r = await call(port, 'POST', path, { items: [{ source: 'bilibili', source_vid: 'BV1' }] });
      assert.equal(r.status, 400, `${path} names 缺失`);
      r = await call(port, 'POST', path, { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: [] });
      assert.equal(r.status, 400, `${path} names 空数组`);
      // names 全空白串 → 过滤后空 → 400
      r = await call(port, 'POST', path, { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['  '] });
      assert.equal(r.status, 400, `${path} names 全空白`);
      assert.equal(r.json.error, 'names must contain at least one non-empty string');
    }

    // item 字段脏值：缺 source / 空 source_vid / 非字符串 → 400
    for (const item of [{ source_vid: 'BV1' }, { source: '', source_vid: 'BV1' }, { source: 'bilibili', source_vid: '' }, { source: 42, source_vid: 'BV1' }]) {
      const r = await call(port, 'POST', '/api/tags/apply', { items: [item], names: ['x'], scope: 'manual' });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, 'each item needs non-empty source & source_vid');
    }

    // remove 显式 scope=bogus → 400；scope=season 只读 → 400；scope=bili 只读 → 400
    let r = await call(port, 'POST', '/api/tags/remove', { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['x'], scope: 'bogus' });
    assert.equal(r.status, 400);
    r = await call(port, 'POST', '/api/tags/remove', { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['x'], scope: 'season' });
    assert.equal(r.status, 400);
    r = await call(port, 'POST', '/api/tags/remove', { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['x'], scope: 'bili' });
    assert.equal(r.status, 400);
    // remove 显式合法 scope=manual → 200（走带档删除分支）
    await call(port, 'POST', '/api/tags/apply', { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['档删'], scope: 'manual' });
    await call(port, 'POST', '/api/tags/apply', { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['档删'], scope: 'ai' });
    r = await call(port, 'POST', '/api/tags/remove', { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['档删'], scope: 'manual' });
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, 1);
  } finally { cleanup(); }
});

// ── PATCH /api/tags/:id 的 name 校验 + 404 + 500 兜底；路由兜底 404 ──
test('PATCH /api/tags/:id：name 缺失/非串/空白 → 400；不存在 id → 404；未知方法/路径 → 404', async () => {
  const { port, cleanup } = await setup();
  try {
    await call(port, 'POST', '/api/tags/apply', { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['目标'], scope: 'manual' });
    const tagId = (await call(port, 'GET', '/api/tags')).json.items.find((t: any) => t.name === '目标').id;

    // name 缺失 / 非字符串 / 纯空白 → 400
    let r = await call(port, 'PATCH', `/api/tags/${tagId}`, {});
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'name required');
    r = await call(port, 'PATCH', `/api/tags/${tagId}`, { name: 42 });
    assert.equal(r.status, 400);
    r = await call(port, 'PATCH', `/api/tags/${tagId}`, { name: '   ' });
    assert.equal(r.status, 400);
    // 不存在的 id → 404
    r = await call(port, 'PATCH', '/api/tags/99999', { name: '改名' });
    assert.equal(r.status, 404);
    // 非 /api/tags/(\d+) 形态（字母 id）与方法不匹配 → 兜底 404
    r = await call(port, 'PATCH', '/api/tags/abc', { name: 'x' });
    assert.equal(r.status, 404);
    r = await call(port, 'POST', '/api/tags', {});
    assert.equal(r.status, 404);
    r = await call(port, 'PUT', `/api/tags/${tagId}`, { name: 'x' });
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});

// ── renameTag 抛非 UNIQUE 错误 → 500 兜底（Proxy 拦 db.prepare 注入故障）──
test('PATCH /api/tags/:id：rename 抛非 UNIQUE 错误 → 500 + 错误 message 透传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-tags-500-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: 't', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 1, published_at: 1 },
    tracks: [],
  });
  // 拦 UPDATE tags 的 prepare，run 时抛非 UNIQUE 错误（模拟磁盘 I/O 故障等）
  const faultyDb = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes('UPDATE tags SET name')) {
            return { run: () => { throw new Error('disk I/O error'); } };
          }
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleTagsHttp(req, res, faultyDb as typeof db);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  try {
    const apply = await call(port, 'POST', '/api/tags/apply', { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['目标'], scope: 'manual' });
    assert.equal(apply.status, 200);
    const tagId = (await call(port, 'GET', '/api/tags')).json.items[0].id;
    const r = await call(port, 'PATCH', `/api/tags/${tagId}`, { name: '改名' });
    assert.equal(r.status, 500);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'disk I/O error');
  } finally {
    server.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

// ── GET /api/tags 的 source 校验与 topN 归一 ──
test('GET /api/tags：scope 非法 400；topN 非法回落 500、上限 500、下限 1', async () => {
  const { port, cleanup } = await setup();
  try {
    await call(port, 'POST', '/api/tags/apply', { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['t1', 't2', 't3'], scope: 'manual' });
    // scope 非法档 → 400
    let r = await call(port, 'GET', '/api/tags?scope=bogus');
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'scope must be manual|batch|ai');
    // scope 合法（manual）→ 只列该档 >0 的标签
    r = await call(port, 'GET', '/api/tags?scope=manual');
    assert.equal(r.status, 200);
    assert.equal(r.json.items.length, 3);
    // topN 非法（NaN）→ 回落 500；topN=2 → 截 2 条；topN=99999 → 上限 500
    r = await call(port, 'GET', '/api/tags?topN=abc');
    assert.equal(r.json.items.length, 3);
    r = await call(port, 'GET', '/api/tags?topN=2');
    assert.equal(r.json.items.length, 2);
    r = await call(port, 'GET', '/api/tags?topN=99999');
    assert.equal(r.status, 200); // 不因超大 topN 报错（夹到 500）
    // 详情全档：三个 manual 同档标签按名字 localeCompare 排序（同优先级 tie 分支）
    r = await call(port, 'GET', '/api/videos/bilibili/BV1');
    assert.deepEqual(r.json.tag_details, [
      { name: 't1', source: 'manual' },
      { name: 't2', source: 'manual' },
      { name: 't3', source: 'manual' },
      { name: 'B站自带', source: 'bili' },
    ], '同档（manual）内部按名字排序，档间按优先级');
  } finally { cleanup(); }
});
