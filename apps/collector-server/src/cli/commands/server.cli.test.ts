// server.ts commander 装配层测试：子进程跑真 CLI。ping/status 走本地 mock HTTP server；
// start/stop 触及真实 pid 文件（apps/collector-server/.collector-server.pid）与真实 spawn/kill：
//  - start 仅测 validatePort 失败路径（成功路径会真起 server，不强测——对齐文件头注释）；
//  - stop 测 pid 文件不存在 / 陈旧 pid / 存活子进程（spawn sleep 承载，SIGTERM 后回收）。
//  注意：pid 文件位于真实仓库路径。测试前置守卫：若该文件已存在（本机真有 server 在跑）则 skip，
//  绝不误杀真实进程；所有写入在 finally 清理。
// 纯函数（路径/pid IO/spawn 计划/ping/status 处理）见 server.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | ping/status action + start validatePort 失败 + stop 三态（无 pid / 陈旧 / 存活） | 通过 | start 成功路径不强测 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { pidFilePath } from './server.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/cli/commands
const MAIN_TS = join(HERE, '..', 'main.ts');
const APP_ROOT = resolve(HERE, '../../..');
const REAL_PID_PATH = pidFilePath(); // apps/collector-server/.collector-server.pid（真实路径，测试守卫+清理）

function cli(args_: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, ...args_], { cwd: APP_ROOT }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
}

interface SrvReq { method: string; path: string }
interface SrvRes { status: number; json?: unknown }
type Responder = (req: SrvReq) => SrvRes;

function startMockServer(respond: Responder): Promise<{ url: string; reqs: SrvReq[]; close(): Promise<void> }> {
  return new Promise((resolveSrv) => {
    const reqs: SrvReq[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on('data', () => { /* 丢弃 body */ });
      req.on('end', () => {
        const rec: SrvReq = { method: req.method ?? '', path: req.url ?? '' };
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

const DEAD = 'http://127.0.0.1:1';
const args = (serverUrl: string, dbPath: string, rest: string[]): string[] =>
  ['--db', dbPath, '--server', serverUrl, '--token', 'tok-1', ...rest];

// ── server ping ──

test('server ping：GET /ping 2xx → {online:true, server_url}，退 0', async () => {
  const srv = await startMockServer((req) => (req.path === '/ping' ? { status: 200, json: { ok: true } } : { status: 404 }));
  try {
    const r = await cli(args(srv.url, '/tmp/none.db', ['server', 'ping']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { online: true, server_url: srv.url });
    assert.equal(srv.reqs[0]!.path, '/ping');
  } finally { await srv.close(); }
});

test('server ping：非 2xx → online:false（ping 不抛），退 0', async () => {
  const srv = await startMockServer(() => ({ status: 503, json: { error: 'busy' } }));
  try {
    const r = await cli(args(srv.url, '/tmp/none.db', ['server', 'ping']));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).online, false);
  } finally { await srv.close(); }
});

test('server ping：不可达 → online:false，退 0', async () => {
  const r = await cli(args(DEAD, '/tmp/none.db', ['server', 'ping']));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).online, false);
});

// ── server status ──

test('server status：online + DB 可读（带 overview）+ pid 文件缺失 + token 已配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-server-cli-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '甲', creator: { source_uid: '1', name: 'UP' }, extra: {}, duration: 60, published_at: 1 },
    tracks: [],
  });
  db.close();
  const srv = await startMockServer((req) => (req.path === '/ping' ? { status: 200, json: { ok: true } } : { status: 404 }));
  try {
    // 真实 pid 文件当前不存在（setup 守卫）时才能断 pid_file.exists=false
    const pidExists = existsSync(REAL_PID_PATH);
    const r = await cli(args(srv.url, join(dir, 'test.db'), ['server', 'status']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.online, true);
    assert.equal(data.server_url, srv.url);
    assert.equal(data.db.exists, true);
    assert.equal(data.db.overview.videos, 1);
    if (!pidExists) {
      assert.equal(data.pid_file.exists, false);
      assert.equal(data.pid_file.path, REAL_PID_PATH);
    }
    const port = Number(new URL(srv.url).port);
    assert.equal(data.config.port, port);
    assert.equal(data.config.token_configured, true); // --token tok-1 非默认空
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('server status：offline + DB 缺失 → db.exists=false + token_configured=false（默认空 token）', async () => {
  const r = await cli([ '--db', '/tmp/no-such.db', '--server', DEAD, 'server', 'status']);
  assert.equal(r.code, 0);
  const data = JSON.parse(r.out);
  assert.equal(data.online, false);
  assert.equal(data.db.exists, false);
  assert.equal(data.config.token_configured, false);
  assert.equal(data.config.port, 1); // URL 显式端口 1 → parsePort 返回 1（无端口才 null）
});

// ── server start（仅 validatePort 失败路径；成功路径会真起 server，不强测）──

test('server start --port 70000：非法端口 → CliError RUNTIME 退 1', async () => {
  const r = await cli(args(DEAD, '/tmp/none.db', ['server', 'start', '--port', '70000']));
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).code, 'RUNTIME');
  assert.match(r.err, /invalid port: 70000/);
});

test('server start --port abc：NaN → CliError RUNTIME 退 1', async () => {
  const r = await cli(args(DEAD, '/tmp/none.db', ['server', 'start', '--port', 'abc']));
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).code, 'RUNTIME');
  assert.match(r.err, /invalid port: NaN/);
});

// ── server stop（真实 pid 文件三态）──

test('server start：pid 文件存活（本进程 pid）→ CliError already running 退 1，不 spawn', async (t) => {
  if (existsSync(REAL_PID_PATH)) return t.skip('真实 pid 文件存在（本机 server 在跑），跳过避免误伤');
  writeFileSync(REAL_PID_PATH, String(process.pid), 'utf-8'); // 本测试进程必然存活
  try {
    const r = await cli(args(DEAD, '/tmp/none.db', ['server', 'start']));
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`server already running, pid=${process.pid}`));
    assert.equal(existsSync(REAL_PID_PATH), true, '存活 pid 不被清理');
  } finally {
    rmSync(REAL_PID_PATH);
  }
});

test('server start 成功路径：随机端口起真 server（--db 临时库）→ {ok,pid} + pid 文件 → stop SIGTERM 回收', { timeout: 30_000 }, async (t) => {
  if (existsSync(REAL_PID_PATH)) return t.skip('真实 pid 文件存在（本机 server 在跑），跳过避免误伤');
  // 找一个空闲端口（listen 0 后释放再复用；测试窗口内冲突概率极低）
  const port = await new Promise<number>((resolvePort) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolvePort(p));
    });
  });
  const tmpDb = join(mkdtempSync(join(tmpdir(), 'collector-start-')), 't.db');
  try {
    const r = await cli(args(DEAD, tmpDb, ['server', 'start', '--port', String(port)]));
    assert.equal(r.code, 0, `start 应成功：${r.err}`);
    const data = JSON.parse(r.out);
    assert.equal(data.ok, true);
    assert.equal(typeof data.pid, 'number');
    assert.equal(existsSync(REAL_PID_PATH), true, 'pid 文件落盘');
    // stop：SIGTERM 回收 + pid 文件删除（detached tsx 进程组）
    const stop = await cli(args(DEAD, tmpDb, ['server', 'stop']));
    assert.equal(stop.code, 0, `stop 应成功：${stop.err}`);
    assert.equal(JSON.parse(stop.out).pid, data.pid);
    assert.equal(existsSync(REAL_PID_PATH), false, 'stop 后 pid 文件删除');
  } finally {
    if (existsSync(REAL_PID_PATH)) {
      // 兜底清理：stop 失败时杀掉测试起的进程，不污染本机
      const pid = Number(readFileSync(REAL_PID_PATH, 'utf-8'));
      if (Number.isInteger(pid) && pid !== process.pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
      rmSync(REAL_PID_PATH);
    }
    rmSync(dirname(tmpDb), { recursive: true, force: true });
  }
});

test('server stop：pid 文件不存在 → NOT_FOUND 退 5', async (t) => {
  if (existsSync(REAL_PID_PATH)) return t.skip('真实 pid 文件存在（本机 server 在跑），跳过避免误伤');
  const r = await cli(args(DEAD, '/tmp/none.db', ['server', 'stop']));
  assert.equal(r.code, 5);
  assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
  assert.match(r.err, /pid file not found/);
});

test('server stop：陈旧 pid（进程已死）→ 清理 pid 文件后 NOT_FOUND 退 5', async (t) => {
  if (existsSync(REAL_PID_PATH)) return t.skip('真实 pid 文件存在（本机 server 在跑），跳过避免误伤');
  writeFileSync(REAL_PID_PATH, '4000000', 'utf-8'); // 极大 pid，几乎必然不存在
  try {
    const r = await cli(args(DEAD, '/tmp/none.db', ['server', 'stop']));
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
    assert.match(r.err, /stale pid file: pid 4000000 not alive \(cleaned\)/);
    assert.equal(existsSync(REAL_PID_PATH), false, '陈旧 pid 文件应被清理');
  } finally {
    if (existsSync(REAL_PID_PATH)) rmSync(REAL_PID_PATH);
  }
});

test('server stop：存活子进程 → SIGTERM + 删 pid 文件 → {ok:true,pid}，退 0', async (t) => {
  if (existsSync(REAL_PID_PATH)) return t.skip('真实 pid 文件存在（本机 server 在跑），跳过避免误伤');
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    writeFileSync(REAL_PID_PATH, String(child.pid), 'utf-8');
    // exit 监听须在 CLI 跑之前挂好（SIGTERM 在 cli() 期间就发生，晚挂会错过事件）
    const exitPromise = new Promise<boolean>((resolveExit) => {
      child.once('exit', () => resolveExit(true));
      setTimeout(() => resolveExit(false), 5000);
    });
    const r = await cli(args(DEAD, '/tmp/none.db', ['server', 'stop']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.ok, true);
    assert.equal(data.pid, child.pid);
    assert.equal(existsSync(REAL_PID_PATH), false, 'stop 后 pid 文件应删除');
    assert.equal(await exitPromise, true, '子进程应收到 SIGTERM 后退出');
  } finally {
    child.kill('SIGKILL');
    if (existsSync(REAL_PID_PATH)) rmSync(REAL_PID_PATH);
  }
});
