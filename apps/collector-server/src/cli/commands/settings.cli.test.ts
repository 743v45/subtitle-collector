// settings.ts commander 装配层测试：子进程跑真 CLI + 本地 mock HTTP server（真 fetch 走真 HTTP），
// 覆盖 get/set 两 action × 两键的成功路径（method/path/body 形状）+ handleHttpError 归一化
//（SERVER_UNREACHABLE / RUNTIME）+ ARGS 校验（未知键、缺 --order、非法排列、缺超时键、
// 越界/非数字毫秒，均不发请求）。纯函数（分派/透传/排列解析）见 settings.test.ts。
// 先例：creators.cli.test.ts（同构 mock server 基建；账本 P1-9 / cli-completeness #9，2026-10-05）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | get×2 键 + set×2 键请求形状 + 400/不可达归一 + ARGS×6 | 通过 | 2026-10-05；先行失败（模块不存在）后实现转绿，pnpm qa 全绿 |

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

// ── settings get ──

test('settings get tag-priority：GET /api/settings/tag-priority 透传 {ok,priority}，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, priority: ['manual', 'batch', 'bili', 'season', 'ai', 'system'] } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'get', 'tag-priority']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, priority: ['manual', 'batch', 'bili', 'season', 'ai', 'system'] });
    assert.equal(srv.reqs[0]!.method, 'GET');
    assert.equal(srv.reqs[0]!.path, '/api/settings/tag-priority');
  } finally { await srv.close(); }
});

test('settings get collect-timeout：GET /api/settings/collect-timeout 透传 {ok,...三键}，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, bilibili: 90000, youtube: 45000, douyin: 45000 } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'get', 'collect-timeout']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, bilibili: 90000, youtube: 45000, douyin: 45000 });
    assert.equal(srv.reqs[0]!.method, 'GET');
    assert.equal(srv.reqs[0]!.path, '/api/settings/collect-timeout');
  } finally { await srv.close(); }
});

test('settings get：未知键 → ARGS 退 2 不发请求（本地白名单，省一次往返）', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'get', 'bogus-key']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /未知设置键: bogus-key（可选: tag-priority\|collect-timeout）/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('settings get：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args(DEAD, ['settings', 'get', 'tag-priority']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  assert.match(r.err, /cannot reach server/);
});

// ── settings set tag-priority ──

test('settings set tag-priority --order 乱序六档：PUT body {priority:[...]}，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, priority: ['ai', 'manual', 'batch', 'bili', 'season', 'system'] } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'set', 'tag-priority', '--order', 'ai,manual,batch,bili,season,system']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, priority: ['ai', 'manual', 'batch', 'bili', 'season', 'system'] });
    assert.equal(srv.reqs[0]!.method, 'PUT');
    assert.equal(srv.reqs[0]!.path, '/api/settings/tag-priority');
    assert.deepEqual(srv.reqs[0]!.body, { priority: ['ai', 'manual', 'batch', 'bili', 'season', 'system'] });
  } finally { await srv.close(); }
});

test('settings set tag-priority：缺 --order / 缺档排列 → ARGS 退 2 不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'set', 'tag-priority']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /需 --order/);
    const r2 = await cli(args(srv.url, ['settings', 'set', 'tag-priority', '--order', 'manual,batch,bili,season,ai']));
    assert.equal(r2.code, 2);
    assert.match(r2.err, /精确排列/);
    assert.equal(srv.reqs.length, 0, '两个失败分支都不应发请求');
  } finally { await srv.close(); }
});

test('settings set tag-priority：未知档 --order → ARGS 退 2 不发请求（错误信息列全六档）', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'set', 'tag-priority', '--order', 'manual,batch,bili,season,ai,bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /manual\|batch\|bili\|season\|ai\|system/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

// ── settings set collect-timeout ──

test('settings set collect-timeout 三键合法：PUT body {bilibili,youtube,douyin}，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, bilibili: 120000, youtube: 60000, douyin: 60000 } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'set', 'collect-timeout', '--bilibili', '120000', '--youtube', '60000', '--douyin', '60000']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, bilibili: 120000, youtube: 60000, douyin: 60000 });
    assert.equal(srv.reqs[0]!.method, 'PUT');
    assert.equal(srv.reqs[0]!.path, '/api/settings/collect-timeout');
    assert.deepEqual(srv.reqs[0]!.body, { bilibili: 120000, youtube: 60000, douyin: 60000 });
  } finally { await srv.close(); }
});

test('settings set collect-timeout：缺任一键 → ARGS 退 2 不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'set', 'collect-timeout', '--bilibili', '90000', '--youtube', '45000']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /三键.*齐全|--bilibili\/--youtube\/--douyin/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('settings set collect-timeout：越界毫秒（低于下限/高于上限）→ ARGS 退 2 不发请求（[15s,600s] 本地白名单）', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'set', 'collect-timeout', '--bilibili', '90000', '--youtube', '1000', '--douyin', '45000']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--youtube: 1000/);
    const r2 = await cli(args(srv.url, ['settings', 'set', 'collect-timeout', '--bilibili', '90000', '--youtube', '45000', '--douyin', '700000']));
    assert.equal(r2.code, 2);
    assert.match(r2.err, /--douyin: 700000/);
    assert.equal(srv.reqs.length, 0, '两个越界分支都不应发请求');
  } finally { await srv.close(); }
});

test('settings set collect-timeout：非数字毫秒 → ARGS 退 2 不发请求；未知键 set → ARGS 退 2', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'set', 'collect-timeout', '--bilibili', 'fast', '--youtube', '45000', '--douyin', '45000']));
    assert.equal(r.code, 2);
    assert.match(r.err, /非法 --bilibili: fast/);
    const r2 = await cli(args(srv.url, ['settings', 'set', 'bogus-key']));
    assert.equal(r2.code, 2);
    assert.match(r2.err, /未知设置键: bogus-key/);
    assert.equal(srv.reqs.length, 0, '两个失败分支都不应发请求');
  } finally { await srv.close(); }
});

test('settings set collect-timeout：server 400 → RUNTIME 退 1（PUT 错误路径归一，带 status/body）', async () => {
  const srv = await startMockServer(() => ({ status: 400, json: { ok: false, error: 'collect timeout must be {bilibili, youtube, douyin} integer ms in [15000, 600000]' } }));
  try {
    const r = await cli(args(srv.url, ['settings', 'set', 'collect-timeout', '--bilibili', '90000', '--youtube', '45000', '--douyin', '45000']));
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'RUNTIME');
    assert.equal(body.status, 400);
    assert.match(r.err, /400/);
  } finally { await srv.close(); }
});
