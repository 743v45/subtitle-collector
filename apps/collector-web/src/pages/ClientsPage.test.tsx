// ClientsPage 测试：列表渲染 / 上报开关切换（成功+失败）/ 任务派发开关（状态展示+切换）/ 空态 / 轮询 3s / 卸载清 interval。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 渲染 + toggle 成败 + 空态 + 3s 轮询 | 通过 | 轮询用 fake timers（shouldAdvanceTime 保 findBy 可用） |
// | R2 | 任务派发开关（2026-08-23 仅上报状态）：badge 展示 + 切换 POST /api/clients/:id/task-dispatch | 通过 | |
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { ClientsPage } from './ClientsPage';
import type { ClientInfo } from '../types';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

function client(id: string, reporting: boolean, ver: string | null = '0.1.12', acceptsTasks = true): ClientInfo {
  return { client_id: id, ext_version: ver, reporting_enabled: reporting, task_dispatch_enabled: acceptsTasks, connected: true };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(ok({ clients: [] })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('渲染：client_id / 版本 / 开关文案；ext_version null 显示 -', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(ok({
    clients: [client('ext-alpha', true), client('ext-beta', false, null)],
  })));
  render(<ClientsPage />);
  expect(await screen.findByText('ext-alpha')).toBeInTheDocument();
  expect(screen.getByText('版本 0.1.12')).toBeInTheDocument();
  expect(screen.getByText('版本 -')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /暂停自动上报/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /恢复自动上报/ })).toBeInTheDocument();
  expect(screen.getByText('在线客户端 2 个 · 每 3s 刷新')).toBeInTheDocument();
});

test('toggle：POST reporting 后刷新列表', async () => {
  const clients = [client('c1', true)];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(ok({ reporting_enabled: false }));
    return Promise.resolve(ok({ clients }));
  });
  render(<ClientsPage />);
  await screen.findByText('c1');
  fireEvent.click(screen.getByRole('button', { name: /暂停自动上报/ }));
  await waitFor(() => {
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/api/clients/c1/reporting');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ enabled: false });
  });
  // toggle 成功后 refresh()：GET 至少再来一次
  await waitFor(() => {
    const gets = fetchMock.mock.calls.filter((c) => !c[1]);
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });
});

test('toggle 失败：显示操作失败文案', async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(new Response('', { status: 500 }));
    return Promise.resolve(ok({ clients: [client('c1', true)] }));
  });
  render(<ClientsPage />);
  await screen.findByText('c1');
  fireEvent.click(screen.getByRole('button', { name: /暂停自动上报/ }));
  expect(await screen.findByText(/操作失败：HTTP 500/)).toBeInTheDocument();
});

// ── 任务派发开关（2026-08-23 仅上报状态）──

test('任务派发：仅上报客户端显示「仅上报状态」badge，接受的显示恢复按钮文案', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(ok({
    clients: [client('c1', true, '0.1.12', false), client('c2', true, '0.1.12', true)],
  })));
  render(<ClientsPage />);
  expect(await screen.findByText('c1')).toBeInTheDocument();
  expect(screen.getByText('仅上报状态')).toBeInTheDocument(); // c1 的 badge
  // c1（仅上报）→ 按钮动作是恢复；c2（接受）→ 按钮动作是停派
  expect(screen.getByRole('button', { name: /恢复接任务/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /停派任务/ })).toBeInTheDocument();
});

test('任务派发 toggle：POST task-dispatch 后刷新列表', async () => {
  const clients = [client('c1', true, '0.1.12', true)];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(ok({ task_dispatch_enabled: false }));
    return Promise.resolve(ok({ clients }));
  });
  render(<ClientsPage />);
  await screen.findByText('c1');
  fireEvent.click(screen.getByRole('button', { name: /停派任务/ }));
  await waitFor(() => {
    const post = fetchMock.mock.calls.find((c) => String(c[0]).includes('/task-dispatch'));
    expect(post?.[0]).toBe('/api/clients/c1/task-dispatch');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ enabled: false });
  });
});

test('任务派发 toggle 失败：显示操作失败文案', async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).includes('/task-dispatch')) {
      return Promise.resolve(new Response('', { status: 504 }));
    }
    return Promise.resolve(ok({ clients: [client('c1', true, '0.1.12', true)] }));
  });
  render(<ClientsPage />);
  await screen.findByText('c1');
  fireEvent.click(screen.getByRole('button', { name: /停派任务/ }));
  expect(await screen.findByText(/操作失败：HTTP 504/)).toBeInTheDocument();
});

test('空态：暂无在线客户端提示', async () => {
  render(<ClientsPage />);
  expect(await screen.findByText(/暂无在线客户端/)).toBeInTheDocument();
  expect(screen.getByText('在线客户端 0 个 · 每 3s 刷新')).toBeInTheDocument();
});

test('列表加载失败：操作失败文案', async () => {
  fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));
  render(<ClientsPage />);
  expect(await screen.findByText(/操作失败：network down/)).toBeInTheDocument();
});

test('轮询：3s 后再次 GET；卸载后停止', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<ClientsPage />);
  expect(await screen.findByText(/暂无在线客户端/)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  cleanup();
  await act(async () => { vi.advanceTimersByTime(9000); });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
