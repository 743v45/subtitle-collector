// PlatformSelect 共享件测试：四平台选项齐全（全部/哔哩哔哩/YouTube/抖音）与 value/onChange 语义
// （null=全部 ↔ '__all' 哨兵互转，四页 URL 白名单写入值与下拉值域一致的前提）。
// 跑法：npx vitest run src/components/PlatformSelect.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 抽出共享件时的双平台选项 + 语义（2026-08-24，原四页内联下拉收敛） | 通过 | 从 StatsPage.test 迁移语义 |
// | R2 | douyin 第四项（2026-08-29 接入）：选项存在、选中回调 'douyin' | 通过 | |
import { test, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PlatformSelect } from './PlatformSelect';

// Radix Select 在 jsdom 打开所需 polyfill（对齐 TagsPage.test 先例）
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  (window.HTMLElement.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = vi.fn(() => false);
  (window.HTMLElement.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = vi.fn();
});

afterEach(cleanup);

test('四平台选项齐全：全部 / 哔哩哔哩 / YouTube / 抖音', async () => {
  const onChange = vi.fn();
  render(<PlatformSelect value={null} onChange={onChange} />);
  // trigger 显示「全部平台」（value=null → __all 哨兵）
  expect(screen.getByRole('combobox', { name: '平台筛选' })).toBeInTheDocument();
  fireEvent.pointerDown(screen.getByRole('combobox', { name: '平台筛选' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  expect(await screen.findByRole('option', { name: '全部平台' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: '哔哩哔哩' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'YouTube' })).toBeInTheDocument();
  // douyin 第四项（2026-08-29）
  expect(screen.getByRole('option', { name: '抖音' })).toBeInTheDocument();
});

test('选中抖音 → onChange 回调原值 douyin；选全部平台 → null', async () => {
  const onChange = vi.fn();
  render(<PlatformSelect value={null} onChange={onChange} />);
  fireEvent.pointerDown(screen.getByRole('combobox', { name: '平台筛选' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '抖音' }));
  expect(onChange).toHaveBeenCalledWith('douyin');

  cleanup();
  const onChange2 = vi.fn();
  render(<PlatformSelect value="douyin" onChange={onChange2} />);
  // value=douyin 时 trigger 回显「抖音」（受控值 → 显示名映射正确）
  fireEvent.pointerDown(screen.getByRole('combobox', { name: '平台筛选' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '全部平台' }));
  expect(onChange2).toHaveBeenCalledWith(null);
});
