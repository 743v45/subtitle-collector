// skill 同步门禁 —— 校验 docs/skills/collector/ 里引用的 collector-cli 命令样例与 scripts/ 工具引用仍然有效。
// 设计:[2026-08-23-collector-skill-design.md §4](../docs/superpowers/specs/2026-08-23-collector-skill-design.md)。
// 两级校验(全静态、不执行真业务命令——collect 有真实副作用):
//   1. 命令路径:样例子命令链逐级比对 `tsx src/cli/main.ts <路径> --help`(commander 自描述);
//   2. 长选项拼写:样例中 --opt 与叶子级 --help 输出的选项清单比对。
// 另:markdown 中 scripts/<name>.{mjs,mts,sh,py} 引用做文件存在性检查。
// 用法:node scripts/verify-skill-sync.mjs(进 pnpm qa;对齐 quality-baseline.mjs 守门员先例)。

import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const runFile = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 校验对象:skill 正文与其引用文件(改动时同步更新此清单)。 */
export const SKILL_FILES = [
  'docs/skills/collector/SKILL.md',
  'docs/skills/collector/references/playbooks.md',
];

/** commander 全局选项(program 级,每级 help 都印):带值与 flag 分开,样例校验时跳过。 */
const GLOBAL_VALUE_OPTS = new Set(['db', 'server', 'token', 'format']);
const GLOBAL_FLAG_OPTS = new Set(['q', 'quiet', 'v', 'version', 'help']);

// ── 纯函数层(单元测试覆盖,见 verify-skill-sync.test.mjs)──

/** 从 markdown 提取 ```collector-cli 标注块内的命令样例行。
 *  跳过空行与 # 注释行;返回 [{file, line(1-based), text}]。 */
export function extractCliSamples(md, file) {
  const samples = [];
  const lines = md.split('\n');
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^```collector-cli\s*$/.test(raw.trim())) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^```\s*$/.test(raw.trim())) {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    const text = raw.trim();
    if (text === '' || text.startsWith('#')) continue;
    samples.push({ file, line: i + 1, text });
  }
  return samples;
}

/** 剥掉样例的调用前缀(collector-cli 简写 / 两种 tsx 全写形态),返回裸命令体。 */
export function stripPrefix(line) {
  const PREFIXES = [
    'collector-cli ',
    'pnpm -C apps/collector-server exec tsx src/cli/main.ts ',
    'pnpm exec tsx src/cli/main.ts ',
    'node --import tsx src/cli/main.ts ',
  ];
  for (const p of PREFIXES) {
    if (line.startsWith(p)) return line.slice(p.length);
  }
  return line;
}

/** 从 commander help 文本提取 Commands: 段的命令名(首词;跳过内置 help)。
 *  叶子命令无此段 → 空数组。 */
export function parseCommandsFromHelp(help) {
  const m = help.match(/(?:^|\n)Commands:/);
  if (!m) return [];
  const section = help.slice(m.index + m[0].length);
  const names = [];
  for (const line of section.split('\n')) {
    const first = line.trim().split(/\s+/)[0];
    if (!first || first === 'help') continue;
    names.push(first);
  }
  return names;
}

/** 从 help 文本提取长选项名(`--q`→q;`-v, --version`→version;跳过 Usage 行混入)。 */
export function parseOptionsFromHelp(help) {
  const m = help.match(/(?:^|\n)Options:/);
  if (!m) return [];
  const start = m.index + m[0].length;
  const end = help.indexOf('\nCommands:', start);
  const section = help.slice(start, end === -1 ? undefined : end);
  const names = [];
  for (const line of section.split('\n')) {
    const om = line.match(/--([a-zA-Z0-9][a-zA-Z0-9-]*)/);
    if (om) names.push(om[1]);
  }
  return names;
}

/** 第一遍:贪婪收集命令路径。
 *  规则:某级存在子命令(Commands 非空)时,其后第一个非选项 token 必须是其子命令——
 *  不是则视为拼错直接报错(样例不会写「带子命令的组」的裸调用);某级无子命令则后续皆位置参数。 */
async function resolveCmdPath(tokens, resolver, where) {
  const cmdPath = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-') && t.length > 1) {
      // 选项 token(长/短):长全局带值连值跳过,其余(全局 flag / 命令级)留给第二遍。
      if (t.startsWith('--') && GLOBAL_VALUE_OPTS.has(t.slice(2))) i++;
      continue;
    }
    const subs = await resolver.commands(cmdPath);
    if (subs.length === 0) break; // 叶子级:后面全是位置参数
    if (!subs.includes(t)) {
      return {
        cmdPath: null,
        errors: [`${where}: 未知命令「${t}」(在 ${cmdPath.join(' ') || '顶层'},有效:${subs.join('/')})`],
      };
    }
    cmdPath.push(t);
  }
  return { cmdPath, errors: [] };
}

/** 第二遍:命令级长选项与叶子级 help 比对(全局选项跳过)。 */
function checkOptions(tokens, leafOpts, cmdPath, where) {
  const errors = [];
  for (const t of tokens) {
    if (!t.startsWith('--')) continue;
    const name = t.slice(2);
    if (GLOBAL_VALUE_OPTS.has(name) || GLOBAL_FLAG_OPTS.has(name)) continue;
    if (!leafOpts.includes(name)) {
      errors.push(`${where}: 未知选项 --${name}(在 ${cmdPath.join(' ')},该级有效:${leafOpts.join('/') || '无'})`);
    }
  }
  return errors;
}

/** 校验单条样例:命令路径逐级存在 + 非全局长选项在叶子级选项清单内。
 *  resolver: { commands(path): Promise<string[]>, options(path): Promise<string[]> }(可注入 fake)。
 *  返回错误消息数组(空 = 通过)。 */
export async function validateSample(line, resolver, file, lineNo) {
  const where = `${file}:${lineNo}`;
  const tokens = stripPrefix(line.trim()).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [`${where}: 空样例`];
  const { cmdPath, errors: pathErrors } = await resolveCmdPath(tokens, resolver, where);
  if (pathErrors.length > 0) return pathErrors;
  if (cmdPath.length === 0) return [`${where}: 未解析出命令路径:${line}`];
  const leafOpts = await resolver.options(cmdPath);
  return checkOptions(tokens, leafOpts, cmdPath, where);
}

/** 提取 markdown 中 scripts/<name>.{mjs,mts,sh,py} 引用的文件名(存在性由上层检查)。 */
export function extractScriptRefs(md) {
  const refs = new Set();
  for (const m of md.matchAll(/scripts\/([a-zA-Z0-9._-]+\.(?:mjs|mts|sh|py))/g)) {
    refs.add(m[1]);
  }
  return [...refs];
}

// ── 运行时层(spawn 真 CLI help;单元测试不覆盖,qa 门跑真脚本兜底)──

/** 构造真 CLI 的 help resolver(node --import tsx 直调,绕 pnpm 参数传递;结果缓存)。 */
function makeCliResolver() {
  const cache = new Map();
  async function runHelp(path) {
    const key = path.join(' ');
    if (!cache.has(key)) {
      const { stdout } = await runFile(
        'node',
        ['--import', 'tsx', 'src/cli/main.ts', ...path, '--help'],
        { cwd: join(REPO_ROOT, 'apps/collector-server') },
      );
      cache.set(key, stdout);
    }
    return cache.get(key);
  }
  return {
    commands: async (path) => parseCommandsFromHelp(await runHelp(path)),
    options: async (path) => parseOptionsFromHelp(await runHelp(path)),
  };
}

async function main() {
  const errors = [];
  const mds = [];
  for (const rel of SKILL_FILES) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) {
      errors.push(`skill 文件缺失:${rel}(正文在 docs/skills/,symlink 在 .claude/skills/)`);
      continue;
    }
    mds.push({ rel, text: readFileSync(abs, 'utf8') });
  }

  let sampleCount = 0;
  if (mds.length > 0) {
    const resolver = makeCliResolver();
    for (const { rel, text } of mds) {
      const samples = extractCliSamples(text, rel);
      for (const s of samples) {
        errors.push(...await validateSample(s.text, resolver, s.file, s.line));
      }
      sampleCount += samples.length;
      for (const ref of extractScriptRefs(text)) {
        if (!existsSync(join(REPO_ROOT, 'scripts', ref))) {
          errors.push(`${rel}: 引用的脚本不存在:scripts/${ref}`);
        }
      }
    }
    if (sampleCount === 0) {
      errors.push('skill 文件中零 ```collector-cli 样例——校验空转,样例丢失或标注遗漏');
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`[skill-sync] ✗ ${errors.length} 处不同步:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stderr.write(`[skill-sync] ✓ ${sampleCount} 条命令样例 + scripts 引用全部有效\n`);
}

// 仅在作为入口直接执行时跑(测试 import 本模块不触发;对齐 collector-cli main.ts 先例)。
const isMain = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await main();
}
