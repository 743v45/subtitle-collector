// http/settings.ts handler 单测：tag-priority / collect-timeout 两条路由的 PUT 失败分支 + 兜底 404。
// 此前仅经 tags.test.ts 顺带覆盖（GET/PUT 正常路径），这里补齐：非 GET/PUT 方法落兜底 404、未知子路径 404。
// 跑法：cd apps/collector-server && node --test --import tsx src/http/settings.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | tag-priority/collect-timeout 全方法 + 未知路径 | 通过 | 非 GET/PUT → 兜底 404 |
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { handleSettingsHttp } from './settings.js';

function setup(): Promise<{ port: number; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-settings-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleSettingsHttp(req, res, db);
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

test('settings handler：非 GET/PUT 方法与未知子路径 → 兜底 404', async () => {
  const { port, cleanup } = await setup();
  try {
    // POST tag-priority（方法不匹配两条 if）→ 落到兜底 404
    let r = await call(port, 'POST', '/api/settings/tag-priority', { priority: ['manual'] });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not found');
    // DELETE collect-timeout 同理
    r = await call(port, 'DELETE', '/api/settings/collect-timeout');
    assert.equal(r.status, 404);
    // 未知子路径
    r = await call(port, 'GET', '/api/settings/unknown');
    assert.equal(r.status, 404);
    // 根路径 /api/settings 本身也无路由 → 404
    r = await call(port, 'GET', '/api/settings');
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});

test('settings handler：PUT tag-priority 非法排列 → 400（错误文案含四档说明）', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await call(port, 'PUT', '/api/settings/tag-priority', { priority: ['manual', 'batch'] });
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /permutation/);
    // 非数组 body 同样 400（setTagPriority 抛错被 catch）
    const r2 = await call(port, 'PUT', '/api/settings/tag-priority', { priority: 'manual' });
    assert.equal(r2.status, 400);
  } finally { cleanup(); }
});

test('settings handler：PUT collect-timeout 缺键/越界 → 400 + message 透传；GET 正常', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await call(port, 'PUT', '/api/settings/collect-timeout', { bilibili: 120_000 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /bilibili, youtube/);
    const r2 = await call(port, 'PUT', '/api/settings/collect-timeout', { bilibili: 5_000, youtube: 90_000 });
    assert.equal(r2.status, 400);
    // GET 默认值不受失败写影响
    const g = await call(port, 'GET', '/api/settings/collect-timeout');
    assert.equal(g.status, 200);
    assert.equal(g.json.bilibili, 90_000);
    assert.equal(g.json.youtube, 45_000);
  } finally { cleanup(); }
});
