// 文档同步门禁(verify-docs-sync)——拦文档漂移:C1 改善(台账入口指针/AI 接手页/版本活断言/备份常数复述)。
// 全静态读文件,零子进程、零新依赖;结构与「纯函数层 + 运行时层」拆分对齐 verify-skill-sync.mjs 先例。
// 四条断言:
//   A 入口指针:CLAUDE.md / README.md / docs/help/INDEX.md 各含「improvement-backlog-2026-10」与「AI-接手」引用。
//   B 链接存在:docs/help/AI-接手.md 存在;INDEX.md「其他文档」表内仓库相对链接全部存在。
//   C 版本活断言:扫描范围内不得出现「当前…0.x.y」式活断言(版本以 manifest.json 为准,文档不复述);
//     提取版本 ≠ apps/subtitle-collector/manifest.json 的 version 即 fail。
//   D 备份常数复述:备份参数单源在 apps/collector-server/src/db/backup.ts,他处出现常数组合(15min/15 分钟
//     与「8 份」共现,或「每日末份」与「14 天」共现)即 fail。
// 扫描范围:C/D 均为 docs/**/*.md + 仓库根 *.md(白名单见 WHITELIST_PREFIXES / VERSION_CLAIM_WHITELIST)。
// 用法:node scripts/verify-docs-sync.mjs(进 pnpm qa;单测见 verify-docs-sync.test.mjs)。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_REL = 'apps/subtitle-collector/manifest.json';
const INDEX_REL = 'docs/help/INDEX.md';
const AI_HANDOVER_REL = 'docs/help/AI-接手.md';

/** 断言 A 的三个入口文件与其必须包含的标记。 */
export const ENTRY_FILES = ['CLAUDE.md', 'README.md', 'docs/help/INDEX.md'];
export const REQUIRED_MARKERS = ['improvement-backlog-2026-10', 'AI-接手'];

/** 断言 C/D 的扫描白名单(相对仓库根;前缀匹配):变更史/历史归档/ douyin 过程记录/账本自身引用现状合法。 */
export const WHITELIST_PREFIXES = [
  'CHANGELOG.md',
  'docs/superpowers/',
  'docs/plans/douyin/',
  'docs/plans/improvement-backlog-2026-10.md',
];
/** 断言 D 额外白名单:参数单源与其测试(账本引用现状合法,已含于上方)。 */
export const BACKUP_CONSTANT_WHITELIST = [
  'apps/collector-server/src/db/backup.ts',
  'apps/collector-server/src/db/backup.test.ts',
];

// ── 纯函数层(单元测试覆盖,见 verify-docs-sync.test.mjs)──

/** 断言 A:每个入口文件须含全部标记。files: [{path, text}]。返回错误消息数组(空 = 通过)。 */
export function checkEntryPointers(files) {
  const errors = [];
  for (const entry of ENTRY_FILES) {
    const f = files.find((x) => x.path === entry);
    if (!f) {
      errors.push(`断言A: 入口文件缺失:${entry}`);
      continue;
    }
    for (const marker of REQUIRED_MARKERS) {
      if (!f.text.includes(marker)) {
        errors.push(`断言A: ${entry} 缺「${marker}」引用(入口指针漂移)`);
      }
    }
  }
  return errors;
}

/** 断言 B 前半:解析 INDEX.md「其他文档」节(至下一个同级 ## 标题或文末)表格内的 markdown 链接,
 *  返回 href 数组。跳过外链(http/https)与纯锚点;解析不了的行自然无 href,等价跳过。 */
export function parseIndexTableLinks(md) {
  const marker = '## 本仓库其他文档';
  const start = md.indexOf(marker);
  if (start === -1) return [];
  const rest = md.slice(start + marker.length);
  const nextH2 = rest.search(/\n## /);
  const section = nextH2 === -1 ? rest : rest.slice(0, nextH2);
  const hrefs = [];
  for (const m of section.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^https?:\/\//.test(href) || href.startsWith('#')) continue;
    hrefs.push(href);
  }
  return hrefs;
}

/** 断言 B 后半(纯函数):校验 INDEX.md 表内相对链接指向的仓库文件存在。
 *  hrefs: parseIndexTableLinks 的输出;indexDir: INDEX.md 所在目录绝对路径;
 *  root: 仓库根绝对路径(拦越出仓库的链接)。 */
export function checkLinkTargets(hrefs, indexDir, root) {
  const errors = [];
  if (hrefs.length === 0) {
    errors.push('断言B: INDEX.md「其他文档」表零链接可解析——表格丢失或结构改动');
  }
  for (const href of hrefs) {
    const target = resolve(indexDir, decodeURIComponent(href));
    if (!target.startsWith(root)) {
      errors.push(`断言B: INDEX.md 链接越出仓库:${href}`);
      continue;
    }
    if (!existsSync(target)) {
      errors.push(`断言B: INDEX.md「其他文档」表链接不存在:${href}`);
    }
  }
  return errors;
}

/** 断言 B 汇总(运行时):读 INDEX.md → 解析表内链接 → 校验目标存在。 */
export function checkIndexLinks(indexDir, root) {
  const md = readFileSync(join(indexDir, 'INDEX.md'), 'utf8');
  return checkLinkTargets(parseIndexTableLinks(md), indexDir, root);
}

/** 断言 C:逐行找「当前…0.x.y」式活断言(「当前」后 24 字符窗口内的 0.x.y 语义版本),
 *  版本 ≠ currentVersion 即报 file:line。返回错误消息数组(空 = 通过)。 */
export function checkActiveVersionClaims(text, file, currentVersion) {
  const errors = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/当前[^。\n]{0,24}?(0\.\d+\.\d+)/);
    if (!m) continue;
    if (m[1] !== currentVersion) {
      errors.push(`断言C: ${file}:${i + 1} 版本活断言「当前…${m[1]}」≠ manifest ${currentVersion}(版本以 manifest.json 为准,文档不复述)`);
    }
  }
  return errors;
}

/** 断言 D:逐行查备份常数复述组合——(「15min」或「15 分钟」∧「8 份」)或(「每日末份」∧「14 天」)。
 *  参数单源是 backup.ts,他处复述数字必漂移。返回错误消息数组(空 = 通过)。 */
export function findBackupConstantCoOccurrences(text, file) {
  const errors = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const combos = [];
    if (/(15min|15 分钟)/.test(line) && line.includes('8 份')) combos.push('15min ∧ 8 份');
    if (line.includes('每日末份') && line.includes('14 天')) combos.push('每日末份 ∧ 14 天');
    for (const c of combos) {
      errors.push(`断言D: ${file}:${i + 1} 备份常数复述(${c})——参数单源见 apps/collector-server/src/db/backup.ts,文档不复述数字`);
    }
  }
  return errors;
}

/** 白名单判定(纯函数):断言 C/D 扫描时跳过的仓库相对路径。 */
export function isWhitelisted(rel) {
  if (BACKUP_CONSTANT_WHITELIST.includes(rel)) return true;
  return WHITELIST_PREFIXES.some((p) => rel === p || rel.startsWith(p));
}

// ── 运行时层(文件遍历;单元测试不覆盖,qa 门跑真脚本兜底)──

/** 收集扫描范围:仓库根 *.md + docs/ 下递归全部 *.md(相对路径,posix 斜杠)。 */
function collectScanFiles(root) {
  const rels = [];
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    if (statSync(abs).isFile() && name.endsWith('.md')) rels.push(name);
  }
  const docsDir = join(root, 'docs');
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs, `${prefix}${name}/`);
      } else if (name.endsWith('.md')) {
        rels.push(`docs/${prefix}${name}`);
      }
    }
  };
  walk(docsDir, '');
  return rels;
}

async function main() {
  const errors = [];
  const stats = {};

  // 断言 A:三入口指针
  const entryFiles = ENTRY_FILES.map((rel) => ({
    path: rel,
    text: readFileSync(join(REPO_ROOT, rel), 'utf8'),
  }));
  const aErrors = checkEntryPointers(entryFiles);
  errors.push(...aErrors);
  stats.A = `${ENTRY_FILES.length} 个入口 × ${REQUIRED_MARKERS.length} 标记`;

  // 断言 B:AI 接手页存在 + INDEX 表链接存在
  if (!existsSync(join(REPO_ROOT, AI_HANDOVER_REL))) {
    errors.push(`断言B: ${AI_HANDOVER_REL} 不存在(AI 接手页丢失)`);
  }
  const indexDir = join(REPO_ROOT, dirname(INDEX_REL));
  const bErrors = checkIndexLinks(indexDir, REPO_ROOT);
  errors.push(...bErrors);

  // 断言 C/D:全量扫描(白名单豁免)
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, MANIFEST_REL), 'utf8'));
  const currentVersion = manifest.version;
  const rels = collectScanFiles(REPO_ROOT).filter((rel) => !isWhitelisted(rel));
  let cCount = 0;
  let dCount = 0;
  for (const rel of rels) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const c = checkActiveVersionClaims(text, rel, currentVersion);
    const d = findBackupConstantCoOccurrences(text, rel);
    errors.push(...c, ...d);
    cCount += c.length;
    dCount += d.length;
  }
  stats.C = `${rels.length} 个 md 文件比对 manifest ${currentVersion}`;
  stats.D = `${rels.length} 个 md 文件查备份常数共现`;

  if (errors.length > 0) {
    process.stderr.write(`[docs-sync] ✗ ${errors.length} 处文档漂移:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `[docs-sync] ✓ 断言A(${stats.A})/断言B(AI-接手 + INDEX 表链接)/断言C(${stats.C},命中 ${cCount})/断言D(${stats.D},命中 ${dCount})全过\n`,
  );
}

// 仅在作为入口直接执行时跑(测试 import 本模块不触发;对齐 verify-skill-sync.mjs 先例)。
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  await main();
}
