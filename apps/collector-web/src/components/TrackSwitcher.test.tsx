// TrackSwitcher 组件单测：轨按钮渲染（lan_doc 回落 lan 回落 '?'、默认轨后缀）+ 受控选中 + onSelect 回调。
// 跑法：npx vitest run src/components/TrackSwitcher.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 渲染：lan_doc / lan 回落 / '?' / （默认）后缀 | 通过 | Radix Tabs 在 jsdom 下 click 即触发 onValueChange |
// | R2 | 选中态受控（selected → data-state=active）+ 点击回调 onSelect(id) | 通过 | selected=null → 无激活轨 |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TrackSwitcher } from './TrackSwitcher';
import type { TrackInfo } from '../types';

afterEach(cleanup);

const tracks: TrackInfo[] = [
  { id: 1, lan: 'zh-CN', lan_doc: '中文（简体）', track_type: 1, is_default: true, versions: [] },
  { id: 2, lan: 'ai-ZH', lan_doc: null, track_type: 2, versions: [] },
  { id: 3, lan: null, lan_doc: null, track_type: 3, versions: [] },
];

test('渲染：lan_doc 优先，null 回落 lan，双 null 显 ?；默认轨带（默认）后缀', () => {
  render(<TrackSwitcher tracks={tracks} selected={1} onSelect={() => {}} />);
  expect(screen.getByRole('tab', { name: '中文（简体）（默认）' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'ai-ZH' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '?' })).toBeInTheDocument();
});

test('受控选中：selected 的轨 data-state=active；null → 无激活', () => {
  const { rerender } = render(<TrackSwitcher tracks={tracks} selected={2} onSelect={() => {}} />);
  expect(screen.getByRole('tab', { name: 'ai-ZH' }).getAttribute('data-state')).toBe('active');
  expect(screen.getByRole('tab', { name: '中文（简体）（默认）' }).getAttribute('data-state')).not.toBe('active');

  rerender(<TrackSwitcher tracks={tracks} selected={null} onSelect={() => {}} />);
  expect(screen.queryByRole('tab', { selected: true })).toBe(null);
});

test('点击轨 → onSelect(id)（Number(v) 转换）', () => {
  const onSelect = vi.fn();
  render(<TrackSwitcher tracks={tracks} selected={1} onSelect={onSelect} />);
  // Radix Tabs 在 mousedown（button=0）激活，非 click
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'ai-ZH' }));
  expect(onSelect).toHaveBeenCalledWith(2);
});
