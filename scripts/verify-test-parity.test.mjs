// verify-test-parity 单测 —— checkScript 纯函数矩阵 + CHECKS 与真实 package.json 的一致性（防配置漂移）。
// 跑法：node --test scripts/verify-test-parity.test.mjs（qa 门 node --test 段一并执行）。
//
// 测试轮次记录表：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | checkScript 命中/缺失矩阵 + 真实双 app 配置断言 | 通过 | 2026-10-07 RULES §2.1 配套 |

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScript, CHECKS } from './verify-test-parity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('checkScript：双 runner 齐全 → 零失败', () => {
  assert.deepEqual(
    checkScript('ext', 'c8 ... node --test "test/*.test.mjs" && vitest run', ['node --test', 'vitest run']),
    [],
  );
});

test('checkScript：摘掉 vitest run → 报缺失且带实测 script', () => {
  const failures = checkScript('ext', 'c8 ... node --test "test/*.test.mjs"', ['node --test', 'vitest run']);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /缺 "vitest run"/);
  assert.match(failures[0], /RULES §2\.1/);
});

test('checkScript：摘掉 node --test → 报缺失（vitest 单独存在不算完整）', () => {
  const failures = checkScript('ext', 'vitest run', ['node --test', 'vitest run']);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /缺 "node --test"/);
});

test('checkScript：串顺序无关（vitest 在前 node --test 在后同样通过）', () => {
  assert.deepEqual(
    checkScript('ext', 'vitest run && c8 node --test', ['node --test', 'vitest run']),
    [],
  );
});

test('真实配置一致性：CHECKS 指向的 package.json 当前 test script 全部满足（守门脚本自证健康）', () => {
  // 若本用例失败：要么有人动了 test script 摘 runner（正门生效,按 RULES §2.1 处理），
  // 要么改了 CHECKS 声明与实际配置脱节（同步 CHECKS 或恢复 script）。
  for (const { app, pkgPath, required } of CHECKS) {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, pkgPath), 'utf8'));
    const script = pkg.scripts?.test ?? '';
    assert.deepEqual(
      checkScript(app, script, required),
      [],
      `${app} 的 test script 应满足 ${JSON.stringify(required)}，实测: ${script}`,
    );
  }
});
