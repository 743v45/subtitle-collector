// creators.ts commander 装配层测试：子进程跑真 CLI + 本地 mock HTTP server（真 fetch 走真 HTTP），
// 覆盖两个 action 成功路径（query/路径形状）+ handleHttpError 归一化（SERVER_UNREACHABLE /
// NOT_FOUND / RUNTIME）+ ARGS 校验（非法 --sort/--page、id 非数字，均不发请求）。
// 纯函数（creatorsList/creatorsGet 的 query 组装与响应归一）见 creators.test.ts。
// 先例：tasks.cli.test.ts（同构 mock server 基建；账本 P1-7 / cli-completeness #7，2026-10-05）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | list 筛选/排序/分页 query 透传 + 最小调用无 query + get 成功与失败路径 + ARGS + 404/500/不可达 | 通过 | 2026-10-05；先行失败（模块不存在）后实现转绿，pnpm qa 全绿 |

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

// ── creators list ──

test('creators list：筛选/七键排序/分页参数透传进 query，响应去 ok 外壳，退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, total: 1, items: [{ id: 9, name: '某UP', fans: 12345 }] } }));
  try {
    const r = await cli(args(srv.url, [
      'creators', 'list',
      '--q', '科技', '--category', 'AI', '--scope', 'agent', '--source', 'bilibili',
      '--page', '2', '--size', '30',
      '--sort', 'fans', '--desc=false',
    ]));
    assert.equal(r.code, 0);
    // 输出 = server 体去 ok（{total,items}）
    assert.deepEqual(JSON.parse(r.out), { total: 1, items: [{ id: 9, name: '某UP', fans: 12345 }] });
    assert.equal(srv.reqs[0]!.method, 'GET');
    const u = new URL('http://x' + srv.reqs[0]!.path);
    assert.equal(u.pathname, '/api/creators');
    assert.equal(u.searchParams.get('q'), '科技');
    assert.equal(u.searchParams.get('category'), 'AI');
    assert.equal(u.searchParams.get('scope'), 'agent');
    assert.equal(u.searchParams.get('source'), 'bilibili');
    assert.equal(u.searchParams.get('page'), '2');
    assert.equal(u.searchParams.get('size'), '30');
    assert.equal(u.searchParams.get('sort'), 'fans');
    assert.equal(u.searchParams.get('desc'), 'false');
  } finally { await srv.close(); }
});

test('creators list：最小调用不带 query（端点走默认 page=1/size=20/first_seen 降序），退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, total: 0, items: [] } }));
  try {
    const r = await cli(args(srv.url, ['creators', 'list']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { total: 0, items: [] });
    assert.equal(srv.reqs[0]!.path, '/api/creators', '未传参数不带 query');
  } finally { await srv.close(); }
});

test('creators list：非法 --sort → ARGS 退 2，不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['creators', 'list', '--sort', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 --sort: bogus（可选: first_seen\|fans\|video_count\|following\|level\|updated_at\|name）/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('creators list：非数字 --page → ARGS 退 2，不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['creators', 'list', '--page', 'abc']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 --page: abc/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('creators list：非法 --scope → ARGS 退 2，不发请求（值域 agent|human 本地白名单，对齐 --sort 口径）', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(srv.url, ['creators', 'list', '--scope', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /非法 --scope: bogus（可选: agent\|human）/);
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); }
});

test('creators list：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args(DEAD, ['creators', 'list']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  assert.match(r.err, /cannot reach server/);
});

// ── creators get ──

test('creators get：200 → 透传创作者详情（P2 字段/分类 join 在 creator 内），退 0', async () => {
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, creator: { id: 9, source: 'bilibili', source_uid: '42', name: '某UP', fans: 1000, category_agent_name: 'AI' } } }));
  try {
    const r = await cli(args(srv.url, ['creators', 'get', '9']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, creator: { id: 9, source: 'bilibili', source_uid: '42', name: '某UP', fans: 1000, category_agent_name: 'AI' } });
    assert.equal(srv.reqs[0]!.method, 'GET');
    assert.equal(srv.reqs[0]!.path, '/api/creators/9');
  } finally { await srv.close(); }
});

test('creators get：404 → NOT_FOUND 退 5；非数字 id → ARGS 退 2 不发请求', async () => {
  const srv = await startMockServer(() => ({ status: 404, json: { ok: false, error: 'not found' } }));
  try {
    const r = await cli(args(srv.url, ['creators', 'get', '999']));
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
    const r2 = await cli(args(srv.url, ['creators', 'get', 'abc']));
    assert.equal(r2.code, 2);
    assert.equal(JSON.parse(r2.out).code, 'ARGS');
    assert.match(r2.err, /非法 <id>: abc/);
    assert.equal(srv.reqs.length, 1, '非数字 id 不应发请求');
  } finally { await srv.close(); }
});

test('creators get：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args(DEAD, ['creators', 'get', '9']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
});
