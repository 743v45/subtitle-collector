// db.ts 共用 openDbOrEmit 的显式 --server 静默警告测试：子进程跑真 CLI（同 main.test.ts 的子进程方式）。
// 背景（2026-10-02 消费端闭环 P0 定案）：videos/sub/export/stats/changes 五组只读 --db，全局 --server
// 被静默忽略，已两次造成「以为查了生产实际查了 dev 库」——现在显式给 --server 时 stderr 一行警告指路快照脚本。
// 注意：警告不受 -q 抑制（恰恰要打扰错误姿势的调用方），见「-q 仍告警」用例。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 五组显式 --server 全告警 + 未给不告警 + env 不告警 + -q 仍告警 + 非 DB-only 命令不告警 | 通过 | |
// | R2 | 子进程 env 注入 NODE_V8_COVERAGE 隔离报告（tsx 转译子进程覆盖条目混入 c8 合并会把全量覆盖率 99.5%→72% 打崩门线） | 通过 | 2026-10-02 |
// | R3 | DB-only 命令组不打「未指定 --server」缺省防呆提示（与忽略警告互斥，main.ts DB_ONLY_GROUPS） | 通过 | 2026-10-02 CLI 完整度批次 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/cli
const MAIN_TS = join(HERE, 'main.ts');
const APP_ROOT = resolve(HERE, '../..');

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve_) => {
    execFile(
      'node',
      ['--import', 'tsx', MAIN_TS, ...args],
      {
        cwd: APP_ROOT,
        env: {
          ...process.env,
          ...env,
          // 子进程 V8 报告指到 c8 temp 之外(2026-10-02 实验):CLI 子进程经 tsx 转译的覆盖条目
          // 混进 c8 合并会把全量覆盖率从 99.5% 打崩到 72%(门 98% 直接红)——本文件子进程全部
          // NO_DB 早退无有效覆盖可贡献,隔离出去不影响口径。同构的 main.test.ts 子进程走完整
          // 成功路径(自然退出、报告完整),实测不踩此坑。
          NODE_V8_COVERAGE: join(tmpdir(), 'cli-db-warn-child-v8'),
        },
      },
      (err, stdout, stderr) => {
        const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
        resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
      },
    );
  });
}

// 统一用不存在的 DB（退 4 DB_UNREADABLE）：警告在 openDbOrEmit 开库前输出，无需真实样本库。
const NO_DB = join(tmpdir(), 'cli-db-warn-no-such.db');
const SERVER = 'http://127.0.0.1:1';
const WARN = /警告: 该命令只读本地 --db，--server 已忽略/;

test('五个 DB-only 命令组显式 --server 全部告警（共用 openDbOrEmit 一处生效）', async () => {
  const groups = [
    ['videos', 'list'],
    ['sub', 'search', '关键词'],
    ['export', 'videos'],
    ['stats', 'overview'],
    ['changes', 'list'],
  ];
  for (const g of groups) {
    const r = await cli([...g, '--db', NO_DB, '--server', SERVER, '--token', 't']);
    assert.equal(r.code, 4, `${g.join(' ')} 应退 4`);
    assert.match(r.err, WARN, `${g.join(' ')} stderr 应含忽略警告`);
    assert.match(r.err, /export-bundle\.mjs 或 scripts\/backup-export\.mjs/, '警告应指路快照脚本');
  }
});

test('未显式给 --server（默认值路径）→ 不告警', async () => {
  const r = await cli(['videos', 'list', '--db', NO_DB]);
  assert.equal(r.code, 4);
  assert.doesNotMatch(r.err, WARN);
});

test('env COLLECTOR_SERVER 不算显式 --server → 不告警', async () => {
  const r = await cli(['videos', 'list', '--db', NO_DB], { COLLECTOR_SERVER: SERVER });
  assert.equal(r.code, 4);
  assert.doesNotMatch(r.err, WARN);
});

test('-q 不抑制该警告（安全互锁，恰要打扰错误姿势），但 stdout JSON 错误体照常', async () => {
  const r = await cli(['-q', 'videos', 'list', '--db', NO_DB, '--server', SERVER]);
  assert.equal(r.code, 4);
  assert.match(r.err, WARN);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
});

test('非 DB-only 命令（version，不落 DB）显式 --server → 不告警', async () => {
  const r = await cli(['version', '--db', NO_DB, '--server', SERVER, '--token', 't']);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.err, WARN);
});

test('DB-only 命令组不打「未指定 --server」缺省防呆提示（两组警告互斥：提示指路加 --server，忽略警告警告已加）', async () => {
  // 本组 CLI 子进程全走 NO_DB 早退（exit 4），沿用本文件 R2 的 NODE_V8_COVERAGE 隔离 env，不踩覆盖合并坑
  const r = await cli(['stats', 'overview', '--db', NO_DB]);
  assert.equal(r.code, 4);
  assert.doesNotMatch(r.err, /未指定 --server/);
});
