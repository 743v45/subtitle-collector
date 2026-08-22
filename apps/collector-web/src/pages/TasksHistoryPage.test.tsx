// TasksHistoryPage 页面组件单测：URL 筛选（creator 防抖/mid 判别、q、状态档、平台、方式、
// 时间档含 custom 日期、批次聚焦 chip）、分页、空/错态、重试（单条/本页未成功）、删除、
// 活跃任务 2s 轮询与完成通知。
// 跑法：npx vitest run src/pages/TasksHistoryPage.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 初始加载（分页参数）+ 总数 + 空态双分支（引导采集/放宽筛选）+ 错误态 | 通过 | |
// | R2 | creator/q 防抖写 URL；纯数字 creator → creator_uid 参数 | 通过 | 真实 timer + waitFor |
// | R3 | 状态档 pill / 平台 / 方式 / 时间档（preset + custom 日期）select → 请求参数 | 通过 | Radix Select 文本定位 trigger |
// | R4 | 批次聚焦 chip（渲染/清除）+ 入库维度说明文案；分页翻页 | 通过 | |
// | R5 | 重试本页未成功 / 单行重试 / 删除单条与批次（toast + reload） | 通过 | 包 ToastProvider |
// | R6 | 活跃任务轮询：2s 重拉 → 终态转移发系统通知、全终态即停 | 通过 | fake timers + Notification stub |
// | R7 | 失败分支补口：单删失败 reload / 批次删除部分失败 toast / 多成员批次行单删 / 单行重试失败 | 通过 | 行覆盖收尾 |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { TasksHistoryPage } from './TasksHistoryPage';
import { ToastProvider } from '@/components/ui/toast';
import type { CollectTask } from '../types';

window.HTMLElement.prototype.scrollIntoView = () => {};
(window.HTMLElement.prototype as any).hasPointerCapture = () => false;
(window.HTMLElement.prototype as any).releasePointerCapture = () => {};
(window.HTMLElement.prototype as any).setPointerCapture = () => {};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

function task(p: Partial<CollectTask> & { id: number }): CollectTask {
  return {
    source: 'bilibili',
    source_vid: `BV1hs${p.id}`,
    url: `https://www.bilibili.com/video/BV1hs${p.id}`,
    status: 'succeeded',
    client_id: null,
    batch_id: null,
    error: null,
    result: null,
    title: null,
    creator_name: null,
    created_at: 1_700_000_000_000,
    finished_at: null,
    ...p,
  };
}

interface Call { url: string; init?: RequestInit }

function setup(
  hash = '#/history',
  handler: (url: string, init?: RequestInit) => unknown = (url) => {
    if (url.includes('/api/collect-tasks?')) return { ok: true, total: 0, items: [] };
    return { ok: true };
  },
) {
  window.location.hash = hash;
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(
    <ToastProvider>
      <TasksHistoryPage />
    </ToastProvider>,
  );
  return calls;
}

function qp(calls: Call[]): URLSearchParams {
  const v = calls.filter((c) => c.url.includes('/api/collect-tasks?')).at(-1)!.url;
  return new URL(v, 'http://x').searchParams;
}

function combo(label: string): HTMLElement {
  const el = screen.getByText(label).closest('button');
  if (!el) throw new Error(`combobox not found: ${label}`);
  return el as HTMLElement;
}

// ── R1：初始加载 / 空 / 错 ──

test('初始加载：分页参数 + 总数 + 任务渲染（批次聚合）', async () => {
  const calls = setup('#/history', () => ({
    ok: true, total: 51,
    items: [
      task({ id: 1, status: 'succeeded', title: '历史任务' }),
      task({ id: 2, status: 'failed', title: '失败成员', batch_id: 'bx', error: 'x' }),
      task({ id: 3, status: 'succeeded', title: '成功成员', batch_id: 'bx' }),
    ],
  }));
  expect(await screen.findByText('历史任务')).toBeInTheDocument();
  expect(screen.getByText(/51 条记录/)).toBeInTheDocument();
  expect(screen.getByText(/批量采集 · 2 个视频/)).toBeInTheDocument();
  expect(screen.getByText('完成 1 失败 1')).toBeInTheDocument();
  const p = qp(calls);
  expect(p.get('page')).toBe('1');
  expect(p.get('page_size')).toBe('50');
  expect(screen.getByText('第 1 / 2 页 · 每页 50 条')).toBeInTheDocument();
});

test('错误态：500 → 加载失败文案', async () => {
  setup('#/history', () => new Response(JSON.stringify({ ok: false, error: 'db down' }), { status: 500, headers: { 'content-type': 'application/json' } }));
  expect(await screen.findByText(/加载失败:HTTP 500：db down/)).toBeInTheDocument();
});

test('空态：无筛选 → 引导采集页', async () => {
  setup();
  expect(await screen.findByText('还没有任务记录')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /去采集页提交第一个任务/ }));
  expect(window.location.hash).toBe('#/collect');
});

test('空态：筛选中 → 放宽筛选 + 重置', async () => {
  setup('#/history?status=failed');
  expect(await screen.findByText('没有匹配的任务记录——试试放宽筛选条件')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /重置筛选/ }));
  expect(window.location.hash).toBe('#/history');
});

// ── R2：防抖搜索 ──

test('creator 防抖：UP 名写 creator 参数；纯数字写 creator_uid', async () => {
  const calls = setup();
  await screen.findByText('还没有任务记录');
  const input = screen.getByPlaceholderText('UP 主名字 / B站 mid（纯数字按 mid 精确）');
  fireEvent.change(input, { target: { value: '某UP' } });
  await waitFor(() => expect(qp(calls).get('creator')).toBe('某UP'), { timeout: 1500 });
  fireEvent.change(input, { target: { value: '296399504' } });
  await waitFor(() => expect(qp(calls).get('creator_uid')).toBe('296399504'), { timeout: 1500 });
  expect(qp(calls).has('creator')).toBe(false);
});

test('q 防抖：标题关键词参数', async () => {
  const calls = setup();
  await screen.findByText('还没有任务记录');
  fireEvent.change(screen.getByPlaceholderText('标题关键词'), { target: { value: '关键词' } });
  await waitFor(() => expect(qp(calls).get('q')).toBe('关键词'), { timeout: 1500 });
});

// ── R3：select 筛选 ──

test('状态档 pill：点失败 → status=failed 请求参数', async () => {
  const calls = setup();
  await screen.findByText('还没有任务记录');
  fireEvent.click(screen.getByRole('button', { name: '失败' }));
  await waitFor(() => expect(qp(calls).get('status')).toBe('failed'));
  fireEvent.click(screen.getByRole('button', { name: '进行中' }));
  await waitFor(() => expect(qp(calls).get('status')).toBe('pending,dispatched'));
});

test('平台/方式 select → 请求参数', async () => {
  const calls = setup();
  await screen.findByText('还没有任务记录');

  fireEvent.click(combo('全部平台'));
  fireEvent.click(await screen.findByRole('option', { name: 'YouTube' }));
  await waitFor(() => expect(qp(calls).get('source')).toBe('youtube'));

  fireEvent.click(combo('全部方式'));
  fireEvent.click(await screen.findByRole('option', { name: '批量采集' }));
  await waitFor(() => expect(qp(calls).get('batch')).toBe('batch'));
});

test('时间档：preset → since 参数；切 preset 清日期；custom 档经 URL 激活后日期输入可改', async () => {
  const calls = setup();
  await screen.findByText('还没有任务记录');

  fireEvent.click(combo('全部时间'));
  fireEvent.click(await screen.findByRole('option', { name: '近 7 天' }));
  await waitFor(() => expect(qp(calls).get('since')).toBeTruthy());
  expect(window.location.hash).toContain('range=7d'); // range 是 UI 档，不进 API 请求

  // 疑似组件 bug：UI 选「自定义」写 range=custom，但 fromQuery 需已有日期参数才识别 custom
  // （无日期时回落 ''），日期输入框因此不出现——custom 档实际只能经带日期的 URL 进入。
  // 此处经 URL 直入 custom 档覆盖日期输入分支。
  window.location.hash = '#/history?range=custom&since_date=2026-01-05';
  const dateInputs = await waitFor(() => {
    const els = document.querySelectorAll('input[type="date"]');
    expect(els.length).toBe(2);
    return els;
  });
  expect(qp(calls).get('since')).toBe(String(new Date('2026-01-05T00:00:00').getTime()));
  fireEvent.change(dateInputs[1]!, { target: { value: '2026-01-09' } });
  await waitFor(() => expect(qp(calls).get('until')).toBe(String(new Date('2026-01-09T23:59:59.999').getTime())));

  // custom 档下切回 preset → since_date/until_date 清空（防双真相）
  fireEvent.click(combo('自定义'));
  fireEvent.click(await screen.findByRole('option', { name: '近 30 天' }));
  // 分层断言：preset 30d → API 带 since（毫秒）；range/since_date/until_date 是 UI 档参数，只进 hash 不进 API
  await waitFor(() => expect(qp(calls).get('since')).toBeTruthy());
  expect(window.location.hash).toContain('range=30d');
  expect(window.location.hash).not.toContain('since_date');
  expect(window.location.hash).not.toContain('until_date');
});

// ── R4：批次聚焦 chip / 说明文案 / 分页 ──

test('批次聚焦 chip：截断展示 + 清除；creator/q 时显示入库维度说明', async () => {
  const calls = setup();
  await screen.findByText('还没有任务记录');
  expect(screen.queryByText(/批次聚焦/)).toBe(null);

  window.location.hash = '#/history?batch_id=abcdef123456&creator=某UP';
  await screen.findByText(/批次聚焦 abcdef12…/);
  expect(screen.getByText(/标题筛选仅覆盖已入库视频的任务/)).toBeInTheDocument();
  expect(qp(calls).get('batch_id')).toBe('abcdef123456');
  fireEvent.click(screen.getByRole('button', { name: '清除批次聚焦' }));
  await waitFor(() => expect(qp(calls).has('batch_id')).toBe(false));
});

test('分页：51 条 → 2 页；下一页写 page=2 重拉', async () => {
  const calls = setup('#/history', () => ({ ok: true, total: 51, items: [task({ id: 1, title: '第一页任务' })] }));
  await screen.findByText('第一页任务');
  expect(screen.getByRole('button', { name: /上一页/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /下一页/ }));
  await waitFor(() => expect(window.location.hash).toBe('#/history?page=2'));
  await waitFor(() => expect(qp(calls).get('page')).toBe('2'));
});

// ── R5：重试 / 删除 ──

test('重试本页未成功：failed+limited 全发 retry 端点；toast 汇总 + reload', async () => {
  const items = [
    task({ id: 1, status: 'succeeded', title: '成功' }),
    task({ id: 2, status: 'failed', title: '失败行', error: 'e' }),
    task({ id: 3, status: 'limited', title: '受限行' }),
  ];
  const calls = setup('#/history', (url, init) => {
    if (url.includes('/retry')) {
      return { ok: true, retried: 2, tasks: [task({ id: 2, status: 'pending' }), task({ id: 3, status: 'succeeded' })] };
    }
    return { ok: true, total: 3, items };
  });
  expect(await screen.findByText('失败行')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /重试本页未成功/ }));
  expect(await screen.findByText(/已重新下发 1 个任务；1 个库内已有字幕，直接标记成功/)).toBeInTheDocument();
  const retryCall = calls.find((c) => c.url.includes('/retry'))!;
  expect(JSON.parse(String(retryCall.init?.body))).toEqual({ ids: [2, 3] });
  // reload：列表再拉一次
  await waitFor(() => expect(calls.filter((c) => c.url.includes('/api/collect-tasks?')).length).toBeGreaterThanOrEqual(2));
});

test('单行重试 + 删除单条 + 批次删除（toast + DELETE URL）', async () => {
  let retried = false;
  const items = () => [
    task({ id: 5, status: 'failed', title: '可重试行', error: 'e' }),
    task({ id: 6, status: 'failed', title: '批次成员甲', batch_id: 'bz', error: 'e' }),
    task({ id: 7, status: 'failed', title: '批次成员乙', batch_id: 'bz', error: 'e' }),
  ];
  const calls = setup('#/history', (url, init) => {
    if (url.includes('/retry')) {
      retried = true;
      return { ok: true, retried: 1, tasks: [task({ id: 5, status: 'pending' })] };
    }
    if (init?.method === 'DELETE') return { ok: true };
    return { ok: true, total: 3, items: items() };
  });
  expect(await screen.findByText('可重试行')).toBeInTheDocument();

  // 单行重试
  fireEvent.click(screen.getByRole('button', { name: '重试采集' }));
  expect(await screen.findByText('已重试 1 个任务（扩展在线即开始采集）')).toBeInTheDocument();
  expect(retried).toBe(true);

  // 删除单条
  fireEvent.click(screen.getByRole('button', { name: '删除任务' }));
  expect(await screen.findByText('已删除任务')).toBeInTheDocument();
  expect(calls.find((c) => c.init?.method === 'DELETE')?.url).toBe('/api/collect-tasks/5');

  // 批次删除（乐观移除后 DELETE×2 + reload）
  fireEvent.click(screen.getByRole('button', { name: '删除整个批次' }));
  expect(await screen.findByText('已删除批次（2 个任务）')).toBeInTheDocument();
  expect(calls.filter((c) => c.init?.method === 'DELETE').length).toBe(3);
});

// ── R6：轮询与通知 ──

test('活跃任务轮询：2s 重拉；转移终态发通知；全终态后轮询停', async () => {
  vi.useFakeTimers();
  const noteCalls: Array<{ title: string; options: unknown }> = [];
  const g = globalThis as any;
  g.Notification = class {
    static permission = 'granted';
    static requestPermission() { return 'granted'; }
    constructor(title: string, options: unknown) { noteCalls.push({ title, options }); }
  };

  let items = [task({ id: 9, status: 'dispatched', title: '轮询任务' })];
  let listFetches = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes('/api/collect-tasks?')) {
      listFetches++;
      return new Response(JSON.stringify({ ok: true, total: items.length, items }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }));

  render(<TasksHistoryPage />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText('轮询任务')).toBeInTheDocument();
  const fetchesAfterMount = listFetches;

  // 轮询一轮：仍 dispatched → 无通知
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(listFetches).toBe(fetchesAfterMount + 1);
  expect(noteCalls).toHaveLength(0);

  // 下一轮：转 succeeded 且无进行中 → 通知
  items = [task({ id: 9, status: 'succeeded', title: '轮询任务', result: JSON.stringify({ tracks: 1 }) })];
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(noteCalls).toHaveLength(1);
  expect(noteCalls[0]!.title).toBe('采集任务已全部完成');
  expect(noteCalls[0]!.options).toMatchObject({ body: '成功 1', tag: 'collect-done' });

  // 全终态 → 轮询停（不再增加请求）
  const afterTerminal = listFetches;
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(listFetches).toBe(afterTerminal);

  delete g.Notification;
});

// ── R7：删除/重试失败分支补口（行覆盖收尾）──

test('单删失败 → 错误 toast + reload 恢复列表', async () => {
  const calls = setup('#/history', (url, init) => {
    if (init?.method === 'DELETE') return new Response(JSON.stringify({ ok: false, error: 'x' }), { status: 500, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/collect-tasks?')) return { ok: true, total: 1, items: [task({ id: 5, status: 'succeeded', title: '还在的行' })] };
    return { ok: true };
  });
  await screen.findByText('还在的行');
  fireEvent.click(screen.getByRole('button', { name: '删除任务' }));
  expect(await screen.findByText('删除失败，已恢复列表')).toBeInTheDocument();
  // 失败分支 reload 重拉真值
  await waitFor(() => expect(calls.filter((c) => c.url.includes('/api/collect-tasks?')).length).toBeGreaterThanOrEqual(2));
});

test('批次删除部分失败 → 失败计数 toast；单成员批次行可单独删', async () => {
  const items = () => [
    task({ id: 6, status: 'succeeded', title: '单成员批次行', batch_id: 'solo' }),
    task({ id: 7, status: 'succeeded', title: '批次甲', batch_id: 'b1' }),
    task({ id: 8, status: 'succeeded', title: '批次乙', batch_id: 'b1' }),
  ];
  let failId: number | null = null;
  setup('#/history', (url, init) => {
    if (init?.method === 'DELETE') {
      const id = Number(new URL(url, 'http://x').pathname.split('/').pop());
      if (id === failId) return new Response(JSON.stringify({ ok: false, error: 'x' }), { status: 500, headers: { 'content-type': 'application/json' } });
      return { ok: true };
    }
    if (url.includes('/api/collect-tasks?')) return { ok: true, total: 3, items: items() };
    return { ok: true };
  });
  // 多成员批次 b1 → 聚合组头（成员标题折叠不逐行显示）
  await screen.findByText('批量采集 · 2 个视频');

  // 单成员批次（members.length===1）→ 渲染为 TaskRow，删除按钮走批次行 onDelete 回调
  fireEvent.click(screen.getByRole('button', { name: '删除任务' }));
  expect(await screen.findByText('已删除任务')).toBeInTheDocument();

  // 批次删除部分失败：7 成功 / 8 失败
  failId = 8;
  fireEvent.click(screen.getByRole('button', { name: '删除整个批次' }));
  expect(await screen.findByText('删除批次完成（失败 1 个，已恢复列表）')).toBeInTheDocument();
});

test('单行重试失败 → 重试失败 toast + reload', async () => {
  const calls = setup('#/history', (url, init) => {
    if (url.includes('/retry')) return new Response(JSON.stringify({ ok: false, error: 'server down' }), { status: 500, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/collect-tasks?')) return { ok: true, total: 1, items: [task({ id: 5, status: 'failed', title: '失败任务A', error: 'e' })] };
    return { ok: true };
  });
  await screen.findByText('失败任务A');
  fireEvent.click(screen.getByRole('button', { name: '重试采集' }));
  expect(await screen.findByText(/重试失败：/)).toBeInTheDocument();
  await waitFor(() => expect(calls.filter((c) => c.url.includes('/api/collect-tasks?')).length).toBeGreaterThanOrEqual(2));
});
