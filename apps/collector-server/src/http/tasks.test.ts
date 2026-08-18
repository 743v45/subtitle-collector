import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../db/migrate.js';
import { attachWsServer } from '../ws/server.js';
import { handleTasksHttp } from './tasks.js';
import { attachTaskScheduler, getTask } from '../tasks/tasks.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-http-tasks-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const httpServer = createServer((req, res) => { void handleTasksHttp(req, res, db); });
  return new Promise<{ port: number; db: Database.Database; cleanup: () => void }>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port;
      attachWsServer(httpServer, db, 'test-token');
      attachTaskScheduler(db);
      resolve({ port, db, cleanup: () => { httpServer.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}

function httpReq(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ''; res.on('data', (c: Buffer) => (buf += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(buf || '{}') }));
    });
    if (data) req.write(data);
    req.end();
  });
}

// 模拟扩展：WS 连接 + hello + 对 fetch-subtitle / fetch-youtube-subtitle 回 result
function connectExt(port: number, clientId: string): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: clientId, reporting_enabled: true }));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.action === 'fetch-subtitle') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data: { bvid: m.bvid, tracks: 2, ingested: true } }));
        if (m.action === 'fetch-youtube-subtitle') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data: { videoId: m.videoId, captured: 1, tracks: 1 } }));
      });
      setTimeout(() => resolve(ws), 50); // 等 hello-ack / 调度器 kick 完成
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('POST /api/collect-tasks：分享文本 → 建 pending 任务 → 扩展在线时自动派发 → succeeded', async () => {
  const ctx = await setup();
  let ws: WebSocket | null = null;
  try {
    ws = await connectExt(ctx.port, 'ext-A');
    // B 站标准链接（不经短链展开,直接可解析）
    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', {
      text: '【快来看】 https://www.bilibili.com/video/BV1xx411c7mD 超好看',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.task.source, 'bilibili');
    assert.equal(r.json.task.source_vid, 'BV1xx411c7mD');
    assert.equal(r.json.task.status, 'pending'); // 响应时还是 pending（派发异步）

    // 调度器 kick → dispatchTask → 扩展回 result → succeeded
    await wait(300);
    const t = getTask(ctx.db, r.json.task.id)!;
    assert.equal(t.status, 'succeeded');
    assert.equal(t.client_id, 'ext-A');
    assert.ok(t.finished_at);
    assert.ok(t.result?.includes('"tracks":2'));
  } finally { ws?.close(); ctx.cleanup(); }
});

test('POST /api/collect-tasks：YouTube 链接 → fetch-youtube-subtitle 派发', async () => {
  const ctx = await setup();
  let ws: WebSocket | null = null;
  try {
    ws = await connectExt(ctx.port, 'ext-A');
    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    assert.equal(r.status, 200);
    assert.equal(r.json.task.source, 'youtube');
    await wait(300);
    const t = getTask(ctx.db, r.json.task.id)!;
    assert.equal(t.status, 'succeeded');
    assert.ok(t.result?.includes('"captured":1'));
  } finally { ws?.close(); ctx.cleanup(); }
});

test('无扩展在线：任务停留 pending（不报错）', async () => {
  const ctx = await setup();
  try {
    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    assert.equal(r.status, 200);
    await wait(200);
    const t = getTask(ctx.db, r.json.task.id)!;
    assert.equal(t.status, 'pending');
    assert.equal(t.client_id, null);
  } finally { ctx.cleanup(); }
});

test('POST 非法输入：无链接 / 不可识别 → 400', async () => {
  const ctx = await setup();
  try {
    const r1 = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: '纯文本没有链接' });
    assert.equal(r1.status, 400);
    assert.equal(r1.json.ok, false);
    const r2 = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://example.com/x' });
    assert.equal(r2.status, 400);
  } finally { ctx.cleanup(); }
});

test('GET /api/collect-tasks 与 /api/collect-tasks/:id：列表 + 单查', async () => {
  const ctx = await setup();
  try {
    await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    const list = await httpReq(ctx.port, 'GET', '/api/collect-tasks?limit=10');
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 1);
    assert.equal(list.json.items[0].source_vid, 'BV1xx411c7mD');

    const one = await httpReq(ctx.port, 'GET', `/api/collect-tasks/${list.json.items[0].id}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.task.id, list.json.items[0].id);

    const none = await httpReq(ctx.port, 'GET', '/api/collect-tasks/99999');
    assert.equal(none.status, 404);
  } finally { ctx.cleanup(); }
});

test('DELETE /api/collect-tasks/:id：删除任务 → 列表空、行不存在', async () => {
  const ctx = await setup();
  try {
    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    const id = r.json.task.id;

    const del = await httpReq(ctx.port, 'DELETE', `/api/collect-tasks/${id}`);
    assert.equal(del.status, 200);
    assert.equal(del.json.ok, true);

    const list = await httpReq(ctx.port, 'GET', '/api/collect-tasks?limit=10');
    assert.equal(list.json.total, 0); // GET :id 404 与行删除同路径,下方 HTTP 断言已覆盖

    const gone = await httpReq(ctx.port, 'GET', `/api/collect-tasks/${id}`);
    assert.equal(gone.status, 404);

    const none = await httpReq(ctx.port, 'DELETE', '/api/collect-tasks/99999');
    assert.equal(none.status, 404);
  } finally { ctx.cleanup(); }
});

test('删除 dispatched 任务：飞行中删除后扩展回执为 no-op（行不复活,server 健康）', async () => {
  const ctx = await setup();
  let ws: WebSocket | null = null;
  try {
    // 模拟扩展:收到派发后扣住回执,由测试在 DELETE 之后再放行（卡进 dispatched 飞行窗口）
    ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ext`);
    await new Promise((r) => { ws!.once('open', r); });
    ws!.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-C', reporting_enabled: true }));
    const gotCommand = new Promise<any>((resolve) => {
      ws!.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.action === 'fetch-subtitle') resolve(m);
      });
    });
    await wait(100);

    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    const id = r.json.task.id;
    const cmd = await gotCommand; // 派发已到扩展 → UPDATE dispatched 先于 requestCommand,状态必为 dispatched
    assert.equal(getTask(ctx.db, id)!.status, 'dispatched');

    // 中飞行删除 → 扩展这才回 result → server 回执 UPDATE 不命中行 → no-op
    const del = await httpReq(ctx.port, 'DELETE', `/api/collect-tasks/${id}`);
    assert.equal(del.status, 200);
    ws!.send(JSON.stringify({ type: 'result', id: cmd.id, ok: true, data: { bvid: cmd.bvid, tracks: 2, ingested: true } }));
    await wait(300); // WS 往返 + 回执处理链

    assert.equal(getTask(ctx.db, id), null); // 行不复活
    const list = await httpReq(ctx.port, 'GET', '/api/collect-tasks?limit=10');
    assert.equal(list.status, 200); // server 仍健康
    assert.equal(list.json.total, 0);
  } finally { ws?.close(); ctx.cleanup(); }
});

test('扩展回执失败：任务 → failed,error 存原因', async () => {
  const ctx = await setup();
  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ext`);
    await new Promise((r) => { ws!.once('open', r); });
    ws!.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-B', reporting_enabled: true }));
    ws!.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.action === 'fetch-subtitle') ws!.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: 'need_login' }));
    });
    await wait(100);

    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    await wait(300);
    const t = getTask(ctx.db, r.json.task.id)!;
    assert.equal(t.status, 'failed');
    assert.equal(t.error, 'need_login');
  } finally { ws?.close(); ctx.cleanup(); }
});
