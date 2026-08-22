// main.ts（commander 装配层）测试：子进程跑真 CLI（node --import tsx src/cli/main.ts <args>），
// 断言真实退出码 + stdout JSON。子进程方式的理由（已验证）：
//  1. commander v12 program.addCommand 对重名命令抛错（"already have command"）——同进程多次 main() 不可行；
//  2. 真子进程下 emitError 的 process.exit 是真实退出（无 stub 哨兵穿透 catch 的假象），
//     main() 的 catch 分支只能由「action 内真异常」触发（见 export.cli.test.ts 的 payload 损坏用例）。
// getCliContext 未初始化分支无法经 CLI 触发（preAction 恒先跑），进程内直调 + captureExit（见 output.test.ts）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | version 子命令 + --format 非法兜底 json + commander 未知命令退 1 + getCliContext 未初始化 | 通过 | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { getCliContext } from './context.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/cli
const MAIN_TS = join(HERE, 'main.ts');
const APP_ROOT = resolve(HERE, '../..');

// 跑真 CLI 子进程，收集退出码/stdout/stderr。退出码从 execFile 的 err.code 取（数字）。
function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, ...args], { cwd: APP_ROOT }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
}

// ── getCliContext 未初始化（进程内直调，本文件不 in-process 调 main()，currentContext 恒 null）──

// capture/stubExit helpers：复制自 output.test.ts（同步窗口内吞哨兵）。
function captureExit(fn: () => void): { out: string; err: string; codes: number[] } {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exit;
  let out = '';
  let err = '';
  const codes: number[] = [];
  const EXIT_SENTINEL = Symbol('cli-exit');
  process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err += String(chunk); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { codes.push(code ?? 0); throw EXIT_SENTINEL; }) as typeof process.exit;
  try {
    fn();
  } catch (e) {
    if (e !== EXIT_SENTINEL) throw e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return { out, err, codes };
}

test('getCliContext：context 未初始化（preAction 未跑）→ RUNTIME 退 1', () => {
  const { out, err, codes } = captureExit(() => getCliContext());
  assert.deepEqual(codes, [1]);
  assert.equal(JSON.parse(out).code, 'RUNTIME');
  assert.match(err, /CLI context not initialized/);
});

// ── version 子命令（main() 全链路：动态 import 十个命令组 + addCommand + parseAsync）──

test('version 子命令：注册全部命令组后输出 {name, version}，退 0', async () => {
  const r = await cli(['version', '--db', '/tmp/none.db', '--server', 'http://127.0.0.1:1', '--token', 't']);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.deepEqual(JSON.parse(r.out), { name: 'collector-cli', version: '0.1.0' });
});

test('全局 --format 非法值 → normalizeFormat 兜底 json（pretty JSON 输出）', async () => {
  const r = await cli(['--format', 'bogus', 'version', '--db', '/tmp/none.db', '--server', 'http://127.0.0.1:1', '--token', 't']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { name: 'collector-cli', version: '0.1.0' });
});

// ── commander 默认错误流（不走 main catch，直接退 1）──

test('未知子命令：commander 默认错误 → 退 1，stdout 无 JSON', async () => {
  const r = await cli(['no-such-cmd', '--db', '/tmp/none.db']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /error/i);
});

test('缺少必填选项：commander 默认错误 → 退 1（不进 main catch）', async () => {
  const r = await cli(['stats', 'count', '--db', '/tmp/none.db']);
  assert.equal(r.code, 1);
  assert.match(r.err, /--by/);
});

// main() catch 分支（120-128 行）由 export.cli.test.ts 的「字幕 payload 结构损坏 → convertSubtitle 抛错」
// 用例覆盖（action 内真异常穿透 parseAsync 才进 catch；emitError 的 process.exit 在真子进程里直接终结）。
