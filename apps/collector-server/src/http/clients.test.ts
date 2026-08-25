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
  const httpServer = createServer((req, res) => handleClientsHttp(req, res, db));
  return new Promise<{ port: number; cleanup: () => void; injectBadLogin: (clientId: string, raw?: string) => void; deleteClientRow: (clientId: string) => void; insertClient: (clientId: string, name: string | null, firstSeen: number, lastSeen: number) => void }>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port;
      attachWsServer(httpServer, db, 'test-token');
      resolve({
        port,
        cleanup: () => { httpServer.close(); rmSync(dir, { recursive: true, force: true }); },
        // 直写坏 bili_login（手工库/旧版本脏数据形态），测 listClients 解析容错
        injectBadLogin: (clientId: string, raw?: string) =>
          db.prepare('UPDATE clients SET bili_login = ? WHERE client_id = ?').run(raw ?? '{bad json', clientId),
        // 直删注册表行（模拟异常库：在线但不在 DB），测 listClients 防御分支不漏显示
        deleteClientRow: (clientId: string) =>
          db.prepare('DELETE FROM clients WHERE client_id = ?').run(clientId),
        // 直插历史注册行（排序测试用：确定性 first_seen/last_seen 时间线）
        insertClient: (clientId: string, name: string | null, firstSeen: number, lastSeen: number) =>
          db.prepare('INSERT INTO clients (client_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)').run(clientId, name, firstSeen, lastSeen),
      });
    });
  });
}
// clientName 三态（2026-08-24 客户端命名）：string=hello 带名 / null=hello 带 client_name:null（显式清除）/
// undefined=hello 不带该字段（旧扩展形态，DB 旧名不动）；biliLogin/ytLogin 同理（undefined=旧扩展不带）
function wsConnect(port: number, clientId: string, enabled: boolean, acceptsTasks: boolean = true, clientName?: string | null, biliLogin?: Record<string, unknown>, ytLogin?: Record<string, unknown>): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    ws.once('open', () => {
      const hello: Record<string, unknown> = { type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: clientId, reporting_enabled: enabled, task_dispatch_enabled: acceptsTasks };
      if (clientName !== undefined) hello.client_name = clientName;
      if (biliLogin !== undefined) hello.bili_login = biliLogin;
      if (ytLogin !== undefined) hello.yt_login = ytLogin;
      ws.send(JSON.stringify(hello));
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

test('reporting-state 消息：popup 本地切换上报 → server 连接表即时更新（畸形值严格按 false）', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    await new Promise(r => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: 'reporting-state', enabled: false }));
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.json.clients[0].reporting_enabled, false);
    // 畸形 enabled（非 true 严格解析 → false）：对齐 task-dispatch-state 语义
    ws.send(JSON.stringify({ type: 'reporting-state', enabled: 'on' }));
    await new Promise(r => setTimeout(r, 50));
    const r2 = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r2.json.clients[0].reporting_enabled, false);
    ws.send(JSON.stringify({ type: 'reporting-state', enabled: true }));
    await new Promise(r => setTimeout(r, 50));
    const r3 = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r3.json.clients[0].reporting_enabled, true);
    ws.close();
  } finally { ctx.cleanup(); }
});

// ── 客户端命名（2026-08-24 popup 改名，id 不变）：hello 上报名 + client-name-state 推送改名 + 离线留存 ──

test('GET /api/clients：hello 带 client_name → 列表带名字与在线时间戳', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true, true, '书房 iMac');
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.status, 200);
    const c = r.json.clients[0];
    assert.equal(c.client_id, 'ext-A');
    assert.equal(c.client_name, '书房 iMac');
    assert.equal(c.connected, true);
    assert.equal(typeof c.connected_at, 'number', '「在线时长」起算点');
    assert.equal(typeof c.first_seen_at, 'number');
    assert.equal(typeof c.last_seen_at, 'number');
    ws.close();
  } finally { ctx.cleanup(); }
});

test('client-name-state：popup 改名推送 → 连接表 + DB 即时可见；null 清除', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true, true, '旧名');
    await new Promise(r => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: 'client-name-state', name: '新名' }));
    await new Promise(r => setTimeout(r, 50));
    let r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.json.clients[0].client_name, '新名');
    // null = 清除名字（popup 清空保存）
    ws.send(JSON.stringify({ type: 'client-name-state', name: null }));
    await new Promise(r => setTimeout(r, 50));
    r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.json.clients[0].client_name, null);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('断开后客户端留存列表：connected:false + last_seen_at 刷新 + 开关未知 null', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true, true, '书房');
    await new Promise(r => setTimeout(r, 50));
    const before = (await httpReq(ctx.port, 'GET', '/api/clients')).json.clients[0];
    ws.close();
    await new Promise(r => setTimeout(r, 80)); // 等 server 端 close handler（touch last_seen_at）
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.json.clients.length, 1, '离线客户端不消失（DB 注册表留存）');
    const c = r.json.clients[0];
    assert.equal(c.connected, false);
    assert.equal(c.client_name, '书房', '名字留存');
    assert.equal(c.connected_at, null);
    assert.equal(c.reporting_enabled, null, '离线开关未知（远端切换须在线）');
    assert.equal(c.task_dispatch_enabled, null);
    assert.ok(c.last_seen_at >= before.last_seen_at, '断开时刻刷新 last_seen_at（「离线时长」起算点）');
  } finally { ctx.cleanup(); }
});

test('旧扩展 hello 不带 client_name：重连不抹 DB 旧名（列表回落历史名）', async () => {
  const ctx = await setup();
  try {
    const ws1 = await wsConnect(ctx.port, 'ext-A', true, true, '历史名');
    await new Promise(r => setTimeout(r, 50));
    ws1.close();
    await new Promise(r => setTimeout(r, 80));
    // 旧扩展形态重连：wsConnect 第 5 参缺省 → hello 不带 client_name 字段
    const ws2 = await wsConnect(ctx.port, 'ext-A', true);
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    const c = r.json.clients[0];
    assert.equal(c.connected, true);
    assert.equal(c.client_name, '历史名', '连接表未带名 → 回落 DB 历史名');
    ws2.close();
  } finally { ctx.cleanup(); }
});

// ── B 站登录态（2026-08-24 充电视频 1190 no_subtitle 根因可观察化）：hello 上报 + login-state 推送 + 离线留存 ──

test('GET /api/clients：hello 带 bili_login → listClients 透传登录态与账号', async () => {
  const ctx = await setup();
  try {
    const login = { is_login: true, mid: '3546645614562148', uname: '测试用户', vip: true };
    const ws = await wsConnect(ctx.port, 'ext-A', true, true, undefined, login);
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.status, 200);
    const c = r.json.clients[0];
    assert.deepEqual(c.bili_login, login);
    assert.equal(c.ext_version, '0.1.0', 'hello 的 ext_version 透传');
    ws.close();
  } finally { ctx.cleanup(); }
});

test('login-state：登录态变化推送 → 连接表 + DB 即时可见（未登录也能上报）', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true, true, undefined, { is_login: true, mid: '1', uname: '旧账号' });
    await new Promise(r => setTimeout(r, 50));
    // 用户在浏览器退出登录 → 扩展推送未登录态
    ws.send(JSON.stringify({ type: 'login-state', login: { is_login: false } }));
    await new Promise(r => setTimeout(r, 50));
    let r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.deepEqual(r.json.clients[0].bili_login, { is_login: false });
    // 畸形 login（探测失败）：不清除 DB 旧值（保守：探测失败 ≠ 未登录）
    ws.send(JSON.stringify({ type: 'login-state', login: null }));
    await new Promise(r => setTimeout(r, 50));
    r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.deepEqual(r.json.clients[0].bili_login, { is_login: false }, '畸形推送不动现值');
    ws.close();
  } finally { ctx.cleanup(); }
});

test('断开后登录态离线留存：DB 快照带出（在线时上报过的最后状态）', async () => {
  const ctx = await setup();
  try {
    const login = { is_login: false };
    const ws = await wsConnect(ctx.port, 'ext-A', true, true, undefined, login);
    await new Promise(r => setTimeout(r, 50));
    ws.close();
    await new Promise(r => setTimeout(r, 80));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    const c = r.json.clients[0];
    assert.equal(c.connected, false);
    assert.deepEqual(c.bili_login, { is_login: false }, '离线回落 DB 快照');
    assert.equal(c.ext_version, '0.1.0', '离线版本来自 DB 列');
  } finally { ctx.cleanup(); }
});

test('旧扩展 hello 不带 bili_login：重连不抹 DB 登录态快照', async () => {
  const ctx = await setup();
  try {
    const ws1 = await wsConnect(ctx.port, 'ext-A', true, true, undefined, { is_login: true, mid: '7', uname: '账号' });
    await new Promise(r => setTimeout(r, 50));
    ws1.close();
    await new Promise(r => setTimeout(r, 80));
    // 旧扩展形态重连：hello 不带 bili_login 字段（wsConnect 第 6 参缺省）
    const ws2 = await wsConnect(ctx.port, 'ext-A', true);
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.deepEqual(r.json.clients[0].bili_login, { is_login: true, mid: '7', uname: '账号' }, '旧式 hello 不抹 DB 快照');
    ws2.close();
  } finally { ctx.cleanup(); }
});

test('分支洼地：DB 坏 JSON 快照解析容错 → bili_login null 不炸', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true); // 先 hello 建行
    await new Promise(r => setTimeout(r, 50));
    ws.close();
    await new Promise(r => setTimeout(r, 80));
    // 直写坏 JSON（手工库/旧版本脏数据）：parseLogin catch → null
    ctx.injectBadLogin('ext-A');
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.json.clients[0].bili_login, null, '坏 JSON 容错为 null');
    // 非 boolean is_login 的 JSON 同样容错
    ctx.injectBadLogin('ext-A', '{"is_login":"yes"}');
    const r2 = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r2.json.clients[0].bili_login, null);
  } finally { ctx.cleanup(); }
});

test('分支洼地：在线但不在 DB（异常库直删行）→ listClients 防御分支不漏显示', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true, true, undefined, { is_login: false });
    await new Promise(r => setTimeout(r, 50));
    ctx.deleteClientRow('ext-A'); // 模拟异常库：hello 已 upsert 但行被外部删掉
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.json.clients.length, 1, '在线客户端不因 DB 缺行而漏显示');
    const c = r.json.clients[0];
    assert.equal(c.client_id, 'ext-A');
    assert.equal(c.connected, true);
    assert.deepEqual(c.bili_login, { is_login: false }, '防御行走连接表现值');
    ws.close();
  } finally { ctx.cleanup(); }
});

test('分支洼地：hello 带畸形 bili_login（非对象）→ 连接表 null，列表回落 DB 快照', async () => {
  const ctx = await setup();
  try {
    // 先用正常 hello 留下 DB 快照
    const ws1 = await wsConnect(ctx.port, 'ext-A', true, true, undefined, { is_login: true, mid: '9' });
    await new Promise(r => setTimeout(r, 50));
    ws1.close();
    await new Promise(r => setTimeout(r, 80));
    // 重连但 bili_login 是畸形字符串（parseLoginMsg false → 连接表 null → 回落 DB）
    const ws2 = await wsConnect(ctx.port, 'ext-A', true, true, undefined, 'not-an-object' as any);
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.deepEqual(r.json.clients[0].bili_login, { is_login: true, mid: '9' }, '在线现值 null 回落 DB 快照');
    ws2.close();
  } finally { ctx.cleanup(); }
});

test('分支洼地：hello bili_login 是对象但 is_login 非布尔 / client_id 空串 → 均按未上报处理', async () => {
  const ctx = await setup();
  try {
    // is_login 非布尔（parseLoginMsg 严格解析 false）→ 连接表 null
    const ws1 = await wsConnect(ctx.port, 'ext-A', true, true, undefined, { is_login: 'yes' } as any);
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.json.clients.length, 1);
    assert.equal(r.json.clients[0].bili_login, null, '非布尔 is_login 按未上报');
    ws1.close();
    await new Promise(r => setTimeout(r, 80));
    // client_id 空串 → 视同未握手身份（不入连接表不落库），server 不产生新行
    const ws2 = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ext`);
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.21', token: 'test-token', client_id: '', reporting_enabled: true }));
        resolve(ws);
      });
    });
    await new Promise(r => setTimeout(r, 50));
    const r2 = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r2.json.clients.length, 1, '空串 client_id 不产生新行（原 ext-A 留存）');
    ws2.close();
  } finally { ctx.cleanup(); }
});

test('分支洼地：hello 无 ext_version 重连不抹 DB 旧版本；无 client_id 的 login-state 不落库不炸', async () => {
  const ctx = await setup();
  try {
    const ws1 = await wsConnect(ctx.port, 'ext-A', true);
    await new Promise(r => setTimeout(r, 50));
    ws1.close();
    await new Promise(r => setTimeout(r, 80));
    // hello 不带 ext_version（更旧扩展形态）：conn.extVersion null → meta.extVersion undefined → DB 旧版本保留
    const ws2 = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ext`);
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: 'test-token', client_id: 'ext-A', reporting_enabled: true, bili_login: { is_login: false } }));
        resolve(ws);
      });
    });
    await new Promise(r => setTimeout(r, 50));
    let r = await httpReq(ctx.port, 'GET', '/api/clients');
    const c = r.json.clients[0];
    assert.equal(c.ext_version, '0.1.0', '无 ext_version 重连不抹 DB 旧版本');
    assert.deepEqual(c.bili_login, { is_login: false }, 'bili_login 正常上报');

    // hello 无 client_id：连接不入表，login-state 到达时 conn.clientId null → 跳过落库不炸
    const ws3 = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ext`);
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', reporting_enabled: true, bili_login: { is_login: true } }));
        resolve(ws);
      });
    });
    await new Promise(r => setTimeout(r, 50));
    ws3.send(JSON.stringify({ type: 'login-state', login: { is_login: false } }));
    await new Promise(r => setTimeout(r, 50));
    r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.json.clients.length, 1, '无 client_id 连接不产生新行');
    assert.deepEqual(r.json.clients[0].bili_login, { is_login: false }, 'login-state 未被无 id 连接污染');
    ws2.close(); ws3.close();
  } finally { ctx.cleanup(); }
});

// ── YouTube 登录态（2026-08-25 镜像 bili_login）：hello 上报 + login-state 单字段推送 + 离线留存 ──

test('GET /api/clients：hello 带 yt_login → listClients 透传（与 bili_login 并存）', async () => {
  const ctx = await setup();
  try {
    const bili = { is_login: true, mid: '3546645614562148', uname: '测试用户', vip: true };
    const yt = { is_login: true };
    const ws = await wsConnect(ctx.port, 'ext-A', true, true, undefined, bili, yt);
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.status, 200);
    const c = r.json.clients[0];
    assert.deepEqual(c.bili_login, bili);
    assert.deepEqual(c.yt_login, yt);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('login-state：yt_login 推送 → 连接表 + DB 即时可见；只带 yt_login 不动 B 站现值', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true, true, undefined, { is_login: true, mid: '1', uname: '账号' }, { is_login: true });
    await new Promise(r => setTimeout(r, 50));
    // YouTube 退出登录 → 扩展单平台已知时只带 yt_login 字段（不带 login）
    ws.send(JSON.stringify({ type: 'login-state', yt_login: { is_login: false } }));
    await new Promise(r => setTimeout(r, 50));
    let r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.deepEqual(r.json.clients[0].yt_login, { is_login: false }, 'yt 推送落连接表');
    assert.deepEqual(r.json.clients[0].bili_login, { is_login: true, mid: '1', uname: '账号' }, '缺 login 字段不动 B 站现值');
    // 旧扩展形态：只带 login 不带 yt_login → yt 现值不动
    ws.send(JSON.stringify({ type: 'login-state', login: { is_login: false } }));
    await new Promise(r => setTimeout(r, 50));
    r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.deepEqual(r.json.clients[0].bili_login, { is_login: false }, 'bili 推送落连接表');
    assert.deepEqual(r.json.clients[0].yt_login, { is_login: false }, '缺 yt_login 字段不动 yt 现值');
    ws.close();
  } finally { ctx.cleanup(); }
});

test('断开后 yt_login 离线留存：DB 快照带出（在线时上报过的最后状态）', async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true, true, undefined, undefined, { is_login: false });
    await new Promise(r => setTimeout(r, 50));
    ws.close();
    await new Promise(r => setTimeout(r, 80));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    const c = r.json.clients[0];
    assert.equal(c.connected, false);
    assert.deepEqual(c.yt_login, { is_login: false }, '离线回落 DB 快照');
    assert.equal(c.bili_login, null, '未上报平台为 null');
  } finally { ctx.cleanup(); }
});

test('hello 带 client_name: null → 显式清除 DB 旧名', async () => {
  const ctx = await setup();
  try {
    const ws1 = await wsConnect(ctx.port, 'ext-A', true, true, '要被抹的名');
    await new Promise(r => setTimeout(r, 50));
    ws1.close();
    await new Promise(r => setTimeout(r, 80));
    const ws2 = await wsConnect(ctx.port, 'ext-A', true, true, null); // 显式 null
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'GET', '/api/clients');
    assert.equal(r.json.clients[0].client_name, null, '显式 null 抹掉 DB 旧名');
    ws2.close();
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

test('POST /api/clients/:id/task-dispatch：扩展不回 result → 504（默认 5s 超时）', { timeout: 10_000 }, async () => {
  const ctx = await setup();
  try {
    const ws = await wsConnect(ctx.port, 'ext-A', true);
    // 不注册 message 处理器：收到 set-task-dispatch 不回 result → 超时 504
    await new Promise(r => setTimeout(r, 50));
    const r = await httpReq(ctx.port, 'POST', '/api/clients/ext-A/task-dispatch', { enabled: false });
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

// ── 2026-08-25 全端点排序：GET /api/clients sort=last_seen/first_seen/name + desc；非法 → 400 ──
test('GET /api/clients：sort=name/first_seen + desc + 非法 sort 400（name NULLS LAST）', async () => {
  const ctx = await setup();
  try {
    // 注册三个客户端（直写 DB 模拟历史注册，时间线确定）：ext-A（有名）、ext-B（无名）、ext-C（有名）
    ctx.insertClient('ext-A', 'alpha', 300, 300);
    ctx.insertClient('ext-B', null, 100, 500);
    ctx.insertClient('ext-C', 'zeta', 200, 400);
    const ids = (r: { json: { clients: Array<{ client_id: string }> } }) => r.json.clients.map((c) => c.client_id);
    const req = (path: string) => httpReq(ctx.port, 'GET', path);

    // 缺省 last_seen DESC：B(500) > C(400) > A(300)
    let r = await req('/api/clients');
    assert.deepEqual(ids(r), ['ext-B', 'ext-C', 'ext-A']);
    // last_seen 升序
    r = await req('/api/clients?sort=last_seen&desc=0');
    assert.deepEqual(ids(r), ['ext-A', 'ext-C', 'ext-B']);
    // first_seen DESC：A(300) > C(200) > B(100)
    r = await req('/api/clients?sort=first_seen');
    assert.deepEqual(ids(r), ['ext-A', 'ext-C', 'ext-B']);
    // name 排序：alpha < zeta，NULL（未命名）恒排尾（NULLS LAST 不随方向翻转）
    r = await req('/api/clients?sort=name&desc=0');
    assert.deepEqual(ids(r), ['ext-A', 'ext-C', 'ext-B']);
    r = await req('/api/clients?sort=name&desc=1');
    assert.deepEqual(ids(r), ['ext-C', 'ext-A', 'ext-B']);
    // 非法 sort → 400
    r = await req('/api/clients?sort=bogus');
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /sort must be one of last_seen\|first_seen\|name/);
  } finally { ctx.cleanup(); }
});
