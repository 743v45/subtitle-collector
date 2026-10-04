// collectErrors 单测：503 → 固定扩展离线指引；其余错误原文透出（502/普通 Error/非 Error 值）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | collectErrorText 四例 | 通过 | 2026-10 Phase 3 采集编排 UI 配套 |
import { test, expect } from 'vitest';
import { collectErrorText } from './collectErrors';

test('collectErrorText：HTTP 503 → 统一扩展离线指引文案', () => {
  expect(collectErrorText(new Error('HTTP 503：no online client（扩展未连接）'))).toBe('扩展离线：请在浏览器扩展 popup 侧确认');
});

test('collectErrorText：502（如需登录）原文透出不改写', () => {
  expect(collectErrorText(new Error('HTTP 502：need_login'))).toBe('HTTP 502：need_login');
});

test('collectErrorText：版本过旧 502 文案原样直出', () => {
  expect(collectErrorText(new Error('HTTP 502：扩展版本过旧（不认识 search）,请更新扩展后重试: unknown action'))).toContain('扩展版本过旧');
});

test('collectErrorText：非 Error 值（字符串）也安全转文案', () => {
  expect(collectErrorText('boom')).toBe('boom');
});
