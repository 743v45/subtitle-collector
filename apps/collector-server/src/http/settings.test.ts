// http/settings.ts handler 单测：tag-priority / collect-timeout 两条路由的 PUT 失败分支 + 兜底 404
// + GET /api/status 运行状态快照（Phase 1 新增）。
// 此前仅经 tags.test.ts 顺带覆盖（GET/PUT 正常路径），这里补齐：非 GET/PUT 方法落兜底 404、未知子路径 404。
// 跑法：cd apps/collector-server && node --test --import tsx src/http/settings.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | tag-priority/collect-timeout 全方法 + 未知路径 | 通过 | 非 GET/PUT → 兜底 404 |
// | R2 | collect-timeout 三键化（缺 douyin 400 / 合法三键 200 往返 / GET 默认 45s） | 通过 | 2026-08-29 S2 抖音平台化 |
// | R3 | /api/status：字段齐全/counts 计数/online_clients=0/uptime 数字/token 不泄露/POST 404 | 通过 | 2026-10-04 Phase 1 web 化 |
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import type Database from 'better-sqlite3';
import { ingestVideo } from '../db/ingest.js';
import { handleSettingsHttp, type StatusContext } from './settings.js';

// 固定 status 上下文（/api/status 测试断言基准；startedAt 取过去 10s → uptime_s ≥ 10 的宽松口径）
const STATUS: StatusContext = {
  host: '127.0.0.1',
  port: 21527,
  authRequired: false,
  tokenConfigured: true,
  allowedHosts: ['collector.local'],
  dbPath: '/data/bilibili-collector.db',
  startedAt: Date.now() - 10_000,
};

function setup(): Promise<{ port: number; cleanup: () => void; db: Database.Database }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-settings-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleSettingsHttp(req, res, db, STATUS);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }, db });
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

test('settings handler：PUT collect-timeout 缺键/越界 → 400 + message 透传；GET 正常（三键）', async () => {
  const { port, cleanup } = await setup();
  try {
    // 缺键：两平台时代旧调用（无 douyin）也可见失败（2026-08-29 douyin 档加入后三键齐全才收）
    const r = await call(port, 'PUT', '/api/settings/collect-timeout', { bilibili: 120_000 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /bilibili, youtube, douyin/);
    const r2 = await call(port, 'PUT', '/api/settings/collect-timeout', { bilibili: 5_000, youtube: 90_000, douyin: 45_000 });
    assert.equal(r2.status, 400);
    // GET 默认值不受失败写影响（douyin 默认 45s 对齐 youtube 窗口档）
    const g = await call(port, 'GET', '/api/settings/collect-timeout');
    assert.equal(g.status, 200);
    assert.equal(g.json.bilibili, 90_000);
    assert.equal(g.json.youtube, 45_000);
    assert.equal(g.json.douyin, 45_000);
    // 三键齐全合法 PUT → 200 往返
    const ok = await call(port, 'PUT', '/api/settings/collect-timeout', { bilibili: 120_000, youtube: 90_000, douyin: 60_000 });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.bilibili, ok.json.youtube, ok.json.douyin], [120_000, 90_000, 60_000]);
  } finally { cleanup(); }
});

test('settings handler：GET /api/status 返回版本/运行时长/配置/库路径/在线数/五表计数；token 明文不外泄', async () => {
  const { port, cleanup, db } = await setup();
  try {
    // 种两条视频（一条带轨、带版本）→ counts.videos=2 / tracks=1 / versions=1
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV-s1', title: '状态一', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [{ lan: 'ai-en', lan_doc: 'AI英语', track_type: 3, versions: [{ origin: 'ai', payload: { body: [{ from: 0, to: 1, content: 'hi' }] }, source_url: 'https://a' }] }],
    });
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV-s2', title: '状态二', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [],
    });
    const r = await call(port, 'GET', '/api/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.version, '0.1.0');
    assert.equal(typeof r.json.uptime_s, 'number');
    assert.ok(r.json.uptime_s >= 10); // startedAt 固定在 10s 前 → uptime 至少 10
    assert.deepEqual(r.json.config, {
      host: '127.0.0.1',
      port: 21527,
      auth_required: false,
      token_configured: true, // 布尔 only
      allowed_hosts: ['collector.local'],
    });
    assert.equal(r.json.db_path, '/data/bilibili-collector.db');
    assert.equal(r.json.online_clients, 0); // 测试进程无 WS 连接
    assert.deepEqual(r.json.counts, { videos: 2, creators: 1, tracks: 1, versions: 1, collect_tasks: 0 });
    // token 明文不外泄：响应任何层级都无 token 字段，token_configured 恒为布尔
    assert.equal(typeof r.json.config.token_configured, 'boolean');
    assert.ok(!('token' in r.json) && !('token' in r.json.config));
  } finally { cleanup(); }
});

test('settings handler：/api/status 非 GET（POST）→ 兜底 404', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await call(port, 'POST', '/api/status', {});
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});
