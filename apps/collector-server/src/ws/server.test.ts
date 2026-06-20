import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { attachWsServer, broadcastCommand } from './server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-ws-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const httpServer = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  return new Promise<{ port: number; db: any; dir: string; cleanup: () => void }>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port;
      attachWsServer(httpServer, db, 'test-token'); // 预置 token；下方 hello 须带同一 token
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
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token' }));
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
