// ExtLink 组件测试：图标模式 / children 文本链接模式 / stopPropagation / 属性透传。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 两模式渲染 + 冒泡拦截 + href/aria 合并 className | 通过 | jsdom 不导航，仅断言属性 |
import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
import { ExtLink } from './ExtLink';

test('无 children：渲染外链图标锚点（aria-label/title/target/rel）', () => {
  render(<ExtLink href="https://space.bilibili.com/42" label="在原站打开空间" />);
  const a = screen.getByRole('link', { name: '在原站打开空间' });
  expect(a).toHaveAttribute('href', 'https://space.bilibili.com/42');
  expect(a).toHaveAttribute('target', '_blank');
  expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  expect(a).toHaveAttribute('title', '在原站打开空间');
});

test('有 children：文本链接模式渲染 children', () => {
  render(<ExtLink href="https://x/" label="外链">站内文案</ExtLink>);
  const a = screen.getByText('站内文案');
  expect(a.tagName).toBe('A');
  expect(a).toHaveTextContent('站内文案');
  // aria-label 仍在（可访问名优先 aria）
  expect(a).toHaveAttribute('aria-label', '外链');
});

test('stopPropagation：点击不冒泡到外层（防触发外层行跳转）', () => {
  const onOuterClick = vi.fn();
  document.body.addEventListener('click', onOuterClick);
  render(<ExtLink href="https://x/" label="外链">链接</ExtLink>);
  fireEvent.click(screen.getByRole('link'));
  // React 18 事件代理在渲染容器（body 子节点）上，stopPropagation 拦住冒泡到 body
  expect(onOuterClick).not.toHaveBeenCalled();
  document.body.removeEventListener('click', onOuterClick);
});

test('className 透传合并（两种模式）', () => {
  const { rerender } = render(<ExtLink href="https://x/" label="a" className="ml-1" />);
  expect(screen.getByRole('link').className).toContain('ml-1');
  rerender(<ExtLink href="https://x/" label="b" className="mr-2">文本</ExtLink>);
  expect(screen.getByRole('link').className).toContain('mr-2');
});
