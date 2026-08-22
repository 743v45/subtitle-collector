// Badge 组件测试：默认 variant + 各 variant 类名 + className 合并 + badgeVariants 导出。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 四 variant 渲染 + 无 variant 默认 + 合并 className + badgeVariants() 空参 | 通过 | |
import { test, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
import { Badge, badgeVariants } from './badge';

test('默认 variant 渲染 children', () => {
  render(<Badge>Agent: 科技</Badge>);
  const b = screen.getByText('Agent: 科技');
  expect(b.className).toContain('bg-primary');
  expect(b.className).toContain('inline-flex');
});

test('secondary variant：15% 蓝底降饱和样式', () => {
  render(<Badge variant="secondary">分区</Badge>);
  expect(screen.getByText('分区').className).toContain('bg-secondary/15');
});

test('destructive / outline variant', () => {
  const { rerender } = render(<Badge variant="destructive">错</Badge>);
  expect(screen.getByText('错').className).toContain('bg-destructive');
  rerender(<Badge variant="outline">描边</Badge>);
  expect(screen.getByText('描边').className).toContain('text-foreground');
});

test('className 合并透传', () => {
  render(<Badge className="ml-2">带距</Badge>);
  expect(screen.getByText('带距').className).toContain('ml-2');
});

test('badgeVariants：无参返回默认类', () => {
  expect(badgeVariants()).toContain('inline-flex');
});
