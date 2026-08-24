// ClientsPage 测试：列表渲染 / 上报开关切换（成功+失败）/ 任务派发开关（状态展示+切换）/ 空态 / 轮询 3s / 卸载清 interval。
// 2026-08-24 客户端命名：列表改为全量视图（DB 注册表含离线）——名字展示 / 在线离线时长 / 离线无远程按钮。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 渲染 + toggle 成败 + 空态 + 3s 轮询 | 通过 | 轮询用 fake timers（shouldAdvanceTime 保 findBy 可用） |
// | R2 | 任务派发开关（2026-08-23 仅上报状态）：badge 展示 + 切换 POST /api/clients/:id/task-dispatch | 通过 | |
// | R3 | 客户端命名（2026-08-24）：client() helper 扩全量字段；新增名字/离线时长/离线无按钮断言；计数文案改「客户端 N · 在线 M」 | 通过 | |
// | R4 | B 站登录态（2026-08-24 充电视频 no_subtitle 根因可观察化）：已登录徽章+账号+大会员 / 未登录红徽章 / null（旧扩展）不渲染 | 通过 | |
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { ClientsPage } from './ClientsPage';
import type { ClientInfo } from '../types';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

function client(id: string, reporting: boolean, ver: string | null = '0.1.12', acceptsTasks = true, overrides: Partial<ClientInfo> = {}): ClientInfo {
  const connected = overrides.connected ?? true;
  const now = Date.now();
  return {
    client_id: id,
    client_name: null,
    ext_version: ver,
    bili_login: null,
    reporting_enabled: reporting,
    task_dispatch_enabled: acceptsTasks,
    connected,
    connected_at: connected ? now - 60_000 : null, // 在线 1 分钟
    first_seen_at: now - 86_400_000,
    last_seen_at: connected ? now - 60_000 : now - 3_600_000, // 离线 1 小时
    ...overrides,
  };
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
  expect(screen.getByText(/版本 0\.1\.12/)).toBeInTheDocument();
  expect(screen.getByText(/版本 -/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /暂停自动上报/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /恢复自动上报/ })).toBeInTheDocument();
  expect(screen.getByText('客户端 2 个 · 在线 2 · 每 3s 刷新')).toBeInTheDocument();
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

// ── 客户端命名（2026-08-24）：名字展示 / 在线离线时长 / 离线无远程按钮 ──

test('命名客户端：名字为主标题 + id 小字；未命名的直接显示 id 无小字', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(ok({
    clients: [
      client('ext-a', true, '0.1.20', true, { client_name: '书房 iMac' }),
      client('ext-b', true, '0.1.20'),
    ],
  })));
  render(<ClientsPage />);
  expect(await screen.findByText('书房 iMac')).toBeInTheDocument();
  expect(screen.getByText('ext-a')).toBeInTheDocument(); // id 小字
  expect(screen.getByText('ext-b')).toBeInTheDocument(); // 未命名 → id 即标题
});

test('在线客户端：显示在线时长（connected_at 起算）', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(ok({ clients: [client('c1', true)] })));
  render(<ClientsPage />);
  expect(await screen.findByText(/在线 1 分钟/)).toBeInTheDocument();
});

test('离线客户端：显示离线时长与最后在线；不渲染远程操作按钮（须在线）；计数分离', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(ok({
    clients: [
      client('c-on', true),
      client('c-off', true, '0.1.20', true, {
        connected: false, reporting_enabled: null, task_dispatch_enabled: null, client_name: '旧笔记本',
        last_seen_at: Date.now() - 70 * 60_000, // 70 分钟 →「1 小时 10 分」（覆盖 m%60 分支）
      }),
      client('c-off2', true, '0.1.20', true, {
        connected: false, reporting_enabled: null, task_dispatch_enabled: null,
        last_seen_at: Date.now() - 26 * 3_600_000, // 26 小时 →「1 天 2 小时」（覆盖天级分支）
      }),
      client('c-off3', true, '0.1.20', true, {
        connected: false, reporting_enabled: null, task_dispatch_enabled: null,
        last_seen_at: Date.now() - 2 * 3_600_000, // 整 2 小时 →「2 小时」（m%60=0 不带分）
      }),
      client('c-off4', true, '0.1.20', true, {
        connected: false, reporting_enabled: null, task_dispatch_enabled: null,
        last_seen_at: Date.now() - 48 * 3_600_000, // 整 48 小时 →「2 天」（h%24=0 不带小时）
      }),
    ],
  })));
  render(<ClientsPage />);
  expect(await screen.findByText('旧笔记本')).toBeInTheDocument();
  expect(screen.getByText(/离线 1 小时 10 分/)).toBeInTheDocument();
  expect(screen.getByText(/离线 1 天 2 小时/)).toBeInTheDocument();
  expect(screen.getByText(/离线 2 小时 ·/)).toBeInTheDocument();
  expect(screen.getByText(/离线 2 天 ·/)).toBeInTheDocument();
  expect(screen.getAllByText(/最后在线/).length).toBe(4);
  // 在线客户端有操作按钮，离线的没有
  expect(screen.getByRole('button', { name: /暂停自动上报/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /恢复自动上报/ })).not.toBeInTheDocument(); // 离线卡不渲染
  expect(screen.getByText('客户端 5 个 · 在线 1 · 每 3s 刷新')).toBeInTheDocument();
  // 离线不显示「仅上报状态」badge（开关未知 null）
  expect(screen.queryByText('仅上报状态')).not.toBeInTheDocument();
});

// ── B 站登录态（2026-08-24 充电视频 1190 no_subtitle 根因可观察化）──

test('登录态：已登录 → 徽章 + 昵称（mid）+ 大会员标识；未登录 → 红徽章；null → 不渲染', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(ok({
    clients: [
      client('c-login', true, '0.1.21', true, {
        bili_login: { is_login: true, mid: '3546645614562148', uname: '测试用户', vip: true },
      }),
      client('c-nologin', true, '0.1.21', true, {
        bili_login: { is_login: false },
      }),
      client('c-old', true, '0.1.20'), // bili_login null（旧版扩展未上报）
    ],
  })));
  render(<ClientsPage />);
  expect(await screen.findByText('B 站已登录')).toBeInTheDocument();
  expect(screen.getByText(/测试用户/)).toBeInTheDocument();
  expect(screen.getByText(/3546645614562148/)).toBeInTheDocument();
  expect(screen.getByText('大会员')).toBeInTheDocument();
  expect(screen.getByText('B 站未登录')).toBeInTheDocument();
  // 旧扩展（null）不渲染任何登录态元素
  expect(screen.queryByText(/（未取到昵称）/)).not.toBeInTheDocument();
  // 旧扩展（null）不渲染任何登录态元素：只有上报过登录态的两个客户端渲染徽章
  expect(screen.getAllByText(/B 站(已登录|未登录)/).length).toBe(2);
});

test('登录态：已登录无昵称/无 mid/非大会员 → 兜底文案，无 mid 括号无大会员标识', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(ok({
    clients: [client('c-bare', true, '0.1.21', true, {
      bili_login: { is_login: true, vip: false },
    })],
  })));
  render(<ClientsPage />);
  expect(await screen.findByText('B 站已登录')).toBeInTheDocument();
  expect(screen.getByText(/（未取到昵称）/)).toBeInTheDocument();
  expect(screen.queryByText(/（\d+）/, { selector: 'span.text-muted-foreground' })).not.toBeInTheDocument();
  expect(screen.queryByText('大会员')).not.toBeInTheDocument();
});

test('空态：暂无已知客户端提示', async () => {
  render(<ClientsPage />);
  expect(await screen.findByText(/暂无已知客户端/)).toBeInTheDocument();
  expect(screen.getByText('客户端 0 个 · 在线 0 · 每 3s 刷新')).toBeInTheDocument();
});

test('列表加载失败：操作失败文案', async () => {
  fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));
  render(<ClientsPage />);
  expect(await screen.findByText(/操作失败：network down/)).toBeInTheDocument();
});

test('轮询：3s 后再次 GET；卸载后停止', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<ClientsPage />);
  expect(await screen.findByText(/暂无已知客户端/)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  cleanup();
  await act(async () => { vi.advanceTimersByTime(9000); });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
