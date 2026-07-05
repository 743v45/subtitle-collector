// config 测试：默认 db 路径解析。
// 回归 bug：旧 DEFAULT_DB_PATH 是相对路径 './apps/collector-server/...'，在 `pnpm cli`
// （pnpm -C apps/collector-server exec，cwd 被切到 app 内）下错位 → DB_UNREADABLE。
// 对齐全局 8.2「测试轮次记录表」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { resolveConfig } from './config.js';

// ── 测试轮次记录表（对齐全局 8.2）──
// | 轮次 | 范围 | 结果 | 备注 |
// | R1   | 默认 dbPath 绝对解析 + cwd 无关 + 可覆盖 | 待填 | 回归 pnpm cli 下相对路径错位 bug |

test('resolveConfig 默认 dbPath 为绝对路径，指向 apps/collector-server/bilibili-collector.db', () => {
  const cfg = resolveConfig();
  assert.ok(cfg.dbPath.startsWith('/'), `dbPath 应为绝对路径: ${cfg.dbPath}`);
  assert.ok(
    cfg.dbPath.endsWith(join('apps', 'collector-server', 'bilibili-collector.db')),
    `dbPath 应指向 apps/collector-server/bilibili-collector.db: ${cfg.dbPath}`,
  );
});

test('resolveConfig 默认 dbPath 不随 cwd 变化（pnpm -C 切目录不影响）', () => {
  const cwd = process.cwd();
  const before = resolveConfig().dbPath;
  try {
    process.chdir('/tmp');
    const after = resolveConfig().dbPath;
    assert.equal(after, before, `cwd 切换后 dbPath 不应变: before=${before} after=${after}`);
  } finally {
    process.chdir(cwd);
  }
});

test('resolveConfig 显式 --db 仍可覆盖默认', () => {
  assert.equal(resolveConfig({ db: '/tmp/x.db' }).dbPath, '/tmp/x.db');
});
