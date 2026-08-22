// pre-commit 静态质量守门员 —— 只检查「本次 staged 新增」的源码文件（Q8 分工：改动文件交给 qa 台账 check）。
// 规则：圈复杂度(complexity ≤15)与模块大小(max-lines ≤400)，阈值与根 eslint.config.mjs / quality-baseline.mjs 同一套。
// 用法：由 .husky/pre-commit 调起（`node scripts/pre-commit-check.mjs`），也可从仓库根手动运行。
// 测试文件 *.test.* 豁免两条静态规则（Q18）；subtitle-extractor 等范围外路径跳过（Q19 边界）。
// 输出遵循 CLAUDE.md 第 9 节可观察性纪律：每个失败项带文件/规则/实测值/阈值。

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './quality-baseline.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = { complexity: 15, maxLines: 400 };

// —— 核心逻辑（供 pre-commit-check.test.mjs 测试） ——

/** 取 staged 新增文件的 git 参数：--cached 看暂存区、--diff-filter=A 只要新增、--name-only 只出路径。 */
export const GIT_DIFF_ARGS = ['diff', '--cached', '--name-only', '--diff-filter=A'];

/** 从 git diff 输出筛选待检源码：保留后缀 ts/tsx/mjs/js，剔除 *.test.*（测试文件豁免静态门，质量由覆盖率指标管）。 */
export function selectNewSourceFiles(diffOutput) {
  return diffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
    .filter((f) => !/\.test\./.test(f));
}

// —— CLI ——
// 复用 quality-baseline.mjs 的 buildSnapshot 聚合（同文件多条 complexity 取最大值），保证两道门口径一致。

function p(line = '') { process.stdout.write(line + '\n'); }

async function main() {
  const diffOutput = execFileSync('git', GIT_DIFF_ARGS, { cwd: ROOT, encoding: 'utf8' });
  const staged = selectNewSourceFiles(diffOutput);
  if (staged.length === 0) {
    p('[pre-commit] ✓ 无新增源码文件，跳过');
    return 0;
  }

  const { ESLint } = await import('eslint');
  const eslint = new ESLint({ cwd: ROOT });

  // 范围外新增文件（subtitle-extractor/生成物/未被 eslint.config.mjs files 覆盖的路径）跳过，
  // 同时避免 staged 全是忽略路径时 lintFiles 抛「all files were ignored」。
  const inScope = [];
  for (const f of staged) {
    if (!(await eslint.isPathIgnored(resolve(ROOT, f)))) inScope.push(f);
  }
  const skipped = staged.length - inScope.length;
  if (skipped > 0) p(`[pre-commit] 跳过 ${skipped} 个不在 ESLint 检查范围的新增文件（subtitle-extractor/生成物等，Q19 边界）`);
  if (inScope.length === 0) {
    p('[pre-commit] ✓ 新增源码文件均不在检查范围，跳过');
    return 0;
  }

  const results = await eslint.lintFiles(inScope);
  const snap = buildSnapshot(results, ROOT);
  const violations = Object.entries(snap).flatMap(([file, rules]) =>
    Object.entries(rules).map(([rule, value]) => ({ file, rule, value })),
  );
  if (violations.length > 0) {
    for (const v of violations) p(`[pre-commit] ✗ ${v.file} — ${v.rule}=${v.value}（阈值 ${RULES[v.rule]}）`);
    p('[pre-commit] ✗ 新文件必须达标静态质量阈值（CLAUDE.md 测试质量政策）；拆分模块或走 --no-verify 前先读 docs/quality/RULES.md');
    return 1;
  }
  p(`[pre-commit] ✓ 新增文件 ${inScope.length} 个全部达标`);
  return 0;
}

// 仅直接运行时执行 CLI（被测试 import 时不执行）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { console.error('[pre-commit] 运行失败：', e); process.exit(1); });
}
