// 覆盖 quality-baseline.mjs 的核心逻辑：buildSnapshot（ESLint 结果聚合）与 diffBaseline（台账四类 diff）。
// 这是守门员脚本，自身必须被测试保护（CLAUDE.md 测试质量政策）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, diffBaseline } from './quality-baseline.mjs';

// 构造一条 ESLint message 的便捷函数
const msg = (ruleId, message) => ({ ruleId, message });

test('buildSnapshot：聚合同文件多条 complexity 取最大值', () => {
  const results = [
    {
      filePath: '/repo/apps/a.ts',
      messages: [
        msg('complexity', "Function 'f1' has a complexity of 18. Maximum allowed is 15."),
        msg('complexity', "Function 'f2' has a complexity of 31. Maximum allowed is 15."),
        msg('max-lines', 'File has too many lines (512). Maximum allowed is 400.'),
      ],
    },
  ];
  const snap = buildSnapshot(results, '/repo');
  assert.deepEqual(snap, { 'apps/a.ts': { complexity: 31, maxLines: 512 } });
});

test('buildSnapshot：非目标规则与解析失败项被忽略', () => {
  const results = [
    {
      filePath: '/repo/b.ts',
      messages: [
        { ruleId: 'no-undef', message: "'x' is not defined.", fatal: false },
        { ruleId: null, message: 'Parsing error: unexpected token', fatal: true },
      ],
    },
  ];
  assert.deepEqual(buildSnapshot(results, '/repo'), {});
});

test('diffBaseline：台账外新超标文件进入 added', () => {
  const d = diffBaseline(
    { 'new.ts': { complexity: 20 } },
    { 'old.ts': { complexity: 25 } },
  );
  assert.deepEqual(d.added, [{ file: 'new.ts', rule: 'complexity', value: 20 }]);
  assert.equal(d.worsened.length, 0);
});

test('diffBaseline：数值上升为 worsened、下降为 improved', () => {
  const d = diffBaseline(
    { 'a.ts': { complexity: 30 }, 'b.ts': { complexity: 18 } },
    { 'a.ts': { complexity: 25 }, 'b.ts': { complexity: 20 } },
  );
  assert.deepEqual(d.worsened, [{ file: 'a.ts', rule: 'complexity', from: 25, to: 30 }]);
  assert.deepEqual(d.improved, [{ file: 'b.ts', rule: 'complexity', from: 20, to: 18 }]);
});

test('diffBaseline：台账内文件整体消失进入 removed', () => {
  const d = diffBaseline({}, { 'gone.ts': { complexity: 25 } });
  assert.deepEqual(d.removed, ['gone.ts']);
});

test('diffBaseline：台账内文件某规则达标记为 improved（不失败）', () => {
  // 文件仍超标 complexity 但行数已降到达标 → maxLines 从快照消失
  const d = diffBaseline(
    { 'a.ts': { complexity: 25 } },
    { 'a.ts': { complexity: 25, maxLines: 500 } },
  );
  assert.deepEqual(d.improved, [{ file: 'a.ts', rule: 'maxLines', from: 500, to: '达标' }]);
  assert.equal(d.worsened.length, 0);
});

test('diffBaseline：台账文件新增规则维度视为 added（防漏管）', () => {
  // 台账只记了 complexity，现状又超了 maxLines → 新维度必须算变差项
  const d = diffBaseline(
    { 'a.ts': { complexity: 25, maxLines: 410 } },
    { 'a.ts': { complexity: 25 } },
  );
  assert.deepEqual(d.added, [{ file: 'a.ts', rule: 'maxLines', value: 410 }]);
});
