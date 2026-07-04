// server 命令组测试：纯函数（路径 / spawn 计划 / pid IO）+ 处理函数（stub client）。
// 不真起 server 进程（不稳）；start/stop 的 spawn 行为靠手动验证 + 集成验收。
// 对齐全局 8.2「测试轮次记录表」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSpawnOptions,
  handleServerPing,
  handleServerStatus,
  isProcessAlive,
  logFilePath,
  pidFilePath,
  readPidFile,
  removePidFile,
  serverRoot,
  writePidFile,
  type PingClient,
  type ServerStatusResult,
} from './server.js';

// ── 测试轮次记录表（对齐全局 8.2）──
// | 轮次 | 范围 | 结果 | 备注 |
// | R1   | 纯函数（路径 / spawn 计划 / pid IO）+ ping/status 处理 | 待填 | 不真起 server |
// | R2   | start/stop spawn 行为（手动验证 + 集成验收）| 待主控阶段3 | |

// ─────────────────────────────────────────────────────────────────────────────
// 路径解析
// ─────────────────────────────────────────────────────────────────────────────

test('serverRoot: 解析到 apps/collector-server 绝对路径', () => {
  const root = serverRoot();
  assert.ok(/apps[/]collector-server$/.test(root), `root 应以 apps/collector-server 结尾: ${root}`);
  assert.ok(isAbsoluteish(root), `root 应为绝对路径: ${root}`);
});

// node:path isAbsolute 在 posix/macOS 上以 '/' 开头即 true；为稳妥单独判一下。
function isAbsoluteish(p: string): boolean {
  return p.startsWith('/');
}

test('pidFilePath / logFilePath: 默认指向 serverRoot 下的固定文件名', () => {
  assert.ok(pidFilePath().endsWith('apps/collector-server/.collector-server.pid'));
  assert.ok(logFilePath().endsWith('apps/collector-server/.collector-server.log'));
});

test('pidFilePath / logFilePath: 传入自定义 root 时拼接在该 root 下', () => {
  const root = '/tmp/fake-root';
  assert.equal(pidFilePath(root), '/tmp/fake-root/.collector-server.pid');
  assert.equal(logFilePath(root), '/tmp/fake-root/.collector-server.log');
});

// ─────────────────────────────────────────────────────────────────────────────
// pid 文件读写（临时目录）
// ─────────────────────────────────────────────────────────────────────────────

test('readPidFile: 文件不存在 → null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-pid-'));
  try {
    assert.equal(readPidFile(join(dir, '.collector-server.pid')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writePidFile + readPidFile: 往返正确', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-pid-'));
  const path = join(dir, '.collector-server.pid');
  try {
    writePidFile(path, 12345);
    assert.equal(readFileSync(path, 'utf-8'), '12345');
    assert.equal(readPidFile(path), 12345);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readPidFile: 内容非正整数（空 / 浮点 / 负 / 文本）→ null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-pid-'));
  try {
    for (const content of ['', '   ', '12.5', '-3', 'not-a-pid', '0']) {
      const path = join(dir, `pid-${content.length}-${content.replace(/[^a-z0-9]/gi, '_')}`);
      writeFileSync(path, content, 'utf-8');
      assert.equal(readPidFile(path), null, `应判 null: "${content}"`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writePidFile: 非法 pid 抛错（防御）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-pid-'));
  try {
    assert.throws(() => writePidFile(join(dir, 'a'), 0));
    assert.throws(() => writePidFile(join(dir, 'b'), -1));
    assert.throws(() => writePidFile(join(dir, 'c'), 1.5));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removePidFile: 删除已存在文件；不存在时幂等不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-pid-'));
  const path = join(dir, '.collector-server.pid');
  try {
    writePidFile(path, 999);
    assert.ok(existsSync(path));
    removePidFile(path);
    assert.ok(!existsSync(path));
    // 再次删除不抛
    assert.doesNotThrow(() => removePidFile(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// isProcessAlive
// ─────────────────────────────────────────────────────────────────────────────

test('isProcessAlive: 当前进程存活 → true', () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test('isProcessAlive: 不存在的 pid（极大值）→ false', () => {
  // 4_000_000 远超典型 pid 上限，几乎必然不存在
  assert.equal(isProcessAlive(4_000_000), false);
});

test('isProcessAlive: 非法 pid → false', () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(1.5), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSpawnOptions（纯）
// ─────────────────────────────────────────────────────────────────────────────

test('buildSpawnOptions: 默认 detached=true，cmd/args/cwd 固定，env 不含 port/db', () => {
  const plan = buildSpawnOptions({}, { PATH: '/usr/bin', HOME: '/h' });
  assert.equal(plan.cmd, 'tsx');
  assert.deepEqual(plan.args, ['src/main.ts']);
  assert.ok(plan.cwd.endsWith('apps/collector-server'), `cwd: ${plan.cwd}`);
  assert.equal(plan.detached, true);
  assert.ok(plan.logPath.endsWith('apps/collector-server/.collector-server.log'));
  assert.equal(plan.env.PATH, '/usr/bin'); // 继承 baseEnv
  assert.equal(plan.env.COLLECTOR_PORT, undefined);
  assert.equal(plan.env.COLLECTOR_DB_PATH, undefined);
});

test('buildSpawnOptions: detached=false 透传', () => {
  const plan = buildSpawnOptions({ detached: false }, {});
  assert.equal(plan.detached, false);
});

test('buildSpawnOptions: port → env.COLLECTOR_PORT 字符串', () => {
  const plan = buildSpawnOptions({ port: 12345 }, {});
  assert.equal(plan.env.COLLECTOR_PORT, '12345');
});

test('buildSpawnOptions: db → env.COLLECTOR_DB_PATH', () => {
  const plan = buildSpawnOptions({ db: '/data/x.db' }, {});
  assert.equal(plan.env.COLLECTOR_DB_PATH, '/data/x.db');
});

test('buildSpawnOptions: 同时 port + db 都生效', () => {
  const plan = buildSpawnOptions({ port: 8080, db: '/data/y.db' }, {});
  assert.equal(plan.env.COLLECTOR_PORT, '8080');
  assert.equal(plan.env.COLLECTOR_DB_PATH, '/data/y.db');
});

test('buildSpawnOptions: 不污染传入的 baseEnv（浅拷贝）', () => {
  const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
  buildSpawnOptions({ port: 1 }, base);
  assert.equal(base.COLLECTOR_PORT, undefined, '不应回写到原对象');
});

// ─────────────────────────────────────────────────────────────────────────────
// handleServerPing（stub client）
// ─────────────────────────────────────────────────────────────────────────────

function makeStubClient(online: boolean): PingClient {
  return { ping: async () => online };
}

test('handleServerPing: online=true → 透传 server_url', async () => {
  const result = await handleServerPing(makeStubClient(true), 'http://127.0.0.1:21527');
  assert.deepEqual(result, { online: true, server_url: 'http://127.0.0.1:21527' });
});

test('handleServerPing: online=false → 不抛', async () => {
  const result = await handleServerPing(makeStubClient(false), 'http://127.0.0.1:21527');
  assert.equal(result.online, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// handleServerStatus（stub client + 临时 pid 文件 + 不存在的 DB）
// ─────────────────────────────────────────────────────────────────────────────

test('handleServerStatus: offline + 无 DB + 无 pid 文件 + 默认 token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-status-'));
  const pidPath = join(dir, '.collector-server.pid');
  const dbPath = join(dir, 'no-such.db');
  try {
    const result: ServerStatusResult = await handleServerStatus({
      client: makeStubClient(false),
      dbPath,
      pidFilePath: pidPath,
      serverUrl: 'http://127.0.0.1:21527',
      token: 'change-me-collector-token', // 默认 token
    });
    assert.equal(result.online, false);
    assert.equal(result.server_url, 'http://127.0.0.1:21527');
    // DB 不存在 → exists:false，无 overview
    assert.equal(result.db.path, dbPath);
    assert.equal(result.db.exists, false);
    assert.equal(result.db.overview, undefined);
    // pid 文件不存在
    assert.equal(result.pid_file.path, pidPath);
    assert.equal(result.pid_file.exists, false);
    assert.equal(result.pid_file.pid, undefined);
    // 配置：端口从 serverUrl 解析；token 为默认 → token_configured=false
    assert.equal(result.config.port, 21527);
    assert.equal(result.config.token_configured, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleServerStatus: online=true + 非默认 token → token_configured=true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-status-'));
  const pidPath = join(dir, '.collector-server.pid');
  const dbPath = join(dir, 'no-such.db');
  try {
    const result = await handleServerStatus({
      client: makeStubClient(true),
      dbPath,
      pidFilePath: pidPath,
      serverUrl: 'http://127.0.0.1:3000',
      token: 'real-secret-token',
    });
    assert.equal(result.online, true);
    assert.equal(result.config.port, 3000);
    assert.equal(result.config.token_configured, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleServerStatus: pid 文件存在 → pid_file.exists=true + pid 字段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-status-'));
  const pidPath = join(dir, '.collector-server.pid');
  const dbPath = join(dir, 'no-such.db');
  try {
    writePidFile(pidPath, 4242);
    const result = await handleServerStatus({
      client: makeStubClient(false),
      dbPath,
      pidFilePath: pidPath,
      serverUrl: 'http://127.0.0.1:21527',
      token: 'change-me-collector-token',
    });
    assert.equal(result.pid_file.exists, true);
    assert.equal(result.pid_file.pid, 4242);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleServerStatus: 非法 serverUrl → port=null，不抛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-status-'));
  try {
    const result = await handleServerStatus({
      client: makeStubClient(false),
      dbPath: join(dir, 'no.db'),
      pidFilePath: join(dir, 'pid'),
      serverUrl: 'not-a-url',
      token: 'change-me-collector-token',
    });
    assert.equal(result.config.port, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
