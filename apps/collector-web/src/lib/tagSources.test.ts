// tagSources 常量表测试：五档键齐全（消费方 Record<TagSource,…> 取值不落 undefined）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 三张表五档键齐全 + 样式类非空 | 通过 | |
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TAG_SOURCE_CLASS, TAG_SOURCE_LABEL, TAG_SOURCE_DOT, type TagSource } from './tagSources.ts';

const FIVE: TagSource[] = ['manual', 'batch', 'bili', 'season', 'ai'];

test('三张表均覆盖五档且值非空', () => {
  for (const s of FIVE) {
    assert.ok(TAG_SOURCE_CLASS[s], `class 缺 ${s}`);
    assert.ok(TAG_SOURCE_LABEL[s], `label 缺 ${s}`);
    assert.ok(TAG_SOURCE_DOT[s], `dot 缺 ${s}`);
  }
  assert.equal(Object.keys(TAG_SOURCE_CLASS).length, 5);
  assert.equal(Object.keys(TAG_SOURCE_LABEL).length, 5);
  assert.equal(Object.keys(TAG_SOURCE_DOT).length, 5);
});

test('档位中文标签取值（消费方 UI 文案锚点）', () => {
  assert.deepEqual(TAG_SOURCE_LABEL, { manual: '手动', batch: '批量', bili: 'B站', season: '合集', ai: 'AI' });
});
