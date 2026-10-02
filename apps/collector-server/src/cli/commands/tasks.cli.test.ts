// tasks.ts commander 装配层测试：子进程跑真 CLI + 本地 mock HTTP server（真 fetch 走真 HTTP），
// 覆盖三个 action 成功路径（query/body 形状）+ handleHttpError 归一化（SERVER_UNREACHABLE /
// NOT_FOUND / RUNTIME）+ ARGS 校验（非法 --sort/--since、id 非数字，均不发请求）。
// 纯函数（tasksList/tasksGet/tasksRetry 的 query 组装与响应归一）见 tasks.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | list 筛选/排序/分页 query 透传 + 最小调用无 query + get/retry 成功与失败路径 + ARGS + 404/500/不可达 | 通过 | 2026-10-02；pnpm qa 全绿 |

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

// ── tasks list ──

test('tasks list：筛选/排序/分页参数透传进 query，响应去 ok 外壳，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, total: 1, items: [{ id: 9, status: 'failed' }] } }));
  try {
    const r = await cli(args(srv.url, [
      'tasks', 'list',
      '--status', 'failed,limited', '--source', 'bilibili',
      '--batch-id', 'b1', '--batch', 'batch',
      '--creator', '某UP', '--creator-uid', '42', '--q', 'BV1',
      '--since', '100', '--until', '200',
      '--page', '2', '--page-size', '10',
      '--sort', 'finished_at', '--desc=false',
    ]));
    assert.equal(r.code, 0);
    // 输出 = server 体去 ok（{total,items}）
    assert.deepEqual(JSON.parse(r.out), { total: 1, items: [{ id: 9, status: 'failed' }] });
    assert.equal(srv.reqs[0]!.method, 'GET');
    const u = new URL('http://x' + srv.reqs[0]!.path);
    assert.equal(u.pathname, '/api/collect-tasks');
    assert.equal(u.searchParams.get('status'), 'failed,limited');
    assert.equal(u.searchParams.get('source'), 'bilibili');
    assert.equal(u.searchParams.get('batch_id'), 'b1');
    assert.equal(u.searchParams.get('batch'), 'batch');
    assert.equal(u.searchParams.get('creator'), '某UP');
    assert.equal(u.searchParams.get('creator_uid'), '42');
    assert.equal(u.searchParams.get('q'), 'BV1');
    assert.equal(u.searchParams.get('since'), '100');
    assert.equal(u.searchParams.get('until'), '200');
    assert.equal(u.searchParams.get('page'), '2');
    assert.equal(u.searchParams.get('page_size'), '10');
    assert.equal(u.searchParams.get('sort'), 'finished_at');
    assert.equal(u.searchParams.get('desc'), 'false');
    assert.equal(u.searchParams.get('limit'), null, '分页形态不带 limit');
  } finally { await srv.close(); }
});

test('tasks list：最小调用不带 query；--limit 最近 N 形态透传', async () => {
  // 未传任何参数：路径裸 /api/collect-tasks（无 query，端点走默认 limit=20/created_at 降序）
  const srv0 = await startMockServer(() => ({ status: 200, json: { ok: true, total: 0, items: [] } }));
  try {
    const r = await cli(args(srv0.url, ['tasks', 'list']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { total: 0, items: [] });
    assert.equal(srv0.reqs[0]!.path, '/api/collect-tasks', '未传参数不带 query');
  } finally { await srv0.close(); }
  // --limit 形态：limit/status 进 query，page 不进
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, total: 0, items: [] } }));
  try {
    const r = await cli(args(srv.url, ['tasks', 'list', '--limit', '5', '--status', 'pending']));
    assert.equal(r.code, 0);
    const u = new URL('http://x' + srv.reqs[0]!.path);
    assert.equal(u.searchParams.get('limit'), '5');
    assert.equal(u.searchParams.get('status'), 'pending');
    assert.equal(u.searchParams.get('page'), null);
  } finally { await srv.close(); }
});

test('tasks list：非法 --sort → ARGS 退 2，不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['tasks', 'list', '--sort', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 --sort: bogus（可选: created_at\|finished_at\|status）/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('tasks list：非法 --since → ARGS 退 2，不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['tasks', 'list', '--since', 'abc']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 --since: abc/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('tasks list：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args(DEAD, ['tasks', 'list']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  assert.match(r.err, /cannot reach server/);
});

// ── tasks get ──

test('tasks get：200 → 透传任务详情（失败原因/回执字段在 task 内），退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, task: { id: 9, status: 'failed', error: '采集超时', result: null } } }));
  try {
    const r = await cli(args(srv.url, ['tasks', 'get', '9']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, task: { id: 9, status: 'failed', error: '采集超时', result: null } });
    assert.equal(srv.reqs[0]!.method, 'GET');
    assert.equal(srv.reqs[0]!.path, '/api/collect-tasks/9');
  } finally { await srv.close(); }
});

test('tasks get：404 → NOT_FOUND 退 5；非数字 id → ARGS 退 2 不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 404, json: { ok: false, error: 'not found' } }));
  try {
    const r = await cli(args(srv.url, ['tasks', 'get', '999']));
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
    const r2 = await cli(args(srv.url, ['tasks', 'get', 'abc']));
    assert.equal(r2.code, 2);
    assert.equal(JSON.parse(r2.out).code, 'ARGS');
    assert.match(r2.err, /非法 <id>: abc/);
    assert.equal(srv.reqs.length, 1, '非数字 id 不应发请求');
  } finally { await srv.close(); }
});

// ── tasks retry ──

test('tasks retry：多 id → POST body {ids:[...]}，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, retried: 2, tasks: [{ id: 7 }, { id: 8 }] } }));
  try {
    const r = await cli(args(srv.url, ['tasks', 'retry', '7', '8']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, retried: 2, tasks: [{ id: 7 }, { id: 8 }] });
    assert.equal(srv.reqs[0]!.method, 'POST');
    assert.equal(srv.reqs[0]!.path, '/api/collect-tasks/retry');
    assert.deepEqual(srv.reqs[0]!.body, { ids: [7, 8] });
  } finally { await srv.close(); }
});

test('tasks retry：非数字 id → ARGS 退 2，不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['tasks', 'retry', '7', 'x8']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 <id>: x8/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('tasks retry：500 → RUNTIME 退 1（带 status/body extra）', async () => {
  const srv = await startMockServer(() => ({ status: 500, json: { ok: false, error: 'boom' } }));
  try {
    const r = await cli(args(srv.url, ['tasks', 'retry', '7']));
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'RUNTIME');
    assert.equal(body.status, 500);
  } finally { await srv.close(); }
});

test('tasks retry：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args(DEAD, ['tasks', 'retry', '7']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
});
