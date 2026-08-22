// verify-skill-sync.mjs 的单元测试 —— 守门员自身必须被测试保护(CLAUDE.md 测试质量政策,
// 对齐 quality-baseline.test.mjs / pre-commit-check.test.mjs 先例)。
// 覆盖范围:样例提取、前缀剥离、help 文本解析(命令名/选项名)、样例校验、scripts 引用提取。
// main() 的端到端(spawn tsx 拿真 help)不在此测——由 qa 门跑真脚本兜底,单元层注入 fake resolver。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCliSamples,
  stripPrefix,
  parseCommandsFromHelp,
  parseOptionsFromHelp,
  validateSample,
  extractScriptRefs,
} from './verify-skill-sync.mjs';

// ── 组:markdown 样例提取 ──

test('extractCliSamples:提取 ```collector-cli 块内的命令行,忽略注释与空行', () => {
  // 前置:skill 正文用 ```collector-cli 标注可校验样例;# 注释与空行不是命令。
  const md = [
    '# 标题',
    '',
    '```collector-cli',
    '# 查最近 20 条',
    'collector-cli videos list --limit 20',
    '',
    'collector-cli stats overview',
    '```',
    '',
    '```bash',
    'collector-cli videos list --limit 20',
    '```',
  ].join('\n');
  const samples = extractCliSamples(md, 'SKILL.md');
  // 断言:bash 块不收;注释/空行跳过;行号从 1 计。
  assert.deepEqual(
    samples.map((s) => s.text),
    ['collector-cli videos list --limit 20', 'collector-cli stats overview'],
  );
  assert.equal(samples[0].file, 'SKILL.md');
  assert.equal(samples[0].line, 5);
});

test('extractCliSamples:无标注块返回空数组(上层据此报「样例为零」)', () => {
  assert.deepEqual(extractCliSamples('没有代码块的正文', 'a.md'), []);
});

// ── 组:前缀剥离 ──

test('stripPrefix:剥掉 collector-cli 简写前缀', () => {
  assert.equal(stripPrefix('collector-cli videos list --limit 5'), 'videos list --limit 5');
});

test('stripPrefix:剥掉 pnpm -C exec tsx 全写前缀(设计文档 §9 调用形态)', () => {
  const line = 'pnpm -C apps/collector-server exec tsx src/cli/main.ts videos list';
  assert.equal(stripPrefix(line), 'videos list');
});

test('stripPrefix:剥掉 node --import tsx 全写前缀(门禁自用形态)', () => {
  const line = 'node --import tsx src/cli/main.ts videos list';
  assert.equal(stripPrefix(line), 'videos list');
});

test('stripPrefix:裸命令(无前缀)原样返回', () => {
  assert.equal(stripPrefix('stats overview'), 'stats overview');
});

// ── 组:help 文本解析 ──

test('parseCommandsFromHelp:从 Commands: 段提取命令名,跳过 help 与参数占位', () => {
  // 前置:commander 的 help 输出里 `get <source> <sourceVid>` 只取首词;help 是内置命令不算业务命令。
  const help = [
    'Usage: collector-cli videos [options] [command]',
    '',
    'Options:',
    '  -h, --help                display help for command',
    '',
    'Commands:',
    '  list [options]            按条件过滤视频列表',
    '  get <source> <sourceVid>  按 source 取详情',
    '  help [command]            display help for command',
  ].join('\n');
  assert.deepEqual(parseCommandsFromHelp(help), ['list', 'get']);
});

test('parseCommandsFromHelp:无 Commands: 段(叶子命令)返回空数组', () => {
  const help = ['Usage: collector-cli videos list [options]', '', 'Options:', '  --q <text>  标题'].join('\n');
  assert.deepEqual(parseCommandsFromHelp(help), []);
});

test('parseOptionsFromHelp:提取长选项名,-v, --version 形态取长名', () => {
  const help = [
    'Options:',
    '  --q <text>           标题 / UP 名模糊匹配',
    '  --has-subtitle       仅含至少一条字幕版本的视频',
    '  -v, --version        输出版本号',
    '  -q, --quiet          抑制 stderr (default: false)',
  ].join('\n');
  assert.deepEqual(parseOptionsFromHelp(help), ['q', 'has-subtitle', 'version', 'quiet']);
});

// ── 组:样例校验(注入 fake resolver,不 spawn)──

// 统一的 fake help 树:顶层 → videos{list} → list 的选项清单。
const fakeResolver = {
  commands: async (path) => {
    // 注意按深度分派:['videos','list'] 已是叶子,Commands 为空。
    if (path.length === 0) return ['videos', 'stats', 'server'];
    if (path.length === 1 && path[0] === 'videos') return ['list', 'get'];
    if (path.length === 1 && path[0] === 'server') return ['ping', 'status'];
    return []; // stats 无子命令;叶子级一律为空
  },
  options: async (path) => {
    if (path.join(' ') === 'videos list') return ['q', 'limit', 'since'];
    return ['help'];
  },
};

test('validateSample:合法样例(路径存在+选项拼写对)返回空错误数组', async () => {
  const errs = await validateSample('collector-cli videos list --q 关键词 --limit 5', fakeResolver, 'f.md', 1);
  assert.deepEqual(errs, []);
});

test('validateSample:命令路径不存在 → 报「未知命令」', async () => {
  const errs = await validateSample('collector-cli videoz list', fakeResolver, 'f.md', 1);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /未知命令/);
});

test('validateSample:子命令不存在(组存在但子命令拼错)→ 报错指明该级', async () => {
  const errs = await validateSample('collector-cli videos lst --q x', fakeResolver, 'f.md', 1);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /videos/);
});

test('validateSample:选项拼写错(--sorce)→ 报「未知选项」', async () => {
  const errs = await validateSample('collector-cli videos list --sorce bilibili', fakeResolver, 'f.md', 1);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /未知选项.*sorce/);
});

test('validateSample:全局选项(--db/--format/-q 及其值)不参与校验、不误报', async () => {
  const line = 'collector-cli --db /tmp/x.db --format json -q videos list --limit 5';
  const errs = await validateSample(line, fakeResolver, 'f.md', 1);
  assert.deepEqual(errs, []);
});

test('validateSample:带值全局选项的值不被当成命令(--db 的路径)→ 不误报未知命令', async () => {
  const line = 'collector-cli --db /tmp/x.db videos list';
  const errs = await validateSample(line, fakeResolver, 'f.md', 1);
  assert.deepEqual(errs, []);
});

test('validateSample:位置参数(BV 号)不进命令路径、不报错', async () => {
  const errs = await validateSample('collector-cli videos get bilibili BV1xx411', fakeResolver, 'f.md', 1);
  // fake 树里 videos get 存在;BV1xx411 是位置参数。
  assert.deepEqual(errs, []);
});

test('validateSample:无子命令的组(stats overview)直接到叶子级校验选项', async () => {
  // fake 树 stats 无子命令,overview 是位置参数;stats 叶子选项只有 help。
  const errs = await validateSample('collector-cli stats overview', fakeResolver, 'f.md', 1);
  assert.deepEqual(errs, []);
});

test('validateSample:未知全局位置的选项混入命令段(--formt json)→ 报未知选项', async () => {
  const errs = await validateSample('collector-cli videos list --formt json', fakeResolver, 'f.md', 1);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /formt/);
});

// ── 组:scripts 引用提取 ──

test('extractScriptRefs:提取 node scripts/x.mjs 与裸路径两种引用形态', () => {
  const md = [
    '跑 `node scripts/collect-batch.mjs` 批量采集,',
    '或直接 `scripts/youtube-collect-videos.mjs` 产出清单。',
    '门槛脚本 scripts/quality-baseline.mjs check 是既有工具。',
  ].join('\n');
  const refs = extractScriptRefs(md);
  assert.ok(refs.includes('collect-batch.mjs'));
  assert.ok(refs.includes('youtube-collect-videos.mjs'));
  assert.ok(refs.includes('quality-baseline.mjs'));
});

test('extractScriptRefs:引用不存在的脚本文件会被上层存在性检查拦住(此处只测提取)', () => {
  const refs = extractScriptRefs('见 scripts/not-exist.mjs 说明');
  assert.ok(refs.includes('not-exist.mjs'));
});
