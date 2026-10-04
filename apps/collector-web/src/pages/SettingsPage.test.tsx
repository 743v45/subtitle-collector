// SettingsPage 测试：加载骨架、毫秒→秒回填、保存校验（范围/整数）、保存成败 toast、
// server 状态卡（数据渲染/鉴权徽章三分支/humanizeUptime/错误重试）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 回填 + 三种校验失败 + 成功 PUT + 失败 toast | 通过 | 输入 type=number 用 fireEvent.change |
// | R2 | 抖音档三键化（2026-08-29,server PUT 缺键 400 的集成缺口修复） | 通过 | mock/inputs/PUT body 全三键 |
// | R3 | 状态卡：渲染/鉴权徽章三分支/humanizeUptime 边界/错误重试（Phase 1 server 状态卡） | 通过 | calls[0] 变 /api/status，回填断言改 toContain |
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { SettingsPage, humanizeUptime } from './SettingsPage';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

const statusPayload = {
  version: '0.5.0',
  uptime_s: 90061,
  config: { host: '127.0.0.1', port: 8080, auth_required: true, token_configured: true, allowed_hosts: '*' },
  db_path: '/data/collector.db',
  online_clients: 2,
  counts: { videos: 33, creators: 8, tracks: 60, versions: 70, collect_tasks: 12 },
};

const fetchMock = vi.fn();

function routeDefault() {
  return (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/status')) return Promise.resolve(ok(statusPayload));
    return Promise.resolve(ok({ bilibili: 90000, youtube: 45000, douyin: 45000 }));
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(routeDefault());
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
    screen.getByLabelText(/抖音/),
  ] as HTMLInputElement[];
}

test('回填：毫秒转秒显示（45000→45 / 90000→90）；加载中骨架', async () => {
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  // 初始 pending → 骨架
  expect(document.querySelector('.animate-pulse')).not.toBeNull();
  await screen.findByText('采集超时');
  const [yt, bili, dy] = inputs();
  expect(yt.value).toBe('45');
  expect(bili.value).toBe('90');
  expect(dy.value).toBe('45'); // 抖音档三键回填（缺键 PUT 会 400）——注：vitest toBe 不收 message 参（Jest 习惯），说明写注释
  // R3：状态卡在前 → 首个请求是 /api/status，collect-timeout 仍在（顺序不钉死，包含即算同步）
  expect(fetchMock.mock.calls.map((c) => c[0])).toContain('/api/status');
  expect(fetchMock.mock.calls.map((c) => c[0])).toContain('/api/settings/collect-timeout');
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
  fireEvent.change(screen.getByLabelText(/抖音/), { target: { value: '90' } });
  fireEvent.click(screen.getByRole('button', { name: /保存/ }));
  expect(await screen.findByText('已保存采集超时（对之后派发的任务生效）')).toBeInTheDocument();
  const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')!;
  expect(put[0]).toBe('/api/settings/collect-timeout');
  // 三键齐发——server 缺 douyin 键会 400（2026-08-29 三平台校验）
  expect(JSON.parse(String(put[1].body))).toEqual({ bilibili: 120000, youtube: 60000, douyin: 90000 });
});

test('保存失败：toast 带错误文案', async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return Promise.resolve(new Response('no', { status: 400 }));
    if (String(url).includes('/api/status')) return Promise.resolve(ok(statusPayload));
    return Promise.resolve(ok({ bilibili: 90000, youtube: 45000, douyin: 45000 }));
  });
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  await screen.findByText('采集超时');
  fireEvent.click(screen.getByRole('button', { name: /保存/ }));
  expect(await screen.findByText('保存失败：HTTP 400')).toBeInTheDocument();
});

// ── R3：server 状态卡 ──

test('状态卡：版本/运行时长人话/在线客户端/计数摘要/鉴权徽章/db_path（token 不回显）', async () => {
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  expect(await screen.findByText('服务状态')).toBeInTheDocument();
  expect(screen.getByText('v0.5.0')).toBeInTheDocument();
  expect(screen.getByText('运行 1 天 1 小时')).toBeInTheDocument(); // 90061s = 1d 1h 1m
  expect(screen.getByText('2')).toBeInTheDocument(); // 在线客户端
  expect(screen.getByText('鉴权已启用')).toBeInTheDocument(); // auth_required + token_configured
  expect(screen.getByText('视频 33')).toBeInTheDocument();
  expect(screen.getByText('轨 60')).toBeInTheDocument();
  expect(screen.getByText('版本 70')).toBeInTheDocument();
  expect(screen.getByText('任务 12')).toBeInTheDocument();
  expect(screen.getByText('/data/collector.db')).toBeInTheDocument();
  // token 本体绝不出现在页面（接口形状里也没有 token 值，防御性断言）
  expect(document.body.textContent).not.toContain('sk-');
});

test('状态卡鉴权徽章三分支：未配 token（destructive）/未启用（outline）', async () => {
  // auth_required=true 但 token_configured=false → 警示徽章
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/api/status')) {
      return Promise.resolve(ok({ ...statusPayload, config: { ...statusPayload.config, token_configured: false } }));
    }
    return Promise.resolve(ok({ bilibili: 90000, youtube: 45000, douyin: 45000 }));
  });
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  expect(await screen.findByText('鉴权未配 token')).toBeInTheDocument();
  cleanup();

  // auth_required=false → 未启用徽章（token_configured 值无关）
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/api/status')) {
      return Promise.resolve(ok({ ...statusPayload, config: { ...statusPayload.config, auth_required: false, token_configured: false } }));
    }
    return Promise.resolve(ok({ bilibili: 90000, youtube: 45000, douyin: 45000 }));
  });
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  expect(await screen.findByText('鉴权未启用')).toBeInTheDocument();
});

test('humanizeUptime：天/小时/分钟/不足 1 分钟/非法值边界', () => {
  expect(humanizeUptime(259200)).toBe('3 天 0 小时'); // 恰好 3 天整（小时位为 0 的边界）
  expect(humanizeUptime(18720)).toBe('5 小时 12 分钟');
  expect(humanizeUptime(300)).toBe('5 分钟');
  expect(humanizeUptime(30)).toBe('不到 1 分钟');
  expect(humanizeUptime(0)).toBe('不到 1 分钟');
  expect(humanizeUptime(-1)).toBe('—');
  expect(humanizeUptime(Number.NaN)).toBe('—');
});

test('状态卡错误态：文案 + 重试拉到数据', async () => {
  let fail = true;
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/api/status')) {
      return fail
        ? Promise.resolve(new Response(JSON.stringify({ ok: false, error: '库打不开' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
        : Promise.resolve(ok(statusPayload));
    }
    return Promise.resolve(ok({ bilibili: 90000, youtube: 45000, douyin: 45000 }));
  });
  render(<ToastProvider><SettingsPage /></ToastProvider>);
  expect(await screen.findByText('状态获取失败：HTTP 500：库打不开')).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.getByText('v0.5.0')).toBeInTheDocument());
});
