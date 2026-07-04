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
function wsConnect(port: number, clientId: string, enabled: boolean): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: clientId, reporting_enabled: enabled }));
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
