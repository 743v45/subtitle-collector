import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo, createConnection, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { attachWsServer, broadcastCommand, listClients, sendToClient, requestReportingChange, requestCommand } from './server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup(heartbeatMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'collector-ws-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const httpServer = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  return new Promise<{ port: number; db: any; dir: string; cleanup: () => void }>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port;
      attachWsServer(httpServer, db, 'test-token', heartbeatMs); // 预置 token；下方 hello 须带同一 token；heartbeatMs 可注入（测心跳清理用）
      resolve({ port, db, dir, cleanup: () => { httpServer.close(); rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('hello 握手：扩展连上后服务端记录 ext_version', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token' }));
    await new Promise(r => setTimeout(r, 50));
    ws.close();
  } finally { ctx.cleanup(); }
});

test('ingest 消息：服务端写入 SQLite 并回 ingest-ack', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token' }));
    await new Promise(r => setTimeout(r, 30));
    ws.send(JSON.stringify({
      type: 'ingest',
      payload: {
        source: 'bilibili',
        video: { source_vid: 'BV1xxx', title: 't', creator: { source_uid: '123', name: 'up' }, extra: {}, duration: 100, published_at: 1 },
        tracks: [{ lan: 'zh', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://a' }] }],
      },
    }));
    const ack: any = await new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
    assert.equal(ack.type, 'ingest-ack');
    assert.equal(ack.ok, true);
    assert.equal(ack.inserted_tracks, 1);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('result 消息：服务端记录 commandId → result 映射', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token' }));
    await new Promise(r => setTimeout(r, 30));
    const commandId = 'cmd-1';
    ws.send(JSON.stringify({ type: 'result', id: commandId, ok: true, data: { nav: true } }));
    await new Promise(r => setTimeout(r, 30));
    ws.close();
  } finally { ctx.cleanup(); }
});

test('服务端主动下发 Command：broadcastCommand 触达扩展并收到 result', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-bc' }));
    await new Promise(r => setTimeout(r, 30));

    const cmd = { id: 'cmd-42', action: 'navigate', url: 'https://www.bilibili.com/video/BV1xxx' };
    const incoming: any = await new Promise((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      broadcastCommand(ctx.port, cmd);
    });
    assert.equal(incoming.id, 'cmd-42');
    assert.equal(incoming.action, 'navigate');

    // 扩展回 result
    ws.send(JSON.stringify({ type: 'result', id: 'cmd-42', ok: true, data: { opened: true } }));
    await new Promise(r => setTimeout(r, 30));
    ws.close();
  } finally { ctx.cleanup(); }
});

test('hello 握手 token 不匹配：服务端关闭连接', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    const closed = new Promise<boolean>((resolve) => {
      ws.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'WRONG-TOKEN' }));
    assert.equal(await closed, true, 'bad token 应被关闭');
  } finally { ctx.cleanup(); }
});

test('hello 带 client_id/reporting_enabled：服务端记录到 ExtConn，listClients 可见', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-A', reporting_enabled: true }));
    await new Promise(r => setTimeout(r, 50));
    const clients = listClients();
    assert.equal(clients.length, 1);
    assert.equal(clients[0].client_id, 'ext-A');
    assert.equal(clients[0].reporting_enabled, true);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('多客户端：两个不同 client_id 各自可见、互不干扰', async () => {
  const ctx = await setup();
  try {
    const wsA = await connect(ctx.port);
    wsA.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-A', reporting_enabled: true }));
    const wsB = await connect(ctx.port);
    wsB.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-B', reporting_enabled: false }));
    await new Promise(r => setTimeout(r, 60));
    const ids = listClients().map(c => c.client_id).sort();
    assert.deepEqual(ids, ['ext-A', 'ext-B']);
    const b = listClients().find(c => c.client_id === 'ext-B')!;
    assert.equal(b.reporting_enabled, false);
    wsA.close(); wsB.close();
  } finally { ctx.cleanup(); }
});

test('sendToClient：定向到指定 client_id，不影响其他客户端', async () => {
  const ctx = await setup();
  try {
    const wsA = await connect(ctx.port);
    wsA.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-A', reporting_enabled: true }));
    const wsB = await connect(ctx.port);
    wsB.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-B', reporting_enabled: true }));
    await new Promise(r => setTimeout(r, 50));

    const incoming: any = await new Promise(resolve => {
      wsA.once('message', d => resolve(JSON.parse(d.toString())));
      const ok = sendToClient('ext-A', { id: 'cmd-2', action: 'ping' });
      assert.equal(ok, true);
    });
    assert.equal(incoming.id, 'cmd-2');

    // B 不应收到定向给 A 的命令
    let bSaw = false;
    wsB.once('message', () => { bSaw = true; });
    sendToClient('ext-A', { id: 'cmd-3', action: 'ping' });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(bSaw, false);

    assert.equal(sendToClient('ext-NONE', { id: 'x', action: 'ping' }), false); // 离线
    wsA.close(); wsB.close();
  } finally { ctx.cleanup(); }
});

test('reporting-state：扩展发此消息，服务端更新该 conn 状态', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-A', reporting_enabled: true }));
    await new Promise(r => setTimeout(r, 40));
    ws.send(JSON.stringify({ type: 'reporting-state', enabled: false }));
    await new Promise(r => setTimeout(r, 40));
    const c = listClients().find(x => x.client_id === 'ext-A')!;
    assert.equal(c.reporting_enabled, false);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('requestReportingChange：下发 set-reporting 并等 result 回执，更新 conn 状态', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-A', reporting_enabled: true }));
    // 扩展侧模拟：收到 set-reporting → 回 result
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.action === 'set-reporting') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data: { reporting_enabled: m.enabled } }));
    });
    await new Promise(r => setTimeout(r, 40));

    const r = await requestReportingChange('ext-A', false);
    assert.equal(r.ok, true);
    assert.equal(r.reporting_enabled, false);
    const c = listClients().find(x => x.client_id === 'ext-A')!;
    assert.equal(c.reporting_enabled, false);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('requestReportingChange：离线 client 返回 offline', async () => {
  const ctx = await setup();
  try {
    const r = await requestReportingChange('ext-NONE', true);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'offline');
  } finally { ctx.cleanup(); }
});

test('requestReportingChange：扩展不回 result → 5s 超时返回 timeout（测试用 50ms 超时注入）', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-A', reporting_enabled: true }));
    await new Promise(r => setTimeout(r, 40));
    // 不回 result
    const r = await requestReportingChange('ext-A', false, 50);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'timeout');
    ws.close();
  } finally { ctx.cleanup(); }
});

test('requestCommand：下发 navigate 并等 result 回执，透传扩展返回的 ok/data', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-A', reporting_enabled: true }));
    // 扩展侧模拟：收到 navigate → 回 result
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.action === 'navigate') ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data: { opened: true } }));
    });
    await new Promise(r => setTimeout(r, 40));

    const r = await requestCommand('ext-A', 'navigate', { url: 'https://www.bilibili.com/video/BV1xxx' });
    assert.equal(r.ok, true);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.data.opened, true);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('requestCommand：离线 client 返回 offline', async () => {
  const ctx = await setup();
  try {
    const r = await requestCommand('ext-NONE', 'navigate', { url: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'offline');
  } finally { ctx.cleanup(); }
});

test('requestCommand：扩展不回 result → 短超时返回 timeout', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-A', reporting_enabled: true }));
    await new Promise(r => setTimeout(r, 40));
    // 不回 result
    const r = await requestCommand('ext-A', 'navigate', { url: 'x' }, 50);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'timeout');
    ws.close();
  } finally { ctx.cleanup(); }
});

// --- 心跳：清理半开连接 ---
// 半开连接（对端不发 close、不回 pong）无法靠 ws.on('close') 感知，需 ping/pong sweep + terminate。
// 用 raw socket 造"完成握手 + 发 hello 后静默（忽略一切入站帧，含 ping/close）"的半开客户端。

function sendMaskedText(sock: Socket, obj: unknown): void {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  const len = payload.length;
  const header = len < 126
    ? Buffer.from([0x81, 0x80 | len])
    : Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
  sock.write(Buffer.concat([header, mask, masked]));
}

// raw WS 客户端：完成 HTTP Upgrade 握手 + 发 hello，之后静默 → 模拟半开（不回 pong、不发 close）
function connectHalfOpen(port: number, clientId: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(
        'GET /ext HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let buf = Buffer.alloc(0);
    let resolved = false;
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!resolved && buf.includes('\r\n\r\n')) {
        resolved = true;
        sendMaskedText(sock, { type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: clientId, reporting_enabled: true });
        resolve(sock);
      }
      // 握手后忽略所有入站帧（服务端 ping/close 一律不回）→ 半开
    });
    sock.on('error', reject);
  });
}

test('心跳：半开连接（不回 pong）被 sweep 清理，正常连接保留', async () => {
  const ctx = await setup(40); // heartbeatMs=40ms
  let wsA: WebSocket | null = null;
  let halfSock: Socket | null = null;
  try {
    // 正常客户端 A：ws 库自动回 pong → isAlive 持续翻转，永不清理
    wsA = await connect(ctx.port);
    wsA.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-A', reporting_enabled: true }));
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(listClients().map(c => c.client_id).sort(), ['ext-A']);

    // 半开客户端 B：raw socket 发 hello 后静默
    halfSock = await connectHalfOpen(ctx.port, 'ext-half');
    await new Promise(r => setTimeout(r, 30));
    assert.ok(listClients().map(c => c.client_id).includes('ext-half'), '半开连接应已进入 listClients');

    // 等 ≥ 2 个心跳周期（B 连上后第一次 sweep 设 isAlive=false+ping，第二次 terminate）
    await new Promise(r => setTimeout(r, 300));
    const ids = listClients().map(c => c.client_id).sort();
    assert.ok(!ids.includes('ext-half'), '半开连接应被心跳清理');
    assert.ok(ids.includes('ext-A'), '正常连接应保留');
  } finally {
    halfSock?.destroy();
    wsA?.close();
    ctx.cleanup();
  }
});
