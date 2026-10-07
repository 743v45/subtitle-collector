// verify-test-parity —— 双 runner 并存守门（RULES §2.1 第 5 条，2026-10-07 弹幕卡形态快照落地配套）。
// 背景：扩展 popup 形态锁定靠 test script 里的 vitest run 段（c8 node --test 管运行时模块口径，
// vitest 管组件 tsx 形态快照）；任一 runner 被人从 test script 摘掉，对应口径的测试就静默退出 qa 门。
// 本脚本断言双 runner 串都在，摘除即 exit 1（qa 红）。
// 用法：进 qa 门（根 package.json qa script 尾段），也可手动 node scripts/verify-test-parity.mjs。
// 输出遵循 CLAUDE.md §9 可观察性：每个失败项带 app / 实测 script / 缺失 runner。

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 供 verify-test-parity.test.mjs 注入测试的纯检查函数（script 文本 → 失败清单）
export function checkScript(app, script, required) {
  const failures = [];
  for (const runner of required) {
    if (!script.includes(runner)) {
      failures.push(`[test-parity] ✗ ${app}: test script 缺 "${runner}"（实测: ${script}）——RULES §2.1 双 runner 口径被破坏`);
    }
  }
  return failures;
}

export const CHECKS = [
  {
    app: 'subtitle-collector',
    pkgPath: 'apps/subtitle-collector/package.json',
    // 扩展：c8 node --test（运行时模块）与 vitest run（popup 组件形态快照）必须同时串在 test 里
    required: ['node --test', 'vitest run'],
  },
  {
    app: 'collector-web',
    pkgPath: 'apps/collector-web/package.json',
    // web：vitest 是唯一 runner（coverage 锁定在 thresholds），防被换成裸命令绕过阈值
    required: ['vitest run'],
  },
];

function main() {
  const failures = [];
  for (const { app, pkgPath, required } of CHECKS) {
    let script = '';
    try {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, pkgPath), 'utf8'));
      script = pkg.scripts?.test ?? '';
      if (script === '') {
        failures.push(`[test-parity] ✗ ${app}: ${pkgPath} 无 test script`);
        continue;
      }
    } catch (e) {
      failures.push(`[test-parity] ✗ ${app}: 读不到 ${pkgPath}（${e.message}）`);
      continue;
    }
    failures.push(...checkScript(app, script, required));
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    console.error('[test-parity] ✗ FAIL：双 runner 并存被破坏，修复 test script 或走 allow-degrade 通道（commit 注明原因）');
    return 1;
  }
  console.log(`[test-parity] ✓ ${CHECKS.length} app 测试口径完整（扩展双 runner：node --test + vitest run；web：vitest run）`);
  return 0;
}

process.exit(main());
