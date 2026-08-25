// clients.ts commander 装配层测试：子进程跑真 CLI + 本地 mock HTTP server（真 fetch 走真 HTTP），
// 覆盖三个 action 成功路径 + handleHttpError 归一化（SERVER_UNREACHABLE / NOT_FOUND / RUNTIME）+ ARGS 校验。
// 纯函数（clientsList/clientsReporting/clientsCommand）见 clients.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | list/reporting/command 成功 + 状态码归一化（404→NOT_FOUND，5xx→RUNTIME，不可达→SERVER_UNREACHABLE）+ state/timeout ARGS | 通过 | |
// | R2 | task-dispatch（2026-08-23 仅上报状态）成功 + ARGS + 404 | 通过 | 与 reporting 同构 |
// | R3 | 排序：--sort 成对下发 query + 未传不带 + 非法 --sort ARGS 退 2 | 通过 | 2026-08-25 全端点排序；pnpm qa 全绿 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/cli/commands
const MAIN_TS = join(HERE, '..', 'main.ts');
const APP_ROOT = resolve(HERE, '../../..');

function cli(args_: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, ...args_], { cwd: APP_ROOT }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
}

// —— mock server：记录 (method, path, body)，按 responder 回真 HTTP 响应 ——
interface SrvReq { method: string; path: string; body: Record<string, unknown> | null }
interface SrvRes { status: number; json?: unknown }
type Responder = (req: SrvReq) => SrvRes;

function startMockServer(respond: Responder): Promise<{ url: string; reqs: SrvReq[]; close(): Promise<void> }> {
  return new Promise((resolveSrv) => {
    const reqs: SrvReq[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let body: Record<string, unknown> | null = null;
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* 空 body */ }
        const rec: SrvReq = { method: req.method ?? '', path: req.url ?? '', body };
        reqs.push(rec);
        const r = respond(rec);
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(r.json === undefined ? '' : JSON.stringify(r.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolveSrv({ url: `http://127.0.0.1:${addr.port}`, reqs, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

// 不可达 server：端口 1 无监听 → ECONNREFUSED。
const DEAD = 'http://127.0.0.1:1';
const args = (serverUrl: string, rest: string[]): string[] =>
  ['--db', '/tmp/none.db', '--server', serverUrl, '--token', 'tok-1', ...rest];

// ── clients list ──

test('clients list：server 200 → {items,total}，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { clients: [{ client_id: 'ext-1' }, { client_id: 'ext-2' }] } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'list']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { items: [{ client_id: 'ext-1' }, { client_id: 'ext-2' }], total: 2 });
    assert.equal(srv.reqs[0]!.path, '/api/clients');
    assert.equal(srv.reqs[0]!.method, 'GET');
  } finally { await srv.close(); }
});

test('clients list：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args(DEAD, ['clients', 'list']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  assert.match(r.err, /cannot reach server/);
});

test('clients list：404 → NOT_FOUND 退 5（带 status/body extra）', async () => {
  const srv = await startMockServer(() => ({ status: 404, json: { ok: false, error: 'no route' } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'list']));
    assert.equal(r.code, 5);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(body.status, 404);
  } finally { await srv.close(); }
});

test('clients list：500 → RUNTIME 退 1（带 status/body extra）', async () => {
  const srv = await startMockServer(() => ({ status: 500, json: { ok: false, error: 'boom' } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'list']));
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'RUNTIME');
    assert.equal(body.status, 500);
  } finally { await srv.close(); }
});

// ── clients reporting ──

test('clients reporting <id> on：POST body {enabled:true}，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, client_id: 'ext-1', reporting_enabled: true } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'reporting', 'ext-1', 'on']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, client_id: 'ext-1', reporting_enabled: true });
    assert.equal(srv.reqs[0]!.path, '/api/clients/ext-1/reporting');
    assert.deepEqual(srv.reqs[0]!.body, { enabled: true });
  } finally { await srv.close(); }
});

test('clients reporting：state 非 on|off → ARGS 退 2（不发请求）', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'reporting', 'ext-1', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /invalid reporting state "bogus"/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('clients reporting：404 → NOT_FOUND 退 5', async () => {
  const srv = await startMockServer(() => ({ status: 404, json: { error: 'offline' } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'reporting', 'ext-9', 'off']));
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
  } finally { await srv.close(); }
});

test('clients reporting：不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args(DEAD, ['clients', 'reporting', 'ext-1', 'off']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
});

// ── clients task-dispatch（2026-08-23 仅上报状态）──

test('clients task-dispatch <id> off：POST body {enabled:false}，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, client_id: 'ext-1', task_dispatch_enabled: false } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'task-dispatch', 'ext-1', 'off']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, client_id: 'ext-1', task_dispatch_enabled: false });
    assert.equal(srv.reqs[0]!.path, '/api/clients/ext-1/task-dispatch');
    assert.deepEqual(srv.reqs[0]!.body, { enabled: false });
  } finally { await srv.close(); }
});

test('clients task-dispatch：state 非 on|off → ARGS 退 2（不发请求）', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'task-dispatch', 'ext-1', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /invalid task-dispatch state "bogus"/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('clients task-dispatch：404 → NOT_FOUND 退 5', async () => {
  const srv = await startMockServer(() => ({ status: 404, json: { error: 'client not online' } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'task-dispatch', 'ext-9', 'off']));
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
  } finally { await srv.close(); }
});

// ── clients command ──

test('clients command：可选参数仅在传入时下发 + --timeout 透传，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, client_id: 'ext-1', action: 'navigate', result: { done: true } } }));
  try {
    const r = await cli(args(srv.url, [
      'clients', 'command', 'ext-1', 'navigate', '--op', 'refresh', '--url', 'https://b23.tv/x', '--vid', 'BV1', '--timeout', '1234',
    ]));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out).result, { done: true });
    assert.equal(srv.reqs[0]!.path, '/api/clients/ext-1/command');
    assert.deepEqual(srv.reqs[0]!.body, { action: 'navigate', op: 'refresh', url: 'https://b23.tv/x', vid: 'BV1', timeout: 1234 });
  } finally { await srv.close(); }
});

test('clients command：不传可选参数 → body 仅 action + 默认 timeout 5000', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'command', 'ext-1', 'fetch-subtitle']));
    assert.equal(r.code, 0);
    assert.deepEqual(srv.reqs[0]!.body, { action: 'fetch-subtitle', timeout: 5000 });
  } finally { await srv.close(); }
});

test('clients command：--timeout 非数字 → ARGS 退 2', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'command', 'ext-1', 'navigate', '--timeout', 'abc']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /invalid --timeout: NaN/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('clients command：--timeout 0（非正）→ ARGS 退 2', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'command', 'ext-1', 'navigate', '--timeout', '0']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
  } finally { await srv.close(); }
});

test('clients command：502 → RUNTIME 退 1（透传 body）', async () => {
  const srv = await startMockServer(() => ({ status: 502, json: { ok: false, error: '扩展执行失败' } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'command', 'ext-1', 'navigate']));
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'RUNTIME');
    assert.equal(body.status, 502);
  } finally { await srv.close(); }
});

// ── 2026-08-25 全端点排序：list --sort/--desc 成对下发 + 未传不带 query + 非法 --sort ARGS ──
test('clients list：--sort 传 → sort+desc 成对下发；未传 → 无 query；非法 → ARGS 退 2', async () => {
  // 未传 --sort：路径无 query（与旧版一致）
  const srv0 = await startMockServer(() => ({ status: 200, json: { clients: [] } }));
  try {
    const r = await cli(args(srv0.url, ['clients', 'list']));
    assert.equal(r.code, 0);
    assert.equal(srv0.reqs[0]!.path, '/api/clients', '未传 --sort 不带排序 query');
  } finally { await srv0.close(); }
  // --sort name（缺省 desc=true）→ query 带 sort=name&desc=true
  const srv = await startMockServer(() => ({ status: 200, json: { clients: [] } }));
  try {
    const r = await cli(args(srv.url, ['clients', 'list', '--sort', 'name']));
    assert.equal(r.code, 0);
    assert.equal(srv.reqs[0]!.path, '/api/clients?sort=name&desc=true');
    const r2 = await cli(args(srv.url, ['clients', 'list', '--sort', 'first_seen', '--desc=false']));
    assert.equal(r2.code, 0);
    assert.equal(srv.reqs[1]!.path, '/api/clients?sort=first_seen&desc=false');
  } finally { await srv.close(); }
  // 非法 --sort → ARGS 退 2（不发请求）
  const bad = await cli(args(DEAD, ['clients', 'list', '--sort', 'bogus']));
  assert.equal(bad.code, 2);
  assert.match(bad.err, /非法 --sort: bogus（可选: last_seen\|first_seen\|name）/);
});
