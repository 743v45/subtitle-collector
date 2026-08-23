import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { attachWsServer } from '../ws/server.js';
import { handleClientsHttp } from './clients.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-clients-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const httpServer = createServer((req, res) => handleClientsHttp(req, res));
  return new Promise<{ port: number; cleanup: () => void }>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port;
      attachWsServer(httpServer, db, 'test-token');
      resolve({ port, cleanup: () => { httpServer.close(); rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}
function wsConnect(port: number, clientId: string, enabled: boolean, acceptsTasks: boolean = true): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: clientId, reporting_enabled: enabled, task_dispatch_enabled: acceptsTasks }));
      resolve(ws);
    });
  });
}
function httpReq(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res: IncomingMessage) => {
      let buf = ''; res.on('data', (c: Buffer) => buf += c); res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(buf || '{}') }));
    });
    if (data) req.write(data); req.end();
  });
}

test('GET /api/clients：返回在线客户端', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.status, 200);
    assert.equal(r.json.clients.length, 1);
    assert.equal(r.json.clients[0].client_id, 'ext-A');
    ws.close();
  } finally { ctx.cleanup(); }
});

test('POST /api/clients/:id/reporting：定向关，等回执后返回新状态', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.action === 'set-reporting') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data: { reporting_enabled: m.enabled } }));
    });
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/reporting', { enabled: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.reporting_enabled, false);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('POST 离线 client → 404；enabled 非布尔 → 400', async () => {
  const ctx = await setup();
  try {
    const r1 = await httpReq(ctx.port, 'POST', '/api/clients/ext-NONE/reporting', { enabled: true });
    assert.equal(r1.status, 404);
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    await new Promise(r => setTimeout(r, 50));
    const r2 = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/reporting', { enabled: 'oops' });
    assert.equal(r2.status, 400);
    ws.close();
  } finally { ctx.cleanup(); }
});

// ── 任务派发开关（2026-08-23 仅上报状态）：hello 上报 + listClients 带出 + 远程切换端点 ──

test('GET /api/clients：hello 带 task_dispatch_enabled → listClients 透传；缺省视为接受', async () => {
  const ctx = await setup();
  try {
    const wsOff = await wsConnect(ctx.port, 'ext-off', true, false); // 仅上报客户端
    // 旧扩展形态：hello 不带 task_dispatch_enabled 字段（缺省 fail-open 视为接受）
    const wsOld = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ext`);
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-old', reporting_enabled: true }));
        resolve(ws);
      });
    });
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.json.clients.map((c: any) => [c.client_id, c]));
    assert.equal(byId['ext-off'].task_dispatch_enabled, false);
    assert.equal(byId['ext-old'].task_dispatch_enabled, true, '字段缺省（旧扩展）→ 接受');
    wsOff.close(); wsOld.close();
  } finally { ctx.cleanup(); }
});

test('POST /api/clients/:id/task-dispatch：定向关，等回执后返回新状态并落连接表', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.action === 'set-task-dispatch') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data: { task_dispatch_enabled: m.enabled } }));
    });
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/task-dispatch', { enabled: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.task_dispatch_enabled, false);
    // server 连接表同步更新：listClients 立即可见（调度器可派池据同一数据源过滤）
    const r2 = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r2.json.clients[0].task_dispatch_enabled, false);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('POST /api/clients/:id/task-dispatch：离线 404；enabled 非布尔 400', async () => {
  const ctx = await setup();
  try {
    const r1 = await httpReq(ctx.port, 'POST', '/api/clients/ext-NONE/task-dispatch', { enabled: true });
    assert.equal(r1.status, 404);
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    await new Promise(r => setTimeout(r, 50));
    const r2 = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/task-dispatch', { enabled: 'oops' });
    assert.equal(r2.status, 400);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('task-dispatch-state 消息：popup 本地切换 → server 连接表即时更新', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    await new Promise(r => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: 'task-dispatch-state', enabled: false }));
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.json.clients[0].task_dispatch_enabled, false);
    // 再切回：非 true 严格解析（对齐 reporting-state），true 恢复
    ws.send(JSON.stringify({ type: 'task-dispatch-state', enabled: true }));
    await new Promise(r => setTimeout(r, 50));
    const r2 = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r2.json.clients[0].task_dispatch_enabled, true);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('POST /api/clients/:id/command：下发 command 并等 result 回执', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.action === 'navigate') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data: { opened: true } }));
    });
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/command', {
      action: 'navigate',
      url: 'https://www.bilibili.com/video/BV1xxx',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.client_id, 'ext-A');
    assert.equal(r.json.action, 'navigate');
    // result 直接是扩展回执 data（2026-08-21 去掉 {ok,data} 一层包装，外层 ok 即终判）
    assert.equal(r.json.result.opened, true);
    assert.equal(r.json.result.ok, undefined);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('POST /api/clients/:id/command：扩展回执 ok=false → 502 + 扩展 error 透传', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.action === 'navigate') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: 'need_login' }));
    });
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/command', { action: 'navigate', url: 'x' });
    // 502 = 下游执行体（扩展）失败：error 为扩展回执原文，CLI 经 HTTP 状态即可判失败
    assert.equal(r.status, 502);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'need_login');
    ws.close();
  } finally { ctx.cleanup(); }
});

test('POST /api/clients/:id/command：action 缺失/空串 → 400', async () => {
  const ctx = await setup();
  try {
    const r1 = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/command', { url: 'x' });
    assert.equal(r1.status, 400);
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    await new Promise(r => setTimeout(r, 50));
    const r2 = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/command', { action: '' });
    assert.equal(r2.status, 400);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('POST /api/clients/:id/command：离线 client → 404', async () => {
  const ctx = await setup();
  try {
    const r = await httpReq(ctx.port, 'POST', '/api/clients/ext-NONE/command', { action: 'navigate', url: 'x' });
    assert.equal(r.status, 404);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'client not online');
  } finally { ctx.cleanup(); }
});

test('POST /api/clients/:id/command：扩展不回 result → 504（短 timeout 注入）', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    // 故意不注册 message 处理器：收到 command 不回 result
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/command', {
      action: 'navigate',
      url: 'x',
      timeout: 80,
    });
    assert.equal(r.status, 504);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'extension result timeout');
    ws.close();
  } finally { ctx.cleanup(); }
});

// ── 分支洼地：reporting 超时 504、回执无 error 字段的 502 兜底文案、路由兜底 404 ──

test('POST /api/clients/:id/reporting：扩展不回 result → 504（默认 5s 超时，无 timeout 注入口）', { timeout: 10_000 }, async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    // 不注册 message 处理器：收到 set-reporting 不回 result → 默认 5000ms 超时后 504
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/reporting', { enabled: false });
    assert.equal(r.status, 504);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'extension result timeout');
    ws.close();
  } finally { ctx.cleanup(); }
});

test('POST /api/clients/:id/command：回执 ok=false 且无 error 字段 → 502 + 兜底文案', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.action === 'navigate') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false })); // 不带 error
    });
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/command', { action: 'navigate', url: 'x' });
    assert.equal(r.status, 502);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'extension command failed', '回执无 error 时用兜底文案');
    ws.close();
  } finally { ctx.cleanup(); }
});

test('未知子路径 / 方法不匹配 → 兜底 404', async () => {
  const ctx = await setup();
  try {
    // GET 未知子路径
    let r = await httpReq(ctx.port, 'GET', '/api/clients/xxx');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not found');
    // POST 但子路径形态不匹配（非 /reporting、/command）
    r = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/other', {});
    assert.equal(r.status, 404);
    // reporting 路径但 GET 方法
    r = await httpReq(ctx.port, 'GET', '/api/clients/ext-A/reporting');
    assert.equal(r.status, 404);
    // command 路径但 GET 方法
    r = await httpReq(ctx.port, 'GET', '/api/clients/ext-A/command');
    assert.equal(r.status, 404);
  } finally { ctx.cleanup(); }
});
