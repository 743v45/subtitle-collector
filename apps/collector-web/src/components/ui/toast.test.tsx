// Toast 组件测试：Provider 注入 toast API、三档样式渲染、3500ms 自动消失（fake timers）、无 Provider 回落 no-op。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 三档渲染 + 自动消失 + 默认上下文 no-op | 通过 | fake timers 下手动 advance |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { ToastProvider, useToast } from './toast';

function FireToast({ text, kind }: { text: string; kind?: 'success' | 'error' | 'default' }) {
  const toast = useToast();
  return <button onClick={() => toast(text, kind)}>触发</button>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('success/error/default 三档样式渲染', () => {
  vi.useFakeTimers();
  render(
    <ToastProvider>
      <FireToast text="已保存" kind="success" />
      <FireToast text="保存失败" kind="error" />
      <FireToast text="普通提示" />
    </ToastProvider>,
  );
  act(() => {
    screen.getAllByRole('button', { name: '触发' }).forEach((b) => b.click());
  });
  expect(screen.getByText('已保存').className).toContain('bg-emerald-700');
  expect(screen.getByText('保存失败').className).toContain('bg-destructive');
  expect(screen.getByText('普通提示').className).toContain('bg-popover');
});

test('3500ms 后自动消失', () => {
  vi.useFakeTimers();
  render(
    <ToastProvider>
      <FireToast text="稍纵即逝" />
    </ToastProvider>,
  );
  act(() => { screen.getByRole('button', { name: '触发' }).click(); });
  expect(screen.getByText('稍纵即逝')).toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(3500); });
  expect(screen.queryByText('稍纵即逝')).not.toBeInTheDocument();
});

test('多条 toast 叠加不互相覆盖', () => {
  vi.useFakeTimers();
  render(
    <ToastProvider>
      <FireToast text="第一条" />
    </ToastProvider>,
  );
  act(() => { screen.getByRole('button', { name: '触发' }).click(); });
  act(() => { screen.getByRole('button', { name: '触发' }).click(); });
  expect(screen.getAllByText('第一条').length).toBe(2);
  act(() => { vi.advanceTimersByTime(3500); });
  expect(screen.queryByText('第一条')).not.toBeInTheDocument();
});

test('Provider 外 useToast：默认上下文 no-op 不抛错', () => {
  render(<FireToast text="孤儿" />);
  expect(() => screen.getByRole('button', { name: '触发' }).click()).not.toThrow();
});
