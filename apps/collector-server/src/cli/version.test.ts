// version.ts（CLI 版本单源）测试：锁定「CLI 输出的 VERSION === package.json version」。
// 背景（P1-11 / cli-completeness #11，2026-10-05）：VERSION 曾在 main.ts 硬编码 '0.1.0'，
// 与 package.json 漂移不可测——本文件先以「main.ts 未导出 VERSION」证明不可测（红灯轮），
// 实现后转绿，之后任何人改 package.json version 或重新引入硬编码都会被这里拦下。
//
// 三层锁定：
//  1. main.ts 导出的 VERSION === package.json version（进程内，锁装配层同源）；
//  2. readCliVersion 纯函数各分支（依赖注入 read/log，不落盘）；
//  3. 真 CLI 子进程两端到端（--version 旗标 + version 子命令）输出 === package.json version。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 全部用例 | 失败 | 红灯：version.ts 不存在 + main.ts 未导出 VERSION（硬编码不可测证明） |
// | R2 | 全部用例 | 通过 | 实现 version.ts + main.ts 接线后转绿 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/cli
const MAIN_TS = join(HERE, 'main.ts');
const APP_ROOT = resolve(HERE, '../..'); // apps/collector-server

// 期望值第二来源：测试独立读 package.json（不经 version.ts），两边同源才算锁住。
const PKG = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { version: string };

import { readCliVersion } from './version.js';
import * as mainNs from './main.js';

// 跑真 CLI 子进程（形态同 main.test.ts：node --import tsx src/cli/main.ts）。
function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, ...args], {
      cwd: APP_ROOT,
      env: process.env,
    }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
}

// ── 1. 装配层同源：main.ts 导出的 VERSION ──

test('main.ts 导出 VERSION 且与 package.json version 同源（锁硬编码漂移回归）', () => {
  assert.equal(typeof (mainNs as { VERSION?: unknown }).VERSION, 'string', 'main.ts 必须导出 VERSION（此前硬编码不可测）');
  assert.equal(mainNs.VERSION, PKG.version);
});

// ── 2. readCliVersion 纯函数各分支（依赖注入，不真读盘）──

test('readCliVersion：默认依赖读 package.json → 与 version 字段一致', () => {
  assert.equal(readCliVersion(), PKG.version);
});

test('readCliVersion：read 抛错 → 兜底值 + 日志带错误信息与兜底值', () => {
  const logs: string[] = [];
  const v = readCliVersion({
    read: () => { throw new Error('EACCES: permission denied'); },
    log: (line) => logs.push(line),
  });
  assert.equal(v, '0.0.0-unknown');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EACCES: permission denied/, '日志应带关键错误信息');
  assert.match(logs[0], /0\.0\.0-unknown/, '日志应带兜底值');
});

test('readCliVersion：JSON 解析失败 → 兜底值 + 日志（同一 catch 分支）', () => {
  const logs: string[] = [];
  const v = readCliVersion({ read: () => 'not-json{{', log: (line) => logs.push(line) });
  assert.equal(v, '0.0.0-unknown');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /0\.0\.0-unknown/);
});

test('readCliVersion：version 字段缺失/非字符串/空串 → 兜底值 + 日志', () => {
  const cases = ['{"name":"x"}', '{"version":123}', '{"version":""}'];
  for (const raw of cases) {
    const logs: string[] = [];
    const v = readCliVersion({ read: () => raw, log: (line) => logs.push(line) });
    assert.equal(v, '0.0.0-unknown', `case=${raw}`);
    assert.equal(logs.length, 1, `case=${raw}`);
    assert.match(logs[0], /version/, `日志应指明 version 字段异常，case=${raw}`);
  }
});

test('readCliVersion：默认 log 走 console.error（stderr），不注入 log 的异常路径日志也落地', () => {
  const orig = console.error;
  const lines: string[] = [];
  console.error = ((line?: unknown) => { lines.push(String(line)); }) as typeof console.error;
  try {
    const v = readCliVersion({ read: () => { throw new Error('boom'); } });
    assert.equal(v, '0.0.0-unknown');
  } finally {
    console.error = orig;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /boom/);
});

// ── 3. 端到端：真 CLI 子进程输出 ──

test('真 CLI：--version 旗标输出 === package.json version', async () => {
  const r = await cli(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), PKG.version);
});

test('真 CLI：version 子命令 JSON 的 version 字段 === package.json version', async () => {
  const r = await cli(['version', '--db', '/tmp/none.db', '--server', 'http://127.0.0.1:1', '--token', 't']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { name: 'collector-cli', version: PKG.version });
});
