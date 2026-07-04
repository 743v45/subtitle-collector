# 上报开关 + 多客户端身份 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `subtitle-collector` 扩展加上报开关 + 每实例唯一 `client_id`，让 `collector-server` 能认人、按客户端定向远程开/关上报。

**Architecture:** 扩展 background 持内存态 `reportingEnabled`/`clientId`（storage 持久化），在 `INGEST` 咽喉丢弃关时的上报；server 端 `connections` 改 `Map<clientId, ExtConn>`，新增 `sendToClient`/`listClients`/`requestReportingChange`（带 result pending Map + 5s 超时），HTTP 暴露 `/api/clients*`。三路径状态同步：`hello`（重连全量）+ `reporting-state`（popup 本地变化）+ `result`（命令回执）。

**Tech Stack:** 扩展 MV3 原生 ESM（无构建链）；server TS + `ws` + `node --test --import tsx`；扩展纯函数 `node --test`（.mjs）；puppeteer mock 集成脚本。

**关联 spec：** [docs/superpowers/specs/2026-07-04-collector-report-toggle-design.md](../specs/2026-07-04-collector-report-toggle-design.md)

---

## 契约（两侧共同遵守，先读这一节）

**命名约定**：WS 协议字段 snake_case（对齐 `ext_version`）；扩展 `chrome.storage.local` key camelCase（对齐现有 `pendingIngests`）。

| 名称 | 层 | 值 |
|---|---|---|
| storage key `clientId` | 扩展 | `crypto.randomUUID()` 首次生成 |
| storage key `reportingEnabled` | 扩展 | boolean，默认 `true`（fail-open） |
| `hello` 字段 | WS | 加 `client_id: string`、`reporting_enabled: boolean` |
| Command `set-reporting` | WS（server→ext，带 id） | `{ id, action:"set-reporting", enabled: boolean }` |
| `set-reporting` result | WS（ext→server） | `{ type:"result", id, ok:true, data:{ reporting_enabled: boolean } }` |
| `reporting-state` | WS（ext→server，fire-and-forget） | `{ type:"reporting-state", enabled: boolean }` |
| 扩展内部消息 | popup→bg | `{ type:"SET_REPORTING", enabled: boolean }` |
| server 导出 | ws/server.ts | `sendToClient`、`listClients`、`requestReportingChange`、`attachWsServer`、`broadcastCommand`（保留） |

## File Structure

**新建：**
- `apps/subtitle-collector/reporting.mjs` — 纯函数 + 常量（`shouldReport`/`genClientId`/key 常量），不依赖 `chrome.*`
- `apps/subtitle-collector/test/reporting.test.mjs` — 扩展侧纯函数 node:test
- `apps/collector-server/src/http/clients.ts` — `/api/clients*` HTTP handler
- `apps/collector-server/src/http/clients.test.ts` — clients HTTP node:test
- `scripts/verify-collector-report-toggle.mjs` — puppeteer 端到端集成

**修改：**
- `apps/subtitle-collector/background.js` — 状态载入、hello 扩字段、INGEST 咽喉、set-reporting/SET_REPORTING、reporting-state
- `apps/subtitle-collector/popup.html` / `popup.js` — 上报行改 toggle
- `apps/subtitle-collector/package.json` — 加 `test` 脚本
- `apps/collector-server/src/ws/server.ts` — ExtConn 字段、Map 索引、定向下发、pending Map、reporting-state
- `apps/collector-server/src/main.ts` — `/api/clients` 路由分流
- `apps/collector-server/src/ws/server.test.ts` — 多客户端 + set-reporting 测试

**并发性**：Server 侧（Task 1–4）与扩展侧（Task 5–8）改不同 app、零文件冲突，可两 agent 并行；契约已在上表钉死。Task 9–10 集成依赖两侧完成。

---

## Task 1: server WS — ExtConn 扩字段 + connections 改 Map + hello 解析

**Files:**
- Modify: `apps/collector-server/src/ws/server.ts`
- Modify: `apps/collector-server/src/ws/server.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 server.test.ts）

```ts
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
```

并在 server.test.ts 顶部 import 行追加 `listClients`：
```ts
import { attachWsServer, broadcastCommand, listClients } from './server.js';
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/collector-server && pnpm test`
Expected: FAIL —— `listClients is not a function` / `client_id` 字段未记录。

- [ ] **Step 3: 实现**（改 server.ts）

把 `interface ExtConn` 与 `connections` 改为：
```ts
interface ExtConn {
  ws: WebSocket;
  extVersion: string | null;
  clientId: string | null;
  reportingEnabled: boolean;
}

const connections = new Map<string, ExtConn>(); // key = clientId（hello 后入表）
```

`wss.on('connection', ...)` 内初始化 `conn`：
```ts
const conn: ExtConn = { ws, extVersion: null, clientId: null, reportingEnabled: true };
```
（不再 `connections.add(conn)`，改在 hello 成功后入 Map。）

`hello` 分支（原 `conn.extVersion = ...` 之后，token 校验通过之后）追加：
```ts
conn.clientId = typeof msg.client_id === 'string' && msg.client_id ? msg.client_id : null;
conn.reportingEnabled = msg.reporting_enabled !== false; // 缺省 true
if (conn.clientId) {
  const prev = connections.get(conn.clientId);
  if (prev && prev.ws !== ws && prev.ws.readyState === WebSocket.OPEN) prev.ws.close(4000, 'replaced');
  connections.set(conn.clientId, conn);
}
```

`ws.on('close', ...)` 改为按 clientId 删：
```ts
ws.on('close', () => {
  if (conn.clientId && connections.get(conn.clientId) === conn) connections.delete(conn.clientId);
});
```

`broadcastCommand` 遍历改 `for (const c of connections.values())`。

新增导出 `listClients`：
```ts
export function listClients(): Array<{ client_id: string; ext_version: string | null; reporting_enabled: boolean; connected: true }> {
  return [...connections.values()]
    .filter(c => c.clientId && c.ws.readyState === WebSocket.OPEN)
    .map(c => ({ client_id: c.clientId!, ext_version: c.extVersion, reporting_enabled: c.reportingEnabled, connected: true }));
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/collector-server && pnpm test`
Expected: 新增 2 test PASS，原 5 test 仍 PASS（回归）。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/ws/server.ts apps/collector-server/src/ws/server.test.ts
git commit -m "feat(collector-server): WS ExtConn 加 clientId/reportingEnabled + connections 改 Map"
```

---

## Task 2: server WS — sendToClient + reporting-state 处理

**Files:**
- Modify: `apps/collector-server/src/ws/server.ts`
- Modify: `apps/collector-server/src/ws/server.test.ts`

- [ ] **Step 1: 写失败测试**（追加）

```ts
test('sendToClient：定向到指定 client_id，不影响其他客户端', async () => {
  const ctx = await setup();
  try {
    const wsA = await connect(ctx.port);
    wsA.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-A', reporting_enabled: true }));
    const wsB = await connect(ctx.port);
    wsB.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token', client_id: 'ext-B', reporting_enabled: true }));
    await new Promise(r => setTimeout(r, 50));

    const gotA: any = await new Promise(resolve => wsA.once('message', d => resolve(JSON.parse(d.toString()))));
    const ok = sendToClient('ext-A', { id: 'cmd-1', action: 'ping' });
    assert.equal(ok, true);
    assert.equal((await gotA)?.id, undefined); // gotA 是上面 once 的残留兜底，真正断言用下式
    wsA.removeAllListeners('message');

    const incoming: any = await new Promise(resolve => {
      wsA.once('message', d => resolve(JSON.parse(d.toString())));
      sendToClient('ext-A', { id: 'cmd-2', action: 'ping' });
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
```

import 行再加 `sendToClient`：
```ts
import { attachWsServer, broadcastCommand, listClients, sendToClient } from './server.js';
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/collector-server && pnpm test`
Expected: FAIL —— `sendToClient is not a function`。

- [ ] **Step 3: 实现**（server.ts）

新增 `sendToClient`：
```ts
export function sendToClient(clientId: string, cmd: { id: string; action: string; [k: string]: unknown }): boolean {
  const conn = connections.get(clientId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
  conn.ws.send(JSON.stringify(cmd));
  return true;
}
```

`ws.on('message')` 内，在 `hello` 分支之后、`ingest` 分支之前加：
```ts
if (msg.type === 'reporting-state') {
  conn.reportingEnabled = msg.enabled === true;
  return;
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/collector-server && pnpm test`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/ws/server.ts apps/collector-server/src/ws/server.test.ts
git commit -m "feat(collector-server): WS sendToClient 定向下发 + reporting-state 处理"
```

---

## Task 3: server WS — result pending Map + requestReportingChange

**Files:**
- Modify: `apps/collector-server/src/ws/server.ts`
- Modify: `apps/collector-server/src/ws/server.test.ts`

- [ ] **Step 1: 写失败测试**（追加）

```ts
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
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/collector-server && pnpm test`
Expected: FAIL —— `requestReportingChange is not a function`。

- [ ] **Step 3: 实现**（server.ts）

顶部 `import { randomUUID } from 'node:crypto';`

模块级 pending Map：
```ts
interface PendingEntry { resolve: (v: any) => void; timer: NodeJS.Timeout; }
const pending = new Map<string, PendingEntry>();
```

`ws.on('message')` 内，把现有 `if (msg.type === 'result')` 分支改为：
```ts
if (msg.type === 'result') {
  const entry = pending.get(msg.id);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    entry.resolve(msg);
  } else {
    console.log(`[ext] result id=${msg.id} ok=${msg.ok}`);
  }
  return;
}
```

新增 `requestReportingChange`（超时可注入，便于测试）：
```ts
export async function requestReportingChange(
  clientId: string,
  enabled: boolean,
  timeoutMs = 5000,
): Promise<{ ok: true; reporting_enabled: boolean } | { ok: false; code: 'offline' | 'timeout' }> {
  const id = randomUUID();
  const sent = sendToClient(clientId, { id, action: 'set-reporting', enabled });
  if (!sent) return { ok: false, code: 'offline' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ ok: false, code: 'timeout' }); }
    }, timeoutMs);
    pending.set(id, {
      resolve: (msg: any) => {
        const conn = connections.get(clientId);
        if (conn) conn.reportingEnabled = msg?.data?.reporting_enabled === true;
        resolve({ ok: true, reporting_enabled: msg?.data?.reporting_enabled === true });
      },
      timer,
    });
  });
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/collector-server && pnpm test`
Expected: 全 PASS（含超时用例，约 50ms）。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/ws/server.ts apps/collector-server/src/ws/server.test.ts
git commit -m "feat(collector-server): WS result pending Map + requestReportingChange（D 方案 gap #1）"
```

---

## Task 4: server HTTP — `/api/clients*` 路由

**Files:**
- Create: `apps/collector-server/src/http/clients.ts`
- Create: `apps/collector-server/src/http/clients.test.ts`
- Modify: `apps/collector-server/src/main.ts`

- [ ] **Step 1: 写失败测试**（clients.test.ts）

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
    const req = require('node:http').request({ host: '127.0.0.1', port, method, path, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res: any) => {
      let buf = ''; res.on('data', (c: Buffer) => buf += c); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
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
```

> `clients.test.ts` 必须被 `node --test --import tsx "src/*/*.test.ts"` 收到——它就在 `src/http/`，glob 匹配。把 `require('node:http')` 换成顶部 `import { request as httpRequest } from 'node:http'` 并相应改写 `httpReq`（避免 TS 抱怨 `require`）。

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/collector-server && pnpm test`
Expected: FAIL —— `Cannot find module './clients.js'`。

- [ ] **Step 3: 实现 clients.ts**

```ts
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { listClients, requestReportingChange } from '../ws/server.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
  });
}

export async function handleClientsHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/clients') { json(res, 200, { ok: true, clients: listClients() }); return; }

  const m = pathname.match(/^\/api\/clients\/([^/]+)\/reporting$/);
  if (m && req.method === 'POST') {
    const clientId = decodeURIComponent(m[1]);
    const body = await readJsonBody(req);
    if (typeof body?.enabled !== 'boolean') { json(res, 400, { ok: false, error: 'enabled must be boolean' }); return; }
    const r = await requestReportingChange(clientId, body.enabled);
    if (r.code === 'offline') { json(res, 404, { ok: false, error: 'client not online' }); return; }
    if (r.code === 'timeout') { json(res, 504, { ok: false, error: 'extension result timeout' }); return; }
    json(res, 200, { ok: true, client_id: clientId, reporting_enabled: r.reporting_enabled });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}
```

main.ts 路由分流（在 `if (req.url?.startsWith('/api/'))` 之前插入）：
```ts
import { handleClientsHttp } from './http/clients.js';
// ...在 createServer 回调里，/ping 与 httpOriginAllowed 之后：
if (req.url?.startsWith('/api/clients')) { handleClientsHttp(req, res); return; }
if (req.url?.startsWith('/api/')) { handleQueryHttp(req, res, db); return; }
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/collector-server && pnpm test`
Expected: 全 PASS（含新 clients.test.ts 3 用例 + server.test.ts + db 测试）。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/http/clients.ts apps/collector-server/src/http/clients.test.ts apps/collector-server/src/main.ts
git commit -m "feat(collector-server): HTTP /api/clients 列表 + 定向开/关上报"
```

---

## Task 5: 扩展 — reporting.mjs 纯函数 + test 脚本

**Files:**
- Create: `apps/subtitle-collector/reporting.mjs`
- Create: `apps/subtitle-collector/test/reporting.test.mjs`
- Modify: `apps/subtitle-collector/package.json`

- [ ] **Step 1: 写失败测试**

```js
// apps/subtitle-collector/test/reporting.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReport, genClientId, CLIENT_ID_KEY, REPORTING_KEY } from '../reporting.mjs';

test('shouldReport：true/未设→上报，false→不上报（fail-open）', () => {
  assert.equal(shouldReport(true), true);
  assert.equal(shouldReport(false), false);
  assert.equal(shouldReport(undefined), true); // 未设置默认开
});

test('genClientId：非空字符串，多次不撞', () => {
  const a = genClientId(); const b = genClientId();
  assert.ok(typeof a === 'string' && a.length > 0);
  assert.notEqual(a, b);
});

test('storage key 常量稳定（对齐协议）', () => {
  assert.equal(CLIENT_ID_KEY, 'clientId');
  assert.equal(REPORTING_KEY, 'reportingEnabled');
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/subtitle-collector && node --test "test/*.test.mjs"`
Expected: FAIL —— `Cannot find module '../reporting.mjs'`。

- [ ] **Step 3: 实现 reporting.mjs**

```js
// apps/subtitle-collector/reporting.mjs
// 上报开关 + 客户端身份的纯逻辑（不依赖 chrome.*，便于 node:test）。
// storage key 用 camelCase 对齐现有 pendingIngests；WS 协议字段用 snake_case，由 background 转换。

export const CLIENT_ID_KEY = "clientId";
export const REPORTING_KEY = "reportingEnabled";

/** 决定是否上报；flag 非 false 一律放行（fail-open，默认开） */
export function shouldReport(flag) {
  return flag !== false;
}

/** 生成客户端唯一 id（优先 crypto.randomUUID，回退兜底） */
export function genClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "ext-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
```

package.json 加 test 脚本：
```json
{
  "name": "@bilibili-ext/subtitle-collector",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "echo 'No build step yet'",
    "test": "node --test \"test/*.test.mjs\""
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/subtitle-collector && node --test "test/*.test.mjs"`
Expected: 3 test PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/subtitle-collector/reporting.mjs apps/subtitle-collector/test/reporting.test.mjs apps/subtitle-collector/package.json
git commit -m "feat(subtitle-collector): reporting.mjs 纯函数 + test 脚本"
```

---

## Task 6: 扩展 — background 启动载入 + hello 扩字段 + INGEST 咽喉

**Files:**
- Modify: `apps/subtitle-collector/background.js`

> 集成测试（Task 9）会端到端验证；本 task 先用「代码审读 + 手动 reload」确保不破现有上报。

- [ ] **Step 1: 改 background.js 顶部**

```js
import { SERVER_URL, PING_URL, TOKEN } from "./config.js";
import { shouldReport, genClientId, CLIENT_ID_KEY, REPORTING_KEY } from "./reporting.mjs";
const EXT_VERSION = chrome.runtime.getManifest().version;

let ws = null;
let reconnectAttempts = 0;
let reportingEnabled = true; // 内存态；启动从 storage 载入，默认 true（fail-open）
let clientId = null;         // 内存态；启动载入或首次生成
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 10000;
```

- [ ] **Step 2: 加状态载入函数**（`probeServer` 之前）

```js
// 启动载入持久态：clientId（无则生成并回写）、reportingEnabled（默认 true）
async function loadPersistedState() {
  const items = await chrome.storage.local.get([CLIENT_ID_KEY, REPORTING_KEY]);
  if (items[CLIENT_ID_KEY]) {
    clientId = items[CLIENT_ID_KEY];
  } else {
    clientId = genClientId();
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId });
  }
  reportingEnabled = shouldReport(items[REPORTING_KEY]); // undefined → true
}
```

- [ ] **Step 3: hello 扩字段**（`ws.onopen` 内）

```js
  ws.onopen = () => {
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: "hello", ext_version: EXT_VERSION, token: TOKEN, client_id: clientId, reporting_enabled: reportingEnabled }));
    flushPendingIngests();
  };
```

- [ ] **Step 4: INGEST 咽喉加开关**（`onMessage` 监听器 `INGEST` 分支顶部）

```js
  if (msg?.type === "INGEST" && msg.payload) {
    const bvid = msg.payload.video?.source_vid ?? '?';
    if (!shouldReport(reportingEnabled)) {
      console.log(`[background] ingest 丢弃（上报开关关）bvid=${bvid}`);
      sendResponse({ ok: true, dropped: true });
      return true;
    }
    console.log(`[background] ingest 转发 bvid=${bvid} ws_open=${ws?.readyState === WebSocket.OPEN}`);
    // ...原 WS 发送 / pendingIngests 逻辑保持不变
```

- [ ] **Step 5: 启动顺序**（文件末尾把 `connect();` 改为）

```js
loadPersistedState().then(connect);
```

- [ ] **Step 6: 手动验证不破现状**

Run: `cd apps/subtitle-collector && node --test "test/*.test.mjs"`（纯函数仍过）
然后：Chrome `chrome://extensions` reload 扩展，打开 B 站视频页，看 service worker console 应有 `[background] ingest 转发 ...`（开关默认开，行为同改动前）。无报错。

- [ ] **Step 7: Commit**

```bash
git add apps/subtitle-collector/background.js
git commit -m "feat(subtitle-collector): background 载入 clientId/reportingEnabled + hello 扩字段 + INGEST 咽喉开关"
```

---

## Task 7: 扩展 — set-reporting 命令 + SET_REPORTING 内部消息 + reporting-state

**Files:**
- Modify: `apps/subtitle-collector/background.js`

- [ ] **Step 1: 加 applyReporting 统一更新函数**（`loadPersistedState` 之后）

```js
// 统一更新开关：内存 + storage
async function applyReporting(enabled) {
  reportingEnabled = enabled === true;
  await chrome.storage.local.set({ [REPORTING_KEY]: reportingEnabled });
  return reportingEnabled;
}
```

- [ ] **Step 2: ws.onmessage 命令路由加 set-reporting 分支**（`fetch-subtitle` 分支之后、`else`（unknown action）之前）

```js
      } else if (msg.action === "set-reporting") {
        const newEnabled = await applyReporting(msg.enabled === true);
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { reporting_enabled: newEnabled } }));
        // set-reporting 路径不发 reporting-state：server 作为发起方据 result 更新状态
```

- [ ] **Step 3: onMessage 加 SET_REPORTING（popup→bg）分支**（`MANUAL_CAPTURE` 分支之后）

```js
  } else if (msg?.type === "SET_REPORTING") {
    applyReporting(msg.enabled === true).then((enabled) => {
      // popup 本地变化 → 发 reporting-state 同步 server
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "reporting-state", enabled }));
      }
      sendResponse({ ok: true, reporting_enabled: enabled });
    });
    return true;
```

- [ ] **Step 4: 手动验证**

Chrome reload 扩展 → service worker console。用 DevTools 对 service worker 手动发消息模拟：
```js
chrome.runtime.sendMessage({ type: "SET_REPORTING", enabled: false });
```
应回 `{ok:true, reporting_enabled:false}`，且 storage 里 `reportingEnabled=false`。再 `chrome.runtime.sendMessage({ type: "SET_REPORTING", enabled: true })` 恢复。

- [ ] **Step 5: Commit**

```bash
git add apps/subtitle-collector/background.js
git commit -m "feat(subtitle-collector): set-reporting 命令 + SET_REPORTING 内部消息 + reporting-state 同步"
```

---

## Task 8: 扩展 — popup 上报 toggle

**Files:**
- Modify: `apps/subtitle-collector/popup.html`
- Modify: `apps/subtitle-collector/popup.js`

- [ ] **Step 1: popup.html 把空壳"上报"行改 toggle**

把 `<div class="row" id="stats">上报: -</div>` 改为：
```html
<div class="row">上报: <label style="display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" id="report-toggle"> <span id="report-label">-</span></label></div>
```
> 内联 `style` 仅用于 inline 元素对齐（无构建链扩展豁免；与现有 `style` 内联于 `<style>` 块的风格一致，本行是元素微调，可接受）。若更想洁癖：在现有 `<style>` 块加 `.toggle-row{display:inline-flex;gap:4px}` 类替代。

把 `<script src="popup.js"></script>` 改为 `<script type="module" src="popup.js"></script>`。

- [ ] **Step 2: popup.js 改为 module 并接 toggle**

```js
import { REPORTING_KEY } from "./reporting.mjs";

document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  const biliLogin = document.getElementById("bili-login");
  const reportToggle = document.getElementById("report-toggle");
  const reportLabel = document.getElementById("report-label");
  const btn = document.getElementById("btn-capture");

  function refresh() {
    chrome.runtime.sendMessage({ type: "WS_STATUS" }, (resp) => {
      if (resp?.connected) { status.textContent = "已连接"; status.className = "status ok"; }
      else { status.textContent = "未连接"; status.className = "status no"; }
    });
  }

  function checkBiliLogin() {
    fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.code === 0 && d.data?.isLogin) {
          biliLogin.textContent = `已登录 (${d.data.uname || '用户'})`;
          biliLogin.className = "status ok";
        } else {
          biliLogin.textContent = "未登录（无法采集字幕，请先登录 bilibili.com）";
          biliLogin.className = "status no";
        }
      })
      .catch(() => { biliLogin.textContent = "检查失败（网络问题）"; biliLogin.className = "status no"; });
  }

  // 上报开关：打开时从 storage 读（默认开），onchange 发 SET_REPORTING 由 background 统一处理
  chrome.storage.local.get([REPORTING_KEY], (items) => {
    const enabled = items[REPORTING_KEY] !== false;
    reportToggle.checked = enabled;
    reportLabel.textContent = enabled ? "开" : "关";
  });
  reportToggle.onchange = () => {
    reportLabel.textContent = reportToggle.checked ? "开" : "关";
    chrome.runtime.sendMessage({ type: "SET_REPORTING", enabled: reportToggle.checked });
  };

  btn.onclick = () => { chrome.runtime.sendMessage({ type: "MANUAL_CAPTURE" }); };

  refresh();
  checkBiliLogin();
  setInterval(refresh, 2000);
  setInterval(checkBiliLogin, 30000);
});
```

- [ ] **Step 3: 手动验证**

Chrome reload 扩展 → 点扩展图标 → popup 出现"上报 ☑ 开"。取消勾选 → 变"关"，`chrome://extensions` 看 service worker storage 有 `reportingEnabled:false`；此时浏览视频页不应上报（service worker console 无 `ingest 转发`，只有 `ingest 丢弃`）。重新勾选恢复。

- [ ] **Step 4: Commit**

```bash
git add apps/subtitle-collector/popup.html apps/subtitle-collector/popup.js
git commit -m "feat(subtitle-collector): popup 上报 toggle + 状态读写"
```

---

## Task 9: 集成 — puppeteer 端到端 verify 脚本

**Files:**
- Create: `scripts/verify-collector-report-toggle.mjs`

> 依赖 Task 1–8 全部完成。仿 [verify-collector.mjs](scripts/verify-collector.mjs) 的 launch + mock server 骨架，只测开关链路。

- [ ] **Step 1: 写脚本**

```js
#!/usr/bin/env node
/**
 * 上报开关端到端（puppeteer mock）：
 *   1. 起 mock server（HTTP /ping + WS /ext，收 ingest / 发 set-reporting）
 *   2. 加载扩展，扩展 hello 带 client_id
 *   3. 触发一次 mock player API + 字幕体 → 应收到 ingest（开关默认开）
 *   4. 下发 set-reporting{enabled:false} → 再触发同样 mock → 不应收到 ingest
 *   5. 下发 set-reporting{enabled:true} → 再触发 → 又收到 ingest
 * 退出码 0=通过。
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..', 'apps', 'subtitle-collector');

const received = { ingests: [], hellos: [], results: [] };
const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer, path: '/ext' });
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.type === 'hello') { received.hellos.push(m); ws.send(JSON.stringify({ type: 'hello-ack', ok: true })); }
    else if (m.type === 'ingest') { received.ingests.push(m.payload); ws.send(JSON.stringify({ type: 'ingest-ack', ok: true })); }
    else if (m.type === 'result') { received.results.push(m); }
  });
});
await new Promise((r) => httpServer.listen(21527, '127.0.0.1', r));

let exec = '';
try {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(cand)) exec = cand;
} catch {}
if (!exec) { const c = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; if (existsSync(c)) exec = c; }
const browser = await puppeteer.launch({
  ...(exec ? { executablePath: exec } : {}),
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
});
await new Promise(r => setTimeout(r, 3000));
const page = await browser.newPage();
await page.setRequestInterception(true);
const mockPlayer = (vid) => JSON.stringify({ code: 0, data: { bvid: vid, aid: 1, cid: 2, title: vid, up_info: { mid: 11, name: 'up' }, subtitle: { subtitles: [{ lan: 'zh-Hans', lan_doc: '简', type: 2, subtitle_url: `//aisubtitle.hdslb.com/SUB_${vid}.json` }] } } });
page.on('request', (req) => {
  const u = req.url(); const h = { 'access-control-allow-origin': '*' };
  if (u.includes('/x/player/')) req.respond({ status: 200, contentType: 'application/json', headers: h, body: mockPlayer('BV' + Date.now()) });
  else if (u.includes('aisubtitle.hdslb.com/SUB_')) req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ body: [{ from: 0, to: 1, content: '字幕' }] }) });
  else req.continue();
});

const sendCmd = (cmd) => { for (const c of wss.clients) c.send(JSON.stringify(cmd)); };
const triggerIngest = async () => {
  received.ingests.length = 0;
  await page.goto('https://www.bilibili.com/video/TOGGLE', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=TOGGLE'));
  await page.evaluate(() => fetch('https://aisubtitle.hdslb.com/SUB_TOGGLE.json'));
  await new Promise(r => setTimeout(r, 1500));
  return received.ingests.length;
};

// 1) hello 带 client_id
await new Promise(r => setTimeout(r, 500));
console.log('[1] hello 含 client_id:', !!received.hellos[0]?.client_id, received.hellos[0]?.client_id);

// 2) 默认开 → 应收到 ingest
const n1 = await triggerIngest();
console.log('[2] 开关开 → ingest 数:', n1, n1 === 1 ? '✅' : '❌');

// 3) 下发关 → 不应收到 ingest
sendCmd({ id: 'cmd-off', action: 'set-reporting', enabled: false });
await new Promise(r => setTimeout(r, 500));
const n2 = await triggerIngest();
console.log('[3] 开关关 → ingest 数:', n2, n2 === 0 ? '✅' : '❌');
const offRes = received.results.find(r => r.id === 'cmd-off');
console.log('    set-reporting(off) 回执:', offRes?.ok, offRes?.data?.reporting_enabled);

// 4) 下发开 → 又收到 ingest
sendCmd({ id: 'cmd-on', action: 'set-reporting', enabled: true });
await new Promise(r => setTimeout(r, 500));
const n3 = await triggerIngest();
console.log('[4] 开关重开 → ingest 数:', n3, n3 === 1 ? '✅' : '❌');

const ok = received.hellos[0]?.client_id && n1 === 1 && n2 === 0 && n3 === 1;
console.log('\n结果:', ok ? '✅ 上报开关端到端通过' : '❌ 失败');
await browser.close(); httpServer.close();
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: 跑脚本**

Run: `node scripts/verify-collector-report-toggle.mjs`
Expected: 4 步全 ✅，退出码 0。（需本机有 Chrome；CI 环境可跳过，标注为本地/手动。）

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-collector-report-toggle.mjs
git commit -m "test: 上报开关 puppeteer 端到端 verify 脚本"
```

---

## Task 10: 全量回归 — `turbo run test` + 现有 verify 不破

**Files:** 无（验证 only）

- [ ] **Step 1: 跑全部单元测试**

Run: `turbo run test`
Expected: `@bilibili-ext/subtitle-collector`（reporting.test.mjs 3 用例）+ `@bilibili-ext/collector-server`（ingest/queries/server/clients 全过）全 PASS。

- [ ] **Step 2: 跑现有扩展回归脚本（确认被动采集未破）**

Run: `node scripts/verify-collector.mjs`
Expected: `[ingest 四情况] ✅`、navigate/operate 仍 ✅（开关默认开，零行为漂移）。

- [ ] **Step 3: 填 spec 测试轮次记录表**

回到 [spec §10.1](../specs/2026-07-04-collector-report-toggle-design.md)，把 7 轮的日期/结果/问题填入表格（实施时填写区）。Commit：

```bash
git add docs/superpowers/specs/2026-07-04-collector-report-toggle-design.md
git commit -m "docs: 填写上报开关 spec 测试轮次记录表"
```

---

## Self-Review

**Spec 覆盖**：spec §5.1 hello 扩字段 → Task 1/6；§5.2 set-reporting → Task 3/7；§5.3 reporting-state → Task 2/7；§5.4 INGEST 咽喉 → Task 6；§6.1 扩展改动 → Task 5–8；§6.2 server 改动 → Task 1–4；§7 HTTP → Task 4；§9 验收 1–10 → 覆盖于 Task 1–9（#8 两扩展独立开/关 = server.test.ts 双客户端用例 + verify 脚本）。无遗漏。

**类型/命名一致性**：`shouldReport`/`genClientId`/`CLIENT_ID_KEY`/`REPORTING_KEY`（reporting.mjs）↔ background.js import 一致；WS `client_id`/`reporting_enabled`/`set-reporting`/`reporting-state` 全程一致；server 导出 `listClients`/`sendToClient`/`requestReportingChange` 定义（Task 1/2/3）与使用（Task 4）一致。

**占位符扫描**：无 TBD/TODO；每步含真实代码与命令。

**注意**：Task 4 测试里 `httpReq` 用 `node:http` 的 `request`，实现里 import 为 `httpRequest`——计划已注明把测试的 `require('node:http')` 改为 `import { request as httpRequest }`。
