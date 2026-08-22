// Input / Label / Skeleton 组件测试：渲染、属性透传、类名合并（三者体量小，合并一个文件）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | Input 渲染+onChange / Label htmlFor / Skeleton 类 | 通过 | |
import { test, expect, vi, afterEach } from 'vitest';

afterEach(cleanup);
import { createRef } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Input } from './input';
import { Label } from './label';
import { Skeleton } from './skeleton';

test('Input：type/value 透传 + onChange + 类名合并 + ref', () => {
  const onChange = vi.fn();
  const ref = createRef<HTMLInputElement>();
  render(<Input ref={ref} type="number" value="45" onChange={onChange} className="h-8 w-20" aria-label="秒数" />);
  const el = screen.getByLabelText('秒数') as HTMLInputElement;
  expect(el.type).toBe('number');
  expect(el.value).toBe('45');
  expect(el.className).toContain('h-8');
  expect(ref.current).toBe(el);
  fireEvent.change(el, { target: { value: '60' } });
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('Input：disabled 状态类', () => {
  render(<Input disabled aria-label="禁用输入" />);
  expect((screen.getByLabelText('禁用输入') as HTMLInputElement).disabled).toBe(true);
});

test('Label：htmlFor 关联 + 字重类', () => {
  render(
    <>
      <Input id="cn" aria-label="名称输入" />
      <Label htmlFor="cn">名称</Label>
    </>,
  );
  const label = screen.getByText('名称');
  expect(label).toHaveAttribute('for', 'cn');
  expect(label.className).toContain('font-medium');
});

test('Skeleton：animate-pulse 占位类 + className 合并', () => {
  render(<Skeleton data-testid="sk" className="h-4 w-32" />);
  const el = screen.getByTestId('sk');
  expect(el.className).toContain('animate-pulse');
  expect(el.className).toContain('h-4');
});
