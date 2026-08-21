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
import { ingestVideo } from '../db/ingest.js';
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

test('GET 列表/单查：任务带出库内视频标题（LEFT JOIN videos.title），未入库为 null', async () => {
  const ctx = await setup();
  try {
    // 库里已有 BV1TITLE01xx（标题「标题直接展示测试」）；BV1NOTLIB0x 不在库（BV+10 位满足解析校验）
    ingestVideo(ctx.db, {
      source: 'bilibili',
      video: { source_vid: 'BV1TITLE01xx', title: '标题直接展示测试', creator: { source_uid: 'u1', name: 'UP' }, extra: {}, duration: 100, published_at: 1700000000000 },
      tracks: [],
    });
    const withTitle = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1TITLE01xx' });
    const noTitle = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1NOTLIB0xy' });
    assert.equal(withTitle.status, 200);
    assert.equal(noTitle.status, 200);

    const list = await httpReq(ctx.port, 'GET', '/api/collect-tasks?limit=10');
    assert.equal(list.status, 200);
    const t1 = list.json.items.find((i: any) => i.id === withTitle.json.task.id);
    const t2 = list.json.items.find((i: any) => i.id === noTitle.json.task.id);
    assert.equal(t1.title, '标题直接展示测试'); // 命中 videos → 标题直出
    assert.equal(t2.title, null);                // 未入库 → null

    const one = await httpReq(ctx.port, 'GET', `/api/collect-tasks/${withTitle.json.task.id}`);
    assert.equal(one.json.task.title, '标题直接展示测试');
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

// ── 单条创建未终态去重（2026-08-21）：对齐批量端点判据，防手机双击双采 ──

test('POST /api/collect-tasks：同视频已有 pending/dispatched → 返回既有任务（created:false），不新建', async () => {
  const ctx = await setup();
  try {
    const r1 = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.created, true); // 新建

    // 双击/重提交（手机分享文本）：仍 pending → 返回同一条任务
    const r2 = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: '再看一遍 https://www.bilibili.com/video/BV1xx411c7mD' });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.ok, true);
    assert.equal(r2.json.created, false);
    assert.equal(r2.json.task.id, r1.json.task.id);

    // dispatched（派发在途）同样视为未终态去重命中
    ctx.db.prepare("UPDATE collect_tasks SET status='dispatched', client_id='ext-A' WHERE id=?").run(r1.json.task.id);
    const r3 = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    assert.equal(r3.json.created, false);
    assert.equal(r3.json.task.id, r1.json.task.id);

    const list = await httpReq(ctx.port, 'GET', '/api/collect-tasks?limit=10');
    assert.equal(list.json.total, 1); // 始终只有一条
  } finally { ctx.cleanup(); }
});

test('POST /api/collect-tasks：终态（succeeded/failed）允许重采 → 新建（created:true）', async () => {
  const ctx = await setup();
  try {
    const r1 = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    ctx.db.prepare("UPDATE collect_tasks SET status='succeeded', finished_at=? WHERE id=?").run(Date.now(), r1.json.task.id);
    const r2 = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    assert.equal(r2.json.created, true);
    assert.notEqual(r2.json.task.id, r1.json.task.id); // 新任务

    ctx.db.prepare("UPDATE collect_tasks SET status='failed', error='x', finished_at=? WHERE id=?").run(Date.now(), r2.json.task.id);
    const r3 = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    assert.equal(r3.json.created, true);
    const list = await httpReq(ctx.port, 'GET', '/api/collect-tasks?limit=10');
    assert.equal(list.json.total, 3);
  } finally { ctx.cleanup(); }
});

// ── 批量端点 body 统一格式（2026-08-21）：{vids[], source?, client_id?}，bvids 旧键删除 ──

test('POST /api/collect-tasks/batch：统一 body {vids, source, client_id}，client_id 透传 creator_client_id', async () => {
  const ctx = await setup();
  try {
    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks/batch', {
      vids: ['gaDdrDdczO4', 'F3lL98Pj90o'],
      source: 'youtube',
      client_id: 'ext-A',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.created, 2);
    assert.equal(r.json.tasks[0].source, 'youtube');
    for (const t of r.json.tasks) {
      assert.equal(t.creator_client_id, 'ext-A'); // snake_case client_id → sticky 派发依据
      assert.equal(t.status, 'pending');
    }
  } finally { ctx.cleanup(); }
});

test('POST /api/collect-tasks/batch：source 缺省 bilibili（旧 {bvids} 语义并入 vids）', async () => {
  const ctx = await setup();
  try {
    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks/batch', { vids: ['BV1xx411c7mD', 'BV1yy411c7mD'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.created, 2);
    assert.equal(r.json.tasks[0].source, 'bilibili');
    assert.equal(r.json.tasks[0].creator_client_id, null); // 未传 client_id → null（任意客户端可接）
  } finally { ctx.cleanup(); }
});

test('POST /api/collect-tasks/batch：bvids 旧键 / camelCase clientId 均不认 → 400 / 视为未传', async () => {
  const ctx = await setup();
  try {
    // bvids 键彻底删除：旧格式请求失败可见，逼调用方升级（无外部消费者，一次改齐）
    const r1 = await httpReq(ctx.port, 'POST', '/api/collect-tasks/batch', { bvids: ['BV1xx411c7mD'] });
    assert.equal(r1.status, 400);
    assert.equal(r1.json.ok, false);
    assert.match(r1.json.error, /vids/);

    // clientId（camelCase）不是合法键：视为未传，任务 creator_client_id = null
    const r2 = await httpReq(ctx.port, 'POST', '/api/collect-tasks/batch', { vids: ['BV1xx411c7mD'], clientId: 'ext-A' });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.tasks[0].creator_client_id, null);
  } finally { ctx.cleanup(); }
});

// ── 扩展版本过旧分类（2026-08-21）：未知 action 的失败回执 ≠ 普通采集失败 ──

test('扩展回执 unknown action：任务 error 写「扩展版本过旧」（旧扩展形态：error 字符串）', async () => {
  const ctx = await setup();
  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ext`);
    await new Promise((r) => { ws!.once('open', r); });
    ws!.send(JSON.stringify({ type: 'hello', ext_version: '0.0.1', token: 'test-token', client_id: 'ext-old', reporting_enabled: true }));
    ws!.on('message', (d) => {
      const m = JSON.parse(d.toString());
      // 模拟旧扩展不认识 server 新增的 action
      if (m.action) ws!.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: `unknown action: ${m.action}` }));
    });
    await wait(100);

    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    await wait(300);
    const t = getTask(ctx.db, r.json.task.id)!;
    assert.equal(t.status, 'failed');
    assert.equal(t.error, '扩展版本过旧，请更新扩展后重试'); // 区分于普通采集失败
  } finally { ws?.close(); ctx.cleanup(); }
});

test('扩展回执 needs_update:true：同样归类「扩展版本过旧」（新扩展显式标记形态）', async () => {
  const ctx = await setup();
  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ext`);
    await new Promise((r) => { ws!.once('open', r); });
    ws!.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-new', reporting_enabled: true }));
    ws!.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.action) ws!.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: 'action not supported by this version', needs_update: true }));
    });
    await wait(100);

    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    await wait(300);
    const t = getTask(ctx.db, r.json.task.id)!;
    assert.equal(t.status, 'failed');
    assert.equal(t.error, '扩展版本过旧，请更新扩展后重试');
  } finally { ws?.close(); ctx.cleanup(); }
});

// ── task-update / task-delete 推送（2026-08-21）：任务状态落库后广播给已握手连接 ──

// 挂一个只收集推送的 message listener（connectExt 内部已挂的 listener 负责回 result，多 listener 共存）
function collectPushes(ws: WebSocket): Array<{ type: string; task?: any; taskId?: number }> {
  const events: Array<{ type: string; task?: any; taskId?: number }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'task-update' || m.type === 'task-delete') events.push(m);
  });
  return events;
}

test('task-update 推送：建任务→派发→终态，WS 收到 pending→dispatched→succeeded 序列', async () => {
  const ctx = await setup();
  let ws: WebSocket | null = null;
  try {
    ws = await connectExt(ctx.port, 'ext-A');
    const events = collectPushes(ws);
    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    await wait(400);
    const mine = events.filter((e) => e.task?.id === r.json.task.id);
    assert.deepEqual(mine.map((e) => e.task.status), ['pending', 'dispatched', 'succeeded']); // 单连接 FIFO，发送序即到达序
    assert.ok(!('batch_total' in mine.at(-1)!.task)); // 单条任务（batch_id null）不附加批次分母
    const final = mine.at(-1)!.task;
    assert.ok(final.finished_at);                      // 终态行带完成时刻
    assert.ok(String(final.result).includes('"tracks":2')); // result 整行可回放
  } finally { ws?.close(); ctx.cleanup(); }
});

test('task-update 推送：失败回执 → failed 行带 error 原文', async () => {
  const ctx = await setup();
  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ext`);
    await new Promise((r) => { ws!.once('open', r); });
    ws!.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-B', reporting_enabled: true }));
    const events = collectPushes(ws);
    ws!.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.action === 'fetch-subtitle') ws!.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: 'need_login' }));
    });
    await wait(100);

    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    await wait(300);
    const mine = events.filter((e) => e.task?.id === r.json.task.id);
    assert.deepEqual(mine.map((e) => e.task.status), ['pending', 'dispatched', 'failed']);
    assert.equal(mine.at(-1)!.task.error, 'need_login');
  } finally { ws?.close(); ctx.cleanup(); }
});

test('task-delete 推送：DELETE 后广播 {type:"task-delete",taskId}（无顶层 id）', async () => {
  const ctx = await setup();
  let ws: WebSocket | null = null;
  try {
    ws = await connectExt(ctx.port, 'ext-A');
    const events = collectPushes(ws);
    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    await wait(300); // 等任务走完（终态行删除不影响推送断言）
    await httpReq(ctx.port, 'DELETE', `/api/collect-tasks/${r.json.task.id}`);
    await wait(200);
    const dels = events.filter((e) => e.type === 'task-delete');
    assert.equal(dels.length, 1);
    assert.equal(dels[0].taskId, r.json.task.id);
    // 无顶层 id：不穿过旧扩展 background 的 !msg.id 守卫（否则每条删除回一张
    // "unknown action" 失败回执，噪音 + needs_update 误导）
    assert.ok(!('id' in dels[0]));
  } finally { ws?.close(); ctx.cleanup(); }
});

test('task-update 推送：批量建任务逐条广播（两条串行执行，各走完整序列）', async () => {
  const ctx = await setup();
  let ws: WebSocket | null = null;
  try {
    ws = await connectExt(ctx.port, 'ext-A');
    const events = collectPushes(ws);
    const r = await httpReq(ctx.port, 'POST', '/api/collect-tasks/batch', { vids: ['BV1xx411c7mD', 'BV1yy411c7mD'], source: 'bilibili' });
    await wait(300);
    const ids = r.json.tasks.map((t: any) => t.id);
    for (const id of ids) {
      const mine = events.filter((e) => e.task?.id === id);
      assert.deepEqual(mine.map((e) => e.task.status), ['pending', 'dispatched', 'succeeded']);
      // 批次分母：批次建齐后的推送携带 batch_total = 同批成员总数（popup 聚合分母无需列表全量）。
      // 首条 pending 推送时同批仅插入 1 条（逐条创建逐条推），batch_total 是当时的实时数
      //（1 → 2 递增），取最新推送即正确分母。
      assert.equal(mine.at(-1)!.task.batch_total, 2);
    }
    assert.equal(new Set(ids).size, 2); // 批量每个任务 id 都有推送
  } finally { ws?.close(); ctx.cleanup(); }
});

// ── 批次聚合标签（2026-08-21，展示侧）：同批任务共享 batch_id，列表批次成员完整返回 ──

test('批量端点：同批任务共享 batch_id；单条任务 batch_id 为 null', async () => {
  const ctx = await setup();
  try {
    const batch = await httpReq(ctx.port, 'POST', '/api/collect-tasks/batch', { vids: ['BV1xx411c7mD', 'BV1yy411c7mD'] });
    assert.equal(batch.json.created, 2);
    const batchIds = new Set(batch.json.tasks.map((t: any) => t.batch_id));
    assert.equal(batchIds.size, 1);          // 同批同一标签
    assert.ok([...batchIds][0]);             // 非 null/空

    const single = await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1zz411c7mD' });
    assert.equal(single.json.task.batch_id, null); // 单条不聚合
  } finally { ctx.cleanup(); }
});

test('列表批次补全：limit 截断后批次成员仍全量返回（聚合进度可算全）', async () => {
  const ctx = await setup();
  try {
    // 批量 3 条（同批）+ 之后 1 条单任务（id 更大,挤占 limit 种子）
    const batch = await httpReq(ctx.port, 'POST', '/api/collect-tasks/batch', { vids: ['BV1xx411c7mD', 'BV1yy411c7mD', 'BV1zz411c7mD'] });
    await httpReq(ctx.port, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/BV1qq411c7mD' });
    const batchId = batch.json.tasks[0].batch_id;

    // limit=2 种子只含单任务 + 批次最新一条,补全后批次 3 条全在
    const list = await httpReq(ctx.port, 'GET', '/api/collect-tasks?limit=2');
    const members = list.json.items.filter((i: any) => i.batch_id === batchId);
    assert.equal(members.length, 3);
    assert.equal(list.json.total, 4); // total 仍是表总行数
  } finally { ctx.cleanup(); }
});
