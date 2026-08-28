// PlatformIcon 共享件测试：三分支 SVG path（bilibili/youtube/douyin）与 platformIconClass 语义色。
// douyin 用 tiktok 音符 path（与扩展 platforms.ts LOGOS.tiktok 同源复制），色系为黑（暗色反白）。
// 跑法：npx vitest run src/components/PlatformIcon.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | douyin 分支（2026-08-29 接入）：path 非空且区别于另两平台、黑系色类 | 通过 | |
import { test, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PlatformIcon, platformIconClass } from './PlatformIcon';

function renderedPath(source: string): string {
  const { container } = render(<PlatformIcon source={source} />);
  const path = container.querySelector('svg path');
  return path?.getAttribute('d') ?? '';
}

test('douyin 分支：渲染 tiktok 音符 path，与 bilibili/youtube 均不同', () => {
  const dy = renderedPath('douyin');
  expect(dy).toBeTruthy();
  expect(dy).not.toBe(renderedPath('bilibili'));
  expect(dy).not.toBe(renderedPath('youtube'));
});

test('未知平台回落 bilibili path（既有默认分支不回归）', () => {
  expect(renderedPath('unknown-platform')).toBe(renderedPath('bilibili'));
});

test('platformIconClass 语义色：bilibili 粉 / youtube 红 / douyin 黑（暗色反白）', () => {
  expect(platformIconClass('bilibili')).toBe('text-[#FB7299]');
  expect(platformIconClass('youtube')).toBe('text-red-500');
  expect(platformIconClass('douyin')).toBe('text-black dark:text-white');
  // 未知平台回落 bilibili 粉（既有默认分支）
  expect(platformIconClass('other')).toBe('text-[#FB7299]');
});
