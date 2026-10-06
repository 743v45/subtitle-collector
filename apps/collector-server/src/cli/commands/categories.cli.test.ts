// categories.ts commander 装配层测试：子进程跑真 CLI + 本地 mock HTTP server（真 fetch 走真 HTTP），
// 覆盖四个 action 的成功路径（method/path/body 形状）+ handleHttpError 归一化（SERVER_UNREACHABLE /
// NOT_FOUND / RUNTIME）+ ARGS 校验（非法 --sort-order、空 --name / --name-with，均不发请求）。
// 纯函数（categoriesList/… 的响应归一与透传）见 categories.test.ts。
// 先例：creators.cli.test.ts（同构 mock server 基建；账本 P1-9 / cli-completeness #9，2026-10-05）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | list/add/update/delete 请求形状 + 404/409/500/不可达归一 + ARGS×3 | 通过 | 2026-10-05；先行失败（模块不存在）后实现转绿，pnpm qa 全绿 |

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

// ── categories list ──

test('categories list：GET /api/categories 透传（creator_count 计数列在 items 内），退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, items: [{ id: 1, name: 'AI', sort_order: 0, created_at: 1700000000000, creator_count: 3 }] } }));
  try {
    const r = await cli(args(srv.url, ['categories', 'list']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), {
      total: 1,
      items: [{ id: 1, name: 'AI', sort_order: 0, created_at: 1700000000000, creator_count: 3 }],
    });
    assert.equal(srv.reqs[0]!.method, 'GET');
    assert.equal(srv.reqs[0]!.path, '/api/categories');
  } finally { await srv.close(); }
});

test('categories list：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args(DEAD, ['categories', 'list']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  assert.match(r.err, /cannot reach server/);
});

// ── categories add ──

test('categories add <name>：POST /api/categories {name}，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, category: { id: 9, name: 'AI 基础', sort_order: 0, created_at: 1700000000000, creator_count: 0 } } }));
  try {
    const r = await cli(args(srv.url, ['categories', 'add', 'AI 基础']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, category: { id: 9, name: 'AI 基础', sort_order: 0, created_at: 1700000000000, creator_count: 0 } });
    assert.equal(srv.reqs[0]!.method, 'POST');
    assert.equal(srv.reqs[0]!.path, '/api/categories');
    assert.deepEqual(srv.reqs[0]!.body, { name: 'AI 基础' });
  } finally { await srv.close(); }
});

test('categories add：全空白 name → ARGS 退 2 不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['categories', 'add', '   ']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /name 不能为空/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('categories add：撞已有名 server 409 → RUNTIME 退 1（带 status/body）', async () => {
  const srv = await startMockServer(() => ({ status: 409, json: { ok: false, error: 'category name already exists' } }));
  try {
    const r = await cli(args(srv.url, ['categories', 'add', 'AI']));
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'RUNTIME');
    assert.equal(body.status, 409);
    assert.match(r.err, /409/);
  } finally { await srv.close(); }
});

// ── categories update ──

test('categories update <id>：PATCH /api/categories/:id，body 只含已传键（--name/--sort-order 可同传），退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, category: { id: 3, name: '新名', sort_order: 2, created_at: 1700000000000, creator_count: 1 } } }));
  try {
    const r = await cli(args(srv.url, ['categories', 'update', '3', '--name', '新名', '--sort-order', '2']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, category: { id: 3, name: '新名', sort_order: 2, created_at: 1700000000000, creator_count: 1 } });
    assert.equal(srv.reqs[0]!.method, 'PATCH');
    assert.equal(srv.reqs[0]!.path, '/api/categories/3');
    assert.deepEqual(srv.reqs[0]!.body, { name: '新名', sort_order: 2 });
  } finally { await srv.close(); }
});

test('categories update：只传 --name（patch 单键）；非数字 id → ARGS 退 2 不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, category: { id: 3, name: 'X', sort_order: 0, created_at: 1, creator_count: 0 } } }));
  try {
    const r = await cli(args(srv.url, ['categories', 'update', '3', '--name', 'X']));
    assert.equal(r.code, 0);
    assert.deepEqual(srv.reqs[0]!.body, { name: 'X' });
    const r2 = await cli(args(srv.url, ['categories', 'update', 'abc', '--name', 'X']));
    assert.equal(r2.code, 2);
    assert.equal(JSON.parse(r2.out).code, 'ARGS');
    assert.match(r2.err, /非法 <id>: abc/);
    assert.equal(srv.reqs.length, 1, '非数字 id 不应发请求');
  } finally { await srv.close(); }
});

test('categories update：--sort-order 非整数 → ARGS 退 2 不发请求；空 patch（两键都缺）→ ARGS 退 2', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['categories', 'update', '3', '--sort-order', 'fast']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 --sort-order: fast/);
    const r2 = await cli(args(srv.url, ['categories', 'update', '3']));
    assert.equal(r2.code, 2);
    assert.match(r2.err, /至少传一个/);
    assert.equal(srv.reqs.length, 0, '两个失败分支都不应发请求');
  } finally { await srv.close(); }
});

test('categories update：不存在 server 404 → NOT_FOUND 退 5', async () => {
  const srv = await startMockServer(() => ({ status: 404, json: { ok: false, error: 'not found' } }));
  try {
    const r = await cli(args(srv.url, ['categories', 'update', '999', '--name', 'X']));
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
  } finally { await srv.close(); }
});

// ── categories delete ──

test('categories delete <id>：DELETE /api/categories/:id（引用置 NULL 由 server 侧做），退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['categories', 'delete', '7']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true });
    assert.equal(srv.reqs[0]!.method, 'DELETE');
    assert.equal(srv.reqs[0]!.path, '/api/categories/7');
  } finally { await srv.close(); }
});

test('categories delete：非数字 id → ARGS 退 2 不发请求；server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['categories', 'delete', 'xyz']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 <id>: xyz/);
    assert.equal(srv.reqs.length, 0);
    const r2 = await cli(args(DEAD, ['categories', 'delete', '7']));
    assert.equal(r2.code, 3);
    assert.equal(JSON.parse(r2.out).code, 'SERVER_UNREACHABLE');
  } finally { await srv.close(); }
});
