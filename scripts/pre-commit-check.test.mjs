// 覆盖 pre-commit-check.mjs 的核心筛选逻辑：后缀过滤、*.test.* 豁免、空输入、git diff-filter 参数语义。
// pre-commit 是提交链路的守门员，自身逻辑必须被测试保护（CLAUDE.md 测试质量政策）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNewSourceFiles, GIT_DIFF_ARGS } from './pre-commit-check.mjs';

test('后缀过滤：只保留 ts/tsx/mjs/js 四类源码后缀', () => {
  const out = selectNewSourceFiles([
    'apps/collector-web/src/pages/Page.tsx',
    'apps/collector-server/src/cli/cmd.ts',
    'scripts/tool.mjs',
    'apps/subtitle-collector/background.js',
    'docs/quality/RULES.md',       // 文档剔除
    'apps/collector-web/src/globals.css', // 样式剔除
    'package.json',                // 配置剔除
    'public/index.html',           // 模板剔除
  ].join('\n'));
  assert.deepEqual(out, [
    'apps/collector-web/src/pages/Page.tsx',
    'apps/collector-server/src/cli/cmd.ts',
    'scripts/tool.mjs',
    'apps/subtitle-collector/background.js',
  ]);
});

test('test 豁免：*.test.* 不进静态门（质量由覆盖率指标管）', () => {
  const out = selectNewSourceFiles([
    'apps/collector-server/src/db/queries.test.ts',
    'apps/collector-web/src/lib/x.test.tsx',
    'scripts/pre-commit-check.test.mjs',
    'src/y.test.js',
    'src/real.ts',                 // 正常源码保留
  ].join('\n'));
  assert.deepEqual(out, ['src/real.ts']);
});

test('空列表：无 staged 新增时返回空数组（纯改动/纯文档提交跳过检查）', () => {
  assert.deepEqual(selectNewSourceFiles(''), []);
  // git 输出只有换行/空白行（如尾部换行）同样视为无命中
  assert.deepEqual(selectNewSourceFiles('\n \n'), []);
});

test('diff-filter 语义：新增判定完全交给 git 参数（--cached --diff-filter=A --name-only）', () => {
  // 脚本不做 added/modified/deleted 二次推断——改动与删除文件由 git --diff-filter=A 保证不出现在输出里
  assert.ok(GIT_DIFF_ARGS.includes('--diff-filter=A'));
  assert.ok(GIT_DIFF_ARGS.includes('--cached'));
  assert.ok(GIT_DIFF_ARGS.includes('--name-only'));
});

test('mock git 输出：混合提交场景下只选中新增的非测试源码文件', () => {
  // 模拟一次「新增页面 + 新文档 + 新测试 + 已有文件改动」提交的 --diff-filter=A 输出：
  // 改动文件已被 git 过滤不会出现；剩余路径再按后缀与豁免规则筛选
  const mock = [
    'apps/collector-web/src/pages/NewPage.tsx',
    'docs/quality/RULES.md',
    'apps/collector-server/src/x.test.ts',
    'scripts/new-tool.mjs',
  ].join('\n');
  assert.deepEqual(selectNewSourceFiles(mock), [
    'apps/collector-web/src/pages/NewPage.tsx',
    'scripts/new-tool.mjs',
  ]);
});
