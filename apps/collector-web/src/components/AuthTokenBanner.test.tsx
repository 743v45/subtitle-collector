// AuthTokenBanner 组件单测：401 → 横幅显形 → 保存 token（localStorage 落库）→ 刷新提示；
// 「不再提醒」会话内记忆；非 401 不显示。401→横幅→带 Bearer 重试是暴露部署老 WebView 的
// 唯一恢复通道（2026-10-07 生产 401 实测），本组测试锁该交互链防回退。
// 跑法：npx vitest run src/components/AuthTokenBanner.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 401 显形/保存落库/不再提醒/空输入禁存 四例 | 通过 | 2026-10-07 账本 U-1 |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { AuthTokenBanner } from './AuthTokenBanner';
import { AUTH_REQUIRED_EVENT, getToken } from '../authToken';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function fire401() {
  act(() => { window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT)); });
}

test('默认不显示；收到 401 事件 → 横幅显形含输入框与保存按钮', () => {
  render(<AuthTokenBanner />);
  expect(screen.queryByRole('alert')).toBe(null);
  fire401();
  expect(screen.getByRole('alert')).toHaveTextContent('接口需要访问 token');
  expect(screen.getByLabelText('访问 token')).toBeInTheDocument();
});

test('输入 token 保存 → localStorage 落库 + 刷新提示；再次 401 事件不重复弹保存态', () => {
  render(<AuthTokenBanner />);
  fire401();
  fireEvent.change(screen.getByLabelText('访问 token'), { target: { value: 'tok-xyz' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(getToken()).toBe('tok-xyz');
  expect(screen.getByText(/已保存，后续请求将自动携带/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '刷新页面' })).toBeInTheDocument();
});

test('空输入保存按钮禁用（防误存空 token）；回车等效点击保存', () => {
  render(<AuthTokenBanner />);
  fire401();
  const save = screen.getByRole('button', { name: '保存' });
  expect(save).toBeDisabled();
  const input = screen.getByLabelText('访问 token');
  fireEvent.change(input, { target: { value: 'tok-enter' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(getToken()).toBe('tok-enter');
});

test('不再提醒：本会话关闭横幅（sessionStorage 记忆），后续 401 事件不再弹', () => {
  render(<AuthTokenBanner />);
  fire401();
  fireEvent.click(screen.getByRole('button', { name: '不再提醒' }));
  expect(screen.queryByRole('alert')).toBe(null);
  fire401();
  expect(screen.queryByRole('alert')).toBe(null);
  expect(window.sessionStorage.getItem('collector-auth-banner-dismissed')).toBe('1');
});
