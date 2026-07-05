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
import { matchBody } from './sub.js';

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
