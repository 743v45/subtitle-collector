// splitFillLines 单测：译文草稿 → 行数组的纯函数（TranslateWorkbench 写回前校验用）。
// 覆盖：空草稿/全空白、\r\n 与 \r 容忍、结尾单个换行不算多一行、中间空行保留占位。
// 跑法：npx vitest run src/pages/TranslateWorkbench.splitFillLines.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 空草稿/CRLF·CR/尾随换行/中间空行 四例 | 通过 | 2026-10 Phase 3 补翻写回 |
import { test, expect } from 'vitest';
import { splitFillLines } from './TranslateWorkbench';

test('空草稿与全空白：返回空数组（0 行，未匹配态）', () => {
  expect(splitFillLines('')).toEqual([]);
  expect(splitFillLines('   \n  \n')).toEqual([]);
});

test('CRLF 与 CR 换行：按行拆开（Windows / 旧 Mac 粘贴容忍）', () => {
  expect(splitFillLines('你好世界\r\n美联储加息')).toEqual(['你好世界', '美联储加息']);
  expect(splitFillLines('你好世界\r美联储加息')).toEqual(['你好世界', '美联储加息']);
});

test('结尾单个换行：不算多一行（多行粘贴尾随换行是常态）', () => {
  expect(splitFillLines('你好世界\n美联储加息\n')).toEqual(['你好世界', '美联储加息']);
});

test('中间空行：保留为空串占位（fill 契约空行=该行保留占位）', () => {
  expect(splitFillLines('你好世界\n\n美联储加息')).toEqual(['你好世界', '', '美联储加息']);
});
