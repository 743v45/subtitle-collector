// 静态质量基线台账 —— 圈复杂度(complexity ≤15)与模块大小(max-lines ≤400)两条规则的「只许变好」守门员。
// 用法：
//   node scripts/quality-baseline.mjs check               对比 ESLint 现状快照与 docs/quality/baseline.json（恶化/新增超标即 exit 1）
//   node scripts/quality-baseline.mjs check --allow-degrade  显式豁免变差项（必须在 commit message 注明豁免原因）
//   node scripts/quality-baseline.mjs update [--write]     默认 dry-run 打印完整 diff；--write 才落盘刷新台账
// 细则见 docs/quality/RULES.md。输出遵循 CLAUDE.md 第 9 节可观察性纪律：每项带文件/规则/旧值→新值。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = resolve(ROOT, 'docs/quality/baseline.json');
const RULES = { complexity: 15, maxLines: 400 };

// —— 核心逻辑（供 quality-baseline.test.mjs 测试） ——

/** 从 ESLint Node API 的 lint 结果聚合成快照：{ file: { complexity?: number, maxLines?: number } }（复杂度取文件内最大值） */
export function buildSnapshot(eslintResults, cwd) {
  const snap = {};
  for (const f of eslintResults) {
    for (const m of f.messages || []) {
      if (m.fatal) continue;
      const cx = m.ruleId === 'complexity' ? /complexity of (\d+)/.exec(m.message) : null;
      const ml = m.ruleId === 'max-lines' ? /too many lines \((\d+)\)/.exec(m.message) : null;
      if (!cx && !ml) continue;
      const rel = f.filePath.replace(cwd + '/', '');
      snap[rel] = snap[rel] || {};
      if (cx) snap[rel].complexity = Math.max(snap[rel].complexity || 0, +cx[1]);
      if (ml) snap[rel].maxLines = Math.max(snap[rel].maxLines || 0, +ml[1]);
    }
  }
  return snap;
}

/** 对比现状快照与台账，产出四类清单。added/worsened 是失败项（--allow-degrade 时放行）。 */
export function diffBaseline(current, baselineFiles) {
  const added = [];    // 台账外的新超标（file × rule）
  const worsened = []; // 台账内数值上升
  const improved = []; // 台账内数值下降（提示固化，不失败）
  const removed = [];  // 台账内文件已达标/消失（提示固化，不失败）
  for (const [file, cur] of Object.entries(current)) {
    const base = baselineFiles[file];
    if (!base) {
      for (const rule of Object.keys(cur)) added.push({ file, rule, value: cur[rule] });
      continue;
    }
    for (const [rule, v] of Object.entries(cur)) {
      const b = base[rule];
      if (b === undefined) added.push({ file, rule, value: v });
      else if (v > b) worsened.push({ file, rule, from: b, to: v });
      else if (v < b) improved.push({ file, rule, from: b, to: v });
    }
    for (const rule of Object.keys(base)) {
      if (cur[rule] === undefined) improved.push({ file, rule, from: base[rule], to: '达标' });
    }
  }
  for (const file of Object.keys(baselineFiles)) {
    if (!current[file]) removed.push(file);
  }
  return { added, worsened, improved, removed };
}

// —— CLI ——

async function runEslintSnapshot() {
  const { ESLint } = await import('eslint');
  const eslint = new ESLint({ cwd: ROOT });
  const results = await eslint.lintFiles(['.']);
  return buildSnapshot(results, ROOT);
}

function p(line = '') { process.stdout.write(line + '\n'); }

// update 子命令：刷新台账（默认 dry-run，--write 落盘）
async function runUpdate(write) {
  const current = await runEslintSnapshot();
  let baselineFiles = {};
  try {
    baselineFiles = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files;
  } catch { /* 首版台账 */ }
  const d = diffBaseline(current, baselineFiles);
  p('[baseline] update（dry-run，加 --write 落盘）');
  p(`  新增超标 ${d.added.length} 项 / 恶化 ${d.worsened.length} 项 / 改善 ${d.improved.length} 项 / 达标消失 ${d.removed.length} 个文件`);
  for (const x of [...d.added, ...d.worsened, ...d.improved]) p(`  ${x.file} ${x.rule}: ${x.from ?? '—'} → ${x.to ?? x.value}`);
  for (const f of d.removed) p(`  ${f}: 已全部达标，从台账移除`);
  if (!write) { p('[baseline] 未写盘（dry-run）'); return; }
  const payload = { generatedAt: new Date().toISOString(), rules: RULES, files: current };
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
  p(`[baseline] 已写入 ${BASELINE_PATH}（${Object.keys(current).length} 个超标文件）`);
}

// check 子命令：对比现状与台账，新增/恶化即失败（--allow-degrade 豁免）
async function runCheck(allowDegrade) {
  let baselineFiles = {};
  try {
    baselineFiles = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files;
  } catch {
    p('[baseline] 台账缺失（docs/quality/baseline.json）——先跑 `node scripts/quality-baseline.mjs update --write` 生成');
    process.exit(1);
  }
  const current = await runEslintSnapshot();
  const d = diffBaseline(current, baselineFiles);
  p(`[baseline] check：超标文件现状 ${Object.keys(current).length} / 台账 ${Object.keys(baselineFiles).length}`);
  let fail = false;
  if (d.added.length) {
    fail = true;
    p(`[baseline] ✗ 新增超标 ${d.added.length} 项（台账外）：`);
    for (const x of d.added) p(`    ${x.file} — ${x.rule}=${x.value}（阈值 ${RULES[x.rule]}）`);
  }
  if (d.worsened.length) {
    fail = true;
    p(`[baseline] ✗ 数值恶化 ${d.worsened.length} 项：`);
    for (const x of d.worsened) p(`    ${x.file} — ${x.rule}: ${x.from} → ${x.to}（阈值 ${RULES[x.rule]}）`);
  }
  if (d.improved.length) {
    p(`[baseline] ✓ 改善 ${d.improved.length} 项（可跑 update --write 固化）：`);
    for (const x of d.improved) p(`    ${x.file} — ${x.rule}: ${x.from} → ${x.to}`);
  }
  if (d.removed.length) {
    p(`[baseline] ✓ 已达标/消失 ${d.removed.length} 个文件（可跑 update --write 固化）`);
    for (const f of d.removed) p(`    ${f}`);
  }
  if (fail && allowDegrade) {
    p('[baseline] ⚠ --allow-degrade 已豁免上述变差项——请在 commit message 注明豁免原因（CLAUDE.md 测试质量政策）');
    fail = false;
  }
  p(fail ? '[baseline] ✗ FAIL：存在变差，偿还或走 --allow-degrade 豁免通道' : '[baseline] ✓ PASS');
  process.exit(fail ? 1 : 0);
}

async function main() {
  const mode = process.argv[2];
  const allowDegrade = process.argv.includes('--allow-degrade');
  const write = process.argv.includes('--write');
  if (mode === 'update') return runUpdate(write);
  return runCheck(allowDegrade);
}

// 仅直接运行时执行 CLI（被测试 import 时不执行）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('[baseline] 运行失败：', e); process.exit(1); });
}
