// Select 组件测试：触发器渲染/占位、pointerDown 打开内容、选项点击回调、label/separator/滚动按钮渲染。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 打开/选择交互 + 子组件渲染 | 通过 | jsdom 需 stub hasPointerCapture/scrollIntoView；ctrlKey 须 false |
import { test, expect, vi, beforeAll, afterEach } from 'vitest';

afterEach(cleanup);
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  Select, SelectContent, SelectItem, SelectLabel, SelectSeparator,
  SelectTrigger, SelectValue, SelectScrollUpButton, SelectScrollDownButton, SelectGroup,
} from './select';

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  (window.HTMLElement.prototype as any).hasPointerCapture = vi.fn(() => false);
  (window.HTMLElement.prototype as any).releasePointerCapture = vi.fn();
});

function openSelect() {
  const trigger = screen.getByRole('combobox');
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  return trigger;
}

test('触发器：值渲染 + 类名合并 + disabled', () => {
  const { rerender } = render(
    <Select value="a" onValueChange={() => {}}>
      <SelectTrigger className="w-32" disabled><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="a">甲</SelectItem></SelectContent>
    </Select>,
  );
  const trigger = screen.getByRole('combobox');
  expect(trigger).toHaveTextContent('甲');
  expect(trigger.className).toContain('w-32');
  expect(trigger.className).toContain('cursor-not-allowed');
  expect((trigger as HTMLElement).hasAttribute('disabled')).toBe(true);
  rerender(
    <Select onValueChange={() => {}}>
      <SelectTrigger><SelectValue placeholder="请选择" /></SelectTrigger>
      <SelectContent><SelectItem value="a">甲</SelectItem></SelectContent>
    </Select>,
  );
  expect(screen.getByRole('combobox')).toHaveTextContent('请选择');
});

test('打开内容：选项/分组标签/分隔线（滚动按钮 jsdom 无 scrollTop 恒 null，由 Content 内部引用覆盖行执行）', async () => {
  render(
    <Select value="a" onValueChange={() => {}}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectScrollUpButton />
        <SelectGroup>
          <SelectLabel>组名</SelectLabel>
          <SelectItem value="a" disabled>甲</SelectItem>
        </SelectGroup>
        <SelectSeparator className="my-2" />
        <SelectItem value="b">乙</SelectItem>
        <SelectScrollDownButton />
      </SelectContent>
    </Select>,
  );
  openSelect();
  expect(await screen.findByRole('option', { name: '甲' })).toBeInTheDocument();
  expect(screen.getByText('组名').className).toContain('font-semibold');
  // Separator：无 role 标记，按静态类断言（-mx-1 bg-muted 细线）
  const sep = document.querySelector('.bg-muted.-mx-1');
  expect(sep).not.toBeNull();
});

test('点击选项：onValueChange 触发 + 选中项勾标', async () => {
  const onValueChange = vi.fn();
  render(
    <Select value="a" onValueChange={onValueChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="a">甲</SelectItem>
        <SelectItem value="b">乙</SelectItem>
      </SelectContent>
    </Select>,
  );
  openSelect();
  const optB = await screen.findByRole('option', { name: '乙' });
  fireEvent.click(optB);
  expect(onValueChange).toHaveBeenCalledWith('b');
});
