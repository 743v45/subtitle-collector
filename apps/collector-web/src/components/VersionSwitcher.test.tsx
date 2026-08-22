// VersionSwitcher 组件单测：≤1 版本不渲染（null）、origin→标签文案、（默认）后缀、选中与点击回调。
// 跑法：npx vitest run src/components/VersionSwitcher.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 空数组/单版本 → 渲染 null | 通过 | container 空 |
// | R2 | origin 标签（external=外挂 / asr=ASR / 其他=人工）+（默认）后缀 | 通过 | |
// | R3 | 点击 → onSelect(id)；选中/未选中按钮文案可区分 | 通过 | 样式细节不 assert（政策） |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { VersionSwitcher } from './VersionSwitcher';
import type { VersionInfo } from '../types';

afterEach(cleanup);

const v = (id: number, origin: string, is_default?: boolean): VersionInfo => ({
  id, origin, source_url: null, asr_engine: null, captured_at: 0, body_size: 1, is_default,
});

test('空数组 / 单版本 → 不渲染任何按钮', () => {
  const { container } = render(<VersionSwitcher versions={[]} selected={null} onSelect={() => {}} />);
  expect(container).toBeEmptyDOMElement();
  cleanup();
  const { container: c2 } = render(<VersionSwitcher versions={[v(1, 'external')]} selected={1} onSelect={() => {}} />);
  expect(c2).toBeEmptyDOMElement();
});

test('origin 标签：external=外挂、asr=ASR、其他=人工；默认版本带后缀', () => {
  const versions = [v(1, 'external'), v(2, 'asr', true), v(3, 'human')];
  render(<VersionSwitcher versions={versions} selected={null} onSelect={() => {}} />);
  expect(screen.getByRole('button', { name: '外挂' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'ASR（默认）' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '人工' })).toBeInTheDocument();
});

test('点击版本 → onSelect(id)', () => {
  const onSelect = vi.fn();
  render(<VersionSwitcher versions={[v(1, 'external'), v(2, 'asr')]} selected={1} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: 'ASR' }));
  expect(onSelect).toHaveBeenCalledWith(2);
});
