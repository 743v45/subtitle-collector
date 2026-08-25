// 本文件覆盖 src/http/categories.ts 的全部 HTTP 分支：分类（UP 主分类，非字幕本体）CRUD——
// GET/POST /api/categories（一套共享值域无 scope：带 scope 参数 400、创建缺 name 400、
// UNIQUE(name) 撞名 409、非 UNIQUE 错误 500 兜底）、
// PATCH/DELETE /api/categories/:id（改名 / 调排序 / 空补丁原样返回 / 改名撞名 409 / 不存在 404 / 幂等删除）
// 以及路由兜底 404（未知方法 / 非数字 id）。
// 走真实 node:http server + 临时 sqlite 库（直挂 handler，不经 main.ts 的 Origin 守卫，聚焦 handler 逻辑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { handleCategoriesHttp } from './categories.js';

// categories CRUD 不依赖 videos/creators 数据，空库即可起测
function setup(): Promise<{ port: number; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-categories-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleCategoriesHttp(req, res, db);
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

test('categories API 全链路：POST 创建 → GET 全量 → PATCH 改名/排序/空补丁 → DELETE 幂等', async () => {
  const { port, cleanup } = await setup();
  try {
    // 1. POST 创建：只要 name（值域合一，无 scope），默认 sort_order=0，返回完整分类对象
    let r = await call(port, 'POST', '/api/categories', { name: '财经' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.category.name, '财经');
    assert.equal(r.json.category.sort_order, 0);

    // 2. 再建两个（同名词撞 UNIQUE(name) 的 409 在校验分支测试覆盖）
    r = await call(port, 'POST', '/api/categories', { name: '科技' });
    assert.equal(r.status, 200);
    const techId = r.json.category.id;
    r = await call(port, 'POST', '/api/categories', { name: '关注' });
    assert.equal(r.status, 200);
    const watchId = r.json.category.id;

    // 3. GET 全量：ORDER BY sort_order → id（同 0 按建序）
    r = await call(port, 'GET', '/api/categories');
    assert.equal(r.json.items.length, 3);
    assert.deepEqual(r.json.items.map((c: any) => c.name), ['财经', '科技', '关注']);
    assert.ok(!('scope' in r.json.items[0]), '分类行不应再有 scope 字段');

    // 4. PATCH 调 sort_order：科技提到 -1 → 反超财经
    r = await call(port, 'PATCH', `/api/categories/${techId}`, { sort_order: -1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.category.sort_order, -1);
    r = await call(port, 'GET', '/api/categories');
    assert.deepEqual(r.json.items.map((c: any) => c.name), ['科技', '财经', '关注']);

    // 5. PATCH 改名
    r = await call(port, 'PATCH', `/api/categories/${techId}`, { name: '硬科技' });
    assert.equal(r.status, 200);
    assert.equal(r.json.category.name, '硬科技');

    // 6. PATCH 空补丁：无可更新字段 → 原样返回当前行（200，不报错）
    r = await call(port, 'PATCH', `/api/categories/${techId}`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.category.name, '硬科技');

    // 7. DELETE → 200；再删同一 id 仍 200（deleteCategory 无存在性检查，幂等设计，区别于 tags 的 404）
    r = await call(port, 'DELETE', `/api/categories/${watchId}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    r = await call(port, 'DELETE', `/api/categories/${watchId}`);
    assert.equal(r.status, 200);
    r = await call(port, 'GET', '/api/categories');
    assert.equal(r.json.items.length, 2);
  } finally { cleanup(); }
});

test('categories 校验分支：GET 带 scope 400；POST 缺 name 400；重名 409；PATCH 改名撞名 409；不存在 404；路由兜底 404', async () => {
  const { port, cleanup } = await setup();
  try {
    // GET ?scope=… → 400：分类已无 scope 属性（值域合一），任何非空 scope（含旧合法值）都拒绝，暴露过时调用方；
    // ?scope=（空串）视为未传 → 全量 200
    let r = await call(port, 'GET', '/api/categories?scope=agent');
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'category has no scope; use plain name');
    r = await call(port, 'GET', '/api/categories?scope=bogus');
    assert.equal(r.status, 400);
    r = await call(port, 'GET', '/api/categories?scope=');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.items, []);

    // POST 各非法形态 → 400（空 body / 缺 name / name 空串）
    r = await call(port, 'POST', '/api/categories', {});
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'name required');
    r = await call(port, 'POST', '/api/categories', { name: '财经' });
    assert.equal(r.status, 200); // 无 scope 字段是合法创建（多带的未知字段忽略）
    r = await call(port, 'POST', '/api/categories', { name: '' });
    assert.equal(r.status, 400);

    // 同名撞 UNIQUE(name) → 409（非 500，失败可预期；值域合一后同名词是同一实体）
    r = await call(port, 'POST', '/api/categories', { name: '财经' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'category name already exists');

    // PATCH 改名撞既有名 → 409（对齐 POST 先例；此前经兜底 500）
    await call(port, 'POST', '/api/categories', { name: '科技' });
    const tech = (await call(port, 'GET', '/api/categories')).json.items.find((c: any) => c.name === '科技');
    r = await call(port, 'PATCH', `/api/categories/${tech.id}`, { name: '财经' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'category name already exists');

    // PATCH 不存在的 id → 404
    r = await call(port, 'PATCH', '/api/categories/99999', { name: '改名' });
    assert.equal(r.status, 404);
    assert.equal(r.json.ok, false);

    // 路由兜底 404：/api/categories/:id 上的非 PATCH/DELETE 方法、字母 id、集合根上的其他方法
    r = await call(port, 'GET', '/api/categories/1');
    assert.equal(r.status, 404);
    r = await call(port, 'PUT', '/api/categories/1', { name: 'x' });
    assert.equal(r.status, 404);
    r = await call(port, 'PATCH', '/api/categories/abc', { name: 'x' });
    assert.equal(r.status, 404);
    r = await call(port, 'PUT', '/api/categories', {});
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});

// ── create 抛非 UNIQUE 错误 → 500 兜底（Proxy 拦 db.prepare 注入故障，错误 message 透传）──
test('POST /api/categories：create 抛非 UNIQUE 错误 → 500 + 错误 message 透传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-categories-500-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  // 拦 INSERT INTO categories 的 prepare，run 时抛非 UNIQUE 错误（模拟磁盘 I/O 故障等）
  const faultyDb = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes('INSERT INTO categories')) {
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
    void handleCategoriesHttp(req, res, faultyDb as typeof db);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  try {
    const r = await call(port, 'POST', '/api/categories', { name: '财经' });
    assert.equal(r.status, 500);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'disk I/O error');
  } finally {
    server.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
