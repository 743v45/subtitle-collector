// SettingsPage 测试：加载骨架、毫秒→秒回填、保存校验（范围/整数）、保存成败 toast。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 回填 + 三种校验失败 + 成功 PUT + 失败 toast | 通过 | 输入 type=number 用 fireEvent.change |
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { SettingsPage } from './SettingsPage';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(ok({ bilibili: 90000, youtube: 45000 })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function inputs(): HTMLInputElement[] {
  return [
    screen.getByLabelText(/YouTube/),
    screen.getByLabelText(/B站/),
  ] as HTMLInputElement[];
}

test('回填：毫秒转秒显示（45000→45 / 90000→90）；加载中骨架', async () => {
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  // 初始 pending → 骨架
  expect(document.querySelector('.animate-pulse')).not.toBeNull();
  await screen.findByText('采集超时');
  const [yt, bili] = inputs();
  expect(yt.value).toBe('45');
  expect(bili.value).toBe('90');
  expect(fetchMock.mock.calls[0][0]).toBe('/api/settings/collect-timeout');
});

test('校验：低于 15 → 提示且不发 PUT', async () => {
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  await screen.findByText('采集超时');
  fireEvent.change(screen.getByLabelText(/YouTube/), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: /保存/ }));
  expect(await screen.findByText('超时须为 15–600 的整数秒')).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);
});

test('校验：高于 600 / 非整数 → 提示', async () => {
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  await screen.findByText('采集超时');
  fireEvent.change(screen.getByLabelText(/B站/), { target: { value: '601' } });
  fireEvent.click(screen.getByRole('button', { name: /保存/ }));
  expect(await screen.findByText('超时须为 15–600 的整数秒')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/B站/), { target: { value: '45.5' } });
  fireEvent.click(screen.getByRole('button', { name: /保存/ }));
  // 两次校验失败叠加两条 toast
  expect(await screen.findAllByText('超时须为 15–600 的整数秒')).toHaveLength(2);
});

test('保存成功：PUT 秒→毫秒 + toast', async () => {
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  await screen.findByText('采集超时');
  fireEvent.change(screen.getByLabelText(/YouTube/), { target: { value: '60' } });
  fireEvent.change(screen.getByLabelText(/B站/), { target: { value: '120' } });
  fireEvent.click(screen.getByRole('button', { name: /保存/ }));
  expect(await screen.findByText('已保存采集超时（对之后派发的任务生效）')).toBeInTheDocument();
  const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')!;
  expect(put[0]).toBe('/api/settings/collect-timeout');
  expect(JSON.parse(String(put[1].body))).toEqual({ bilibili: 120000, youtube: 60000 });
});

test('保存失败：toast 带错误文案', async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return Promise.resolve(new Response('no', { status: 400 }));
    return Promise.resolve(ok({ bilibili: 90000, youtube: 45000 }));
  });
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  await screen.findByText('采集超时');
  fireEvent.click(screen.getByRole('button', { name: /保存/ }));
  expect(await screen.findByText('保存失败：HTTP 400')).toBeInTheDocument();
});
