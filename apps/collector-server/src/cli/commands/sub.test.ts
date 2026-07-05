// sub.ts 纯处理函数单测：matchBody / extractSnippets / searchSubtitles。
// matchBody/extractSnippets 无 IO 直接断言；searchSubtitles 注入 mock PayloadSource + 临时 DB。
// 跑法：cd apps/collector-server && node --test --import tsx src/cli/commands/sub.test.ts
//
// 测试轮次记录表（对齐全局 CLAUDE.md §8.2 + 项目 CLAUDE.md §3）：
// | 轮次 | 日期 | 范围 | 结果 | 备注 |
// |---|---|---|---|---|
// | R3 | （待填） | matchBody / extractSnippets 纯函数 | ⏳ | |
// | R4 | （待填） | searchSubtitles 编排 + mock PayloadSource | ⏳ | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchBody, extractSnippets } from './sub.js';

// ── matchBody ──

test('matchBody: 子串默认大小写不敏感', () => {
  const body = [
    { from: 0, to: 1, content: '今天 CPI 同比上涨' },
    { from: 1, to: 2, content: '天气不错' },
  ];
  assert.deepEqual(matchBody(body, 'cpi'), [0]);   // 小写 keyword 命中大写 CPI
  assert.deepEqual(matchBody(body, 'CPI'), [0]);
  assert.deepEqual(matchBody(body, '天气'), [1]);
  assert.deepEqual(matchBody(body, '不存在'), []);
});

test('matchBody: --case-sensitive 区分大小写', () => {
  const bodyLower = [{ from: 0, to: 1, content: 'cpi' }];
  assert.deepEqual(matchBody(bodyLower, 'CPI', { caseSensitive: true }), []);  // 大写不命中纯小写
  assert.deepEqual(matchBody(bodyLower, 'CPI'), [0]);                          // 默认不敏感命中
  const bodyMixed = [{ from: 0, to: 1, content: 'CPI 与 cpi 的区别' }];
  assert.deepEqual(matchBody(bodyMixed, 'CPI', { caseSensitive: true }), [0]);
});

test('matchBody: --regex 正则匹配多段', () => {
  const body = [
    { from: 0, to: 1, content: '通胀压力' },
    { from: 1, to: 2, content: 'CPI 上涨' },
    { from: 2, to: 3, content: 'GDP 下行' },
  ];
  assert.deepEqual(matchBody(body, '通胀|CPI', { regex: true }), [0, 1]);
  assert.deepEqual(matchBody(body, 'G.P', { regex: true }), [2]);  // GDP 命中 G.P
});

test('matchBody: 非法正则抛错（供 action 层转 ARGS）', () => {
  assert.throws(() => matchBody([], '(', { regex: true }), /非法正则/);
  assert.throws(() => matchBody([], '[', { regex: true }), /非法正则/);
});

test('matchBody: 空 body → 空命中', () => {
  assert.deepEqual(matchBody([], 'x'), []);
});

// ── extractSnippets ──

test('extractSnippets: ±ctxSec 上下文窗口贪心吞并邻段', () => {
  const body = [
    { from: 0, to: 2, content: 'A' },
    { from: 3, to: 5, content: 'B' },     // 命中：与前后时间差 1s
    { from: 6, to: 8, content: 'C' },
    { from: 100, to: 101, content: 'D' }, // 远离（差 95s）不吞
  ];
  const out = extractSnippets(body, [1], 10, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'B');
  assert.equal(out[0].from, 3);
  assert.equal(out[0].to, 5);
  // 向前吞 A（3-2=1<=10）；向后吞 C（6-5=1<=10）；D 不吞（100-5=95>10）
  assert.deepEqual(out[0].context, '[0-2] A [3-5] B [6-8] C');
});

test('extractSnippets: 边界——首段命中向后吞，末段命中向前吞', () => {
  const body = [
    { from: 0, to: 1, content: 'X' },
    { from: 2, to: 3, content: 'Y' },
  ];
  const head = extractSnippets(body, [0], 10, {});
  assert.deepEqual(head[0].context, '[0-1] X [2-3] Y'); // 首段向后吞 Y
  const tail = extractSnippets(body, [1], 10, {});
  assert.deepEqual(tail[0].context, '[0-1] X [2-3] Y'); // 末段向前吞 X
});

test('extractSnippets: ctxSec=0 只留命中段本身', () => {
  const body = [
    { from: 0, to: 1, content: 'X' },
    { from: 2, to: 3, content: 'Y' },
    { from: 4, to: 5, content: 'Z' },
  ];
  const out = extractSnippets(body, [1], 0, {});
  assert.deepEqual(out[0].context, '[2-3] Y');
});

test('extractSnippets: --plain 去时间戳前缀只留纯文本', () => {
  const body = [
    { from: 0, to: 1, content: 'X' },
    { from: 2, to: 3, content: 'Y' },
  ];
  const out = extractSnippets(body, [0], 10, { plain: true });
  assert.deepEqual(out[0].context, 'XY');
});

test('extractSnippets: maxPerVideo 截断（按命中顺序取前 N）', () => {
  const body = [0, 1, 2, 3, 4].map((i) => ({ from: i * 100, to: i * 100 + 1, content: `hit${i}` }));
  const out = extractSnippets(body, [0, 1, 2, 3, 4], 0, { maxPerVideo: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.content), ['hit0', 'hit1']);
});

test('extractSnippets: 多命中点各自独立产出片段', () => {
  const body = [
    { from: 0, to: 1, content: 'A' },
    { from: 100, to: 101, content: 'B' },  // 命中（远离 A）
    { from: 200, to: 201, content: 'A' },  // 命中（远离 B）
  ];
  const out = extractSnippets(body, [1, 2], 10, {});
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'B');
  assert.equal(out[1].content, 'A');
});
