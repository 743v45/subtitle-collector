// Card 组件族测试：六个子组件渲染 + className 合并 + ref 转发 + displayName。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | Card/Header/Title/Description/Content/Footer 渲染与合并 | 通过 | |
import { test, expect } from 'vitest';
import { createRef } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './card';

test('Card：渲染 children + 圆角边框类 + ref 转发', () => {
  const ref = createRef<HTMLDivElement>();
  render(<Card ref={ref} className="border-destructive">内容</Card>);
  const el = screen.getByText('内容');
  expect(el.className).toContain('rounded-lg');
  expect(el.className).toContain('border-destructive');
  expect(ref.current).toBe(el);
});

test('CardHeader / CardTitle / CardDescription / CardContent / CardFooter 组合渲染', () => {
  render(
    <Card data-testid="card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">标题字</CardTitle>
        <CardDescription>描述字</CardDescription>
      </CardHeader>
      <CardContent className="p-3">正文</CardContent>
      <CardFooter className="pt-0">脚注</CardFooter>
    </Card>,
  );
  expect(screen.getByText('标题字').className).toContain('font-semibold');
  expect(screen.getByText('标题字').className).toContain('text-base');
  expect(screen.getByText('描述字').className).toContain('text-muted-foreground');
  expect(screen.getByText('正文').className).toContain('p-3');
  expect(screen.getByText('脚注').className).toContain('items-center');
  expect(screen.getByText('标题字').closest('div.p-6')).not.toBeNull(); // Header 自带 p-6
});
