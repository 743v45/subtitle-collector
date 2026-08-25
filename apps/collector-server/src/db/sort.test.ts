// db/sort.ts 单测：buildOrderBy 的分支组合（nullable / tie / 方向）。
// 排序语义的端到端效果由各 db 查询的测试覆盖（advanced/queries/tags/tasks），这里锁子句形态。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderBy } from './sort.js';

test('buildOrderBy：基础方向 + 主键 tie 方向随主键', () => {
  assert.equal(buildOrderBy('v.first_seen_at', true, { tieExpr: 'v.id' }), 'ORDER BY v.first_seen_at DESC, v.id DESC');
  assert.equal(buildOrderBy('t.created_at', false, { tieExpr: 't.id' }), 'ORDER BY t.created_at ASC, t.id ASC');
});

test('buildOrderBy：nullable 键 NULLS LAST 不随方向翻转', () => {
  assert.equal(buildOrderBy('t.finished_at', true, { nullable: true, tieExpr: 't.id' }), 'ORDER BY t.finished_at DESC NULLS LAST, t.id DESC');
  assert.equal(buildOrderBy('t.finished_at', false, { nullable: true, tieExpr: 't.id' }), 'ORDER BY t.finished_at ASC NULLS LAST, t.id ASC');
});

test('buildOrderBy：无 tie / 无选项的裸子句', () => {
  assert.equal(buildOrderBy('c.name', false), 'ORDER BY c.name ASC');
  assert.equal(buildOrderBy('c.name', true, {}), 'ORDER BY c.name DESC');
});
