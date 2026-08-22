// 组件测试冒烟样板：验证 vitest + jsdom + @testing-library/react 基建链路（TSX 渲染 + jest-dom matchers）。
// 后续页面组件测试参考此文件范式（render + screen + vi.stubGlobal('fetch', ...) mock API）。
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './button';

test('Button：渲染 children 并响应点击', async () => {
  const onClick = vi.fn();
  render(<Button onClick={onClick}>采集</Button>);
  const btn = screen.getByRole('button', { name: '采集' });
  expect(btn).toBeInTheDocument();
  btn.click();
  expect(onClick).toHaveBeenCalledTimes(1);
});

test('Button：variant/size 变体类名生效', () => {
  render(<Button variant="outline" size="sm">变体</Button>);
  const btn = screen.getByRole('button', { name: '变体' });
  expect(btn.className).toContain('border');
});
