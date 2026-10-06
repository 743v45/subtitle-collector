// verify-docs-sync.mjs 的单元测试 —— 守门员自身必须被测试保护(对齐 verify-skill-sync.test.mjs 先例)。
// 覆盖范围:断言 A 入口指针 / 断言 B 链接解析与存在性 / 断言 C 版本活断言 / 断言 D 备份常数共现 / 白名单。
// main() 的端到端(真仓库遍历)不在此测——由 qa 门跑真脚本兜底,单元层用临时目录 fixture。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENTRY_FILES,
  REQUIRED_MARKERS,
  checkEntryPointers,
  parseIndexTableLinks,
  checkLinkTargets,
  checkActiveVersionClaims,
  findBackupConstantCoOccurrences,
  isWhitelisted,
} from './verify-docs-sync.mjs';

/** 建一次性临时目录 fixture(每测试独立,避免互相污染)。 */
function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'docs-sync-test-'));
}

// ── 组:断言 A(入口指针)──

test('checkEntryPointers:三入口各含两标记时全过(空错误数组)', () => {
  const files = ENTRY_FILES.map((path) => ({ path, text: `见 [账本](docs/plans/improvement-backlog-2026-10.md) 与 [AI-接手](docs/help/AI-接手.md)` }));
  assert.deepEqual(checkEntryPointers(files), []);
});

test('checkEntryPointers:缺一个标记即报断言A并指明文件与标记名', () => {
  const files = ENTRY_FILES.map((path) => ({ path, text: 'improvement-backlog-2026-10' }));
  const errors = checkEntryPointers(files);
  assert.equal(errors.length, ENTRY_FILES.length);
  for (const e of errors) {
    assert.match(e, /^断言A:/);
    assert.match(e, /AI-接手/);
  }
});

test('checkEntryPointers:入口文件整体缺失时报「入口文件缺失」', () => {
  const errors = checkEntryPointers([{ path: 'README.md', text: 'improvement-backlog-2026-10 AI-接手' }]);
  // CLAUDE.md 与 docs/help/INDEX.md 两个入口缺失,各报一条
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /^断言A: 入口文件缺失:CLAUDE\.md$/.test(e)));
  assert.ok(errors.some((e) => /^断言A: 入口文件缺失:docs\/help\/INDEX\.md$/.test(e)));
});

test('REQUIRED_MARKERS:两标记齐全(账本 + AI 接手页),防漏配', () => {
  assert.deepEqual([...REQUIRED_MARKERS].sort(), ['AI-接手', 'improvement-backlog-2026-10']);
});

// ── 组:断言 B(INDEX 表链接)──

test('parseIndexTableLinks:提取「其他文档」节表格内链接,跳过外链与锚点', () => {
  const md = [
    '# 目录',
    '## 上手',
    '- [[开始使用]]',
    '## 本仓库其他文档(各管一件事)',
    '| 文档 | 管什么 |',
    '|---|---|',
    '| [README](../../README.md) | 需求锚点 |',
    '| [外站](https://example.com/x.md) | 外链跳过 |',
    '| [锚点](#section) | 锚点跳过 |',
    '',
    '## 再后面的小节',
    '- [节外链接](../elsewhere.md)——不在「其他文档」节,不提取',
  ].join('\n');
  assert.deepEqual(parseIndexTableLinks(md), ['../../README.md']);
});

test('parseIndexTableLinks:无「其他文档」节返回空数组(上层据此报错)', () => {
  assert.deepEqual(parseIndexTableLinks('# 只有标题'), []);
});

test('checkLinkTargets:临时目录内相对链接存在即过,不存在即报断言B', () => {
  const root = makeTempRoot();
  mkdirSync(join(root, 'docs', 'help'), { recursive: true });
  writeFileSync(join(root, 'docs', 'help', 'target.md'), 'x');
  // 存在的链接:过
  assert.deepEqual(checkLinkTargets(['target.md'], join(root, 'docs', 'help'), root), []);
  // 不存在的链接:报
  const errors = checkLinkTargets(['missing.md'], join(root, 'docs', 'help'), root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^断言B: INDEX\.md「其他文档」表链接不存在:missing\.md$/);
});

test('checkLinkTargets:链接越出仓库根报「越出仓库」', () => {
  const root = makeTempRoot();
  // docs/help 在仓库根下两层,../../../ 才会越出根
  const errors = checkLinkTargets(['../../../outside.md'], join(root, 'docs', 'help'), root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /断言B: INDEX\.md 链接越出仓库/);
});

test('checkLinkTargets:空 href 列表报「零链接可解析」(表结构漂移防线)', () => {
  const errors = checkLinkTargets([], '/tmp', '/tmp');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /零链接可解析/);
});

// ── 组:断言 C(版本活断言)──

test('checkActiveVersionClaims:「当前 0.1.30」且 ≠ manifest 版本时报断言C并带 file:line', () => {
  const errors = checkActiveVersionClaims('重测待约（当前 0.1.30），需真机配合', 'docs/x.md', '0.1.31');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^断言C: docs\/x\.md:1 版本活断言「当前…0\.1\.30」≠ manifest 0\.1\.31/);
});

test('checkActiveVersionClaims:「当前 manifest 已 0.1.30」同款被拦(「已」在窗口内)', () => {
  const errors = checkActiveVersionClaims('版本感知派发(当前 manifest 已 0.1.30,待重测)', 'a.md', '0.1.31');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /0\.1\.30/);
});

test('checkActiveVersionClaims:版本与 manifest 一致时不报(允许等值陈述)', () => {
  assert.deepEqual(checkActiveVersionClaims('当前 0.1.31', 'a.md', '0.1.31'), []);
});

test('checkActiveVersionClaims:无「当前」框定的版本号不拦(历史记录/区间合法)', () => {
  const text = ['manifest 0.1.23→0.1.24', '扩展需刷新到 0.1.26', '等 0.1.28 改口径', '扩展 0.1.28 起识别终态'].join('\n');
  assert.deepEqual(checkActiveVersionClaims(text, 'a.md', '0.1.31'), []);
});

test('checkActiveVersionClaims:「当前」后窗口外(>24 字符)的版本号不拦(防误伤)', () => {
  const long = `当前 ${'很长的铺垫'.repeat(6)} 0.1.30`;
  assert.ok(long.length > 24);
  assert.deepEqual(checkActiveVersionClaims(long, 'a.md', '0.1.31'), []);
});

test('checkActiveVersionClaims:逐行计数(第 2 行命中报 :2)', () => {
  const errors = checkActiveVersionClaims('干净行\n当前 0.1.29', 'a.md', '0.1.31');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /a\.md:2/);
});

// ── 组:断言 D(备份常数共现)──

test('findBackupConstantCoOccurrences:「15min」∧「8 份」同行即报断言D', () => {
  const errors = findBackupConstantCoOccurrences('每 15min 备份,保留最近 8 份', 'a.md');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^断言D: a\.md:1 备份常数复述\(15min ∧ 8 份\)/);
});

test('findBackupConstantCoOccurrences:「15 分钟」形态同样命中', () => {
  const errors = findBackupConstantCoOccurrences('每 15 分钟容器内 VACUUM INTO,最近 8 份', 'a.md');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /15min ∧ 8 份/);
});

test('findBackupConstantCoOccurrences:「每日末份」∧「14 天」共现即报', () => {
  const errors = findBackupConstantCoOccurrences('每日末份保 14 天', 'a.md');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /每日末份 ∧ 14 天/);
});

test('findBackupConstantCoOccurrences:两组合同行各报一条', () => {
  const errors = findBackupConstantCoOccurrences('15min 8 份 每日末份 14 天', 'a.md');
  assert.equal(errors.length, 2);
});

test('findBackupConstantCoOccurrences:单项出现不共现不报(单值不算复述组合)', () => {
  const text = ['每 15min 备份一次', '保留 8 份快照', '每日末份另存', '灾备保 14 天'].join('\n');
  assert.deepEqual(findBackupConstantCoOccurrences(text, 'a.md'), []);
});

test('findBackupConstantCoOccurrences:逐行计数(第 3 行命中报 :3)', () => {
  const errors = findBackupConstantCoOccurrences('一\n二\n三:15min 与 8 份', 'a.md');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /a\.md:3/);
});

// ── 组:白名单 ──

test('isWhitelisted:CHANGELOG/docs/superpowers/douyin/账本/backup.ts 均豁免', () => {
  for (const rel of [
    'CHANGELOG.md',
    'docs/superpowers/specs/2026-06-20-design.md',
    'docs/plans/douyin/spike-findings.md',
    'docs/plans/improvement-backlog-2026-10.md',
    'apps/collector-server/src/db/backup.ts',
    'apps/collector-server/src/db/backup.test.ts',
  ]) {
    assert.equal(isWhitelisted(rel), true, rel);
  }
});

test('isWhitelisted:普通 docs 与根 README 不豁免(前缀不误放行)', () => {
  for (const rel of ['README.md', 'docs/help/排错.md', 'docs/platform-onboarding.md']) {
    assert.equal(isWhitelisted(rel), false, rel);
  }
});
