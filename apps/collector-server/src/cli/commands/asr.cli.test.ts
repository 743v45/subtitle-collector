// asr.ts commander 装配层测试：子进程跑真 CLI，server 侧 mock HTTP（圈定 + 写回）。
// 覆盖：dry-run 参数映射（--dry-run/--size/--page kebab→camel，2026-08-26 修复的装配 bug 回归）
// + 圈定请求参数（tags/source/sort/desc/page/size 逐项断言）+ cookie-file 读取与缺省提示。
// 编排纯函数见 asr.test.ts。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | dry-run（参数映射 + 圈定 query 断言）+ cookie-file 不可读 ARGS | 通过 | |
// | R2 | --dry-run 修复（曾因读 opts['dry-run'] 恒 false）后补 | 通过 | kebab→camel 回归锚点 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
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

interface SrvReq { method: string; path: string }
function startMockServer(): Promise<{ url: string; reqs: SrvReq[]; close(): Promise<void> }> {
  return new Promise((resolveSrv) => {
    const reqs: SrvReq[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      reqs.push({ method: req.method ?? '', path: req.url ?? '' });
      if ((req.url ?? '').startsWith('/api/videos')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: 1, page: 1, size: 3, items: [{ source_vid: 'BV1', title: 't', duration: 60 }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false}');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolveSrv({ url: `http://127.0.0.1:${addr.port}`, reqs, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

test('asr backfill --dry-run：参数映射正确（kebab→camel），圈定请求参数逐项正确', async () => {
  const srv = await startMockServer();
  try {
    const r = await cli(['asr', 'backfill', '--dry-run', '--size', '3', '--page', '2', '--max-duration', '600', '--asr-url', 'http://127.0.0.1:5999', '--engine', 'test-engine', '--server', srv.url]);
    assert.equal(r.code, 0, `exit 0（stderr: ${r.err.slice(-300)}）`);
    const out = JSON.parse(r.out);
    // 装配 bug 回归：曾因读 opts['dry-run'] 恒 false
    assert.equal(out.dry_run, true, '--dry-run 应映射为 dry_run:true');
    assert.equal(out.circled, 1);
    // 圈定请求：只应有一次 GET /api/videos，参数逐项断言
    assert.equal(srv.reqs.length, 1, 'dry-run 只发圈定请求');
    const u = new URL(srv.reqs[0].path, 'http://x');
    assert.equal(u.searchParams.get('tags'), 'no-subtitle');
    assert.equal(u.searchParams.get('source'), 'bilibili');
    assert.equal(u.searchParams.get('sort'), 'first_seen');
    assert.equal(u.searchParams.get('desc'), 'true');
    assert.equal(u.searchParams.get('page'), '2');
    assert.equal(u.searchParams.get('size'), '3');
    assert.equal(u.searchParams.get('max_duration'), '600', '--max-duration 透传圈定参数');
  } finally {
    await srv.close();
  }
});

test('asr backfill：--cookie-file 不可读 → ARGS 退出码，不发网络请求', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-asr-cli2-'));
  const srv = await startMockServer();
  try {
    const r = await cli(['asr', 'backfill', '--server', srv.url, '--cookie-file', join(dir, 'nope.txt')]);
    assert.equal(r.code, 2, 'ARGS 退出码');
    assert.match(r.err, /cookie 文件不可读/);
    assert.equal(srv.reqs.length, 0);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('asr backfill：server 圈定 500 → RUNTIME 退出码（错误归一化）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-asr-cli2-'));
  // mock server 对 /api/videos 回 500
  const srv = await new Promise<{ url: string; close(): Promise<void> }>((resolveSrv) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"ok":false}');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolveSrv({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
  try {
    const r = await cli(['asr', 'backfill', '--server', srv.url, '--dry-run']);
    assert.notEqual(r.code, 0, '圈定失败非零退出');
    assert.match(r.err, /asr backfill 失败/);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('asr backfill：--cookie-file 内容为空 → 按未配置处理（走完 dry-run 不报错）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-asr-cli2-'));
  const srv = await startMockServer();
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'empty-cookie.txt'), '   \n');
    const r = await cli(['asr', 'backfill', '--server', srv.url, '--cookie-file', join(dir, 'empty-cookie.txt'), '--dry-run']);
    assert.equal(r.code, 0, `空 cookie 文件应视同未配置（stderr: ${r.err.slice(-200)}）`);
    assert.match(r.err, /未配置 cookie/);
    assert.equal(JSON.parse(r.out).dry_run, true);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
