// CollectPage 页面组件单测：提交（POST+toast+refresh）、删除（单条乐观删/批次级联删/失败恢复）、
// 重试（retry 端点 toast）、批次聚合渲染、库摘要行、按 UP 批量（解析/过滤/勾选/批量建任务/
// >50 confirm/缺数据计数）、2s 轮询与完成通知（fake timers + Notification stub）。
// 跑法：npx vitest run src/pages/CollectPage.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 初始加载 + 空态 + 库摘要（点击进看板）；单任务/批次聚合/单成员批次回落 TaskRow | 通过 | |
// | R2 | 提交（点击/Enter/失败）；删除单条（成功/失败恢复）；批次级联删（全成功/部分失败） | 通过 | 包 ToastProvider 断言文案 |
// | R3 | 重试：成功 toast（dispatched/alreadyOk 组合）与失败 toast | 通过 | |
// | R4 | 按 UP 批量：mid/链接解析、非法输入、过滤 pill（状态/时间/播放）、全选未采、勾选、批量提交、>50 confirm 双分支、缺播放/日期计数 | 通过 | Date.now 真实时间构造数据 |
// | R5 | 轮询：pending → 2s 后重拉 → succeeded 转移发系统通知 + 摘要行刷新 | 通过 | fake timers + advanceTimersByTimeAsync + Notification stub |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { CollectPage } from './CollectPage';
import { ToastProvider } from '@/components/ui/toast';
import type { CollectTask } from '../types';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

function task(p: Partial<CollectTask> & { id: number }): CollectTask {
  return {
    source: 'bilibili',
    source_vid: `BV1cp${p.id}`,
    url: `https://www.bilibili.com/video/BV1cp${p.id}`,
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

const overview = { videos: 12, tracks: 34, versions: 56, creators: 2, languages: 3, categories: 1, today_videos: 5, first_seen_min: 0, first_seen_max: 1 };

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const r = handler(url, init);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

// 列表 + 摘要 的基础路由；list()/overview() 可换状态
function baseHandler(list: () => CollectTask[] = () => [], over: () => unknown = () => overview) {
  return (url: string, init?: RequestInit) => {
    if (url.includes('/api/collect-tasks?limit=')) return { ok: true, total: list().length, items: list() };
    if (url.includes('/api/stats?type=overview')) return { ok: true, total: over(), by_source: {} };
    return { ok: true };
  };
}

function setup(list: () => CollectTask[] = () => [], handler = baseHandler(list)) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <ToastProvider>
      <CollectPage />
    </ToastProvider>,
  );
  return calls;
}

function listCalls(calls: Array<{ url: string }>) {
  return calls.filter((c) => c.url.includes('/api/collect-tasks?limit='));
}

// ── R1：初始加载 ──

test('空态：还没有采集任务 + 库摘要行（点击进看板）', async () => {
  setup();
  expect(await screen.findByText('还没有采集任务。粘贴一个视频链接试试。')).toBeInTheDocument();
  const summary = screen.getByRole('button', { name: /库内 12 视频 · 34 字幕轨/ });
  expect(summary.getAttribute('name') ?? summary.textContent).toBeTruthy();
  expect(summary.textContent).toContain('今日 +5');
  fireEvent.click(summary);
  expect(window.location.hash).toBe('#/stats');
});

test('任务渲染：单任务卡 / 批次聚合卡 / 单成员批次回落 TaskRow；进行中提示', async () => {
  setup(() => [
    task({ id: 1, status: 'pending', title: '单任务' }),
    task({ id: 2, status: 'succeeded', title: '批量成员一', batch_id: 'b1' }),
    task({ id: 3, status: 'failed', title: '批量成员二', batch_id: 'b1', error: 'boom' }),
    task({ id: 4, status: 'succeeded', title: '独苗批次', batch_id: 'b2' }),
  ]);
  expect(await screen.findByText('单任务')).toBeInTheDocument();
  expect(screen.getByText(/批量采集 · 2 个视频/)).toBeInTheDocument();
  expect(screen.getByText('完成 1 失败 1')).toBeInTheDocument();
  // 单成员批次 b2 → TaskRow（无批次卡）
  expect(screen.getByText('独苗批次')).toBeInTheDocument();
  expect(screen.queryByText(/批量采集 · 1 个视频/)).toBe(null);
  // 有 pending → 进行中提示
  expect(screen.getByText(/有任务进行中,每 2s 自动刷新/)).toBeInTheDocument();
  expect(screen.getByText('4 条任务')).toBeInTheDocument();
});

// ── R2：提交 / 删除 ──

test('提交：输入 → 采集 → POST + toast + 输入清空 + 立即 refresh', async () => {
  const calls = setup();
  await screen.findByText('还没有采集任务。粘贴一个视频链接试试。');
  const input = screen.getByPlaceholderText('粘贴视频链接或分享文本（B站 / YouTube）');
  fireEvent.change(input, { target: { value: 'https://www.bilibili.com/video/BV1cp1' } });
  fireEvent.click(screen.getByRole('button', { name: '采集' }));
  expect(await screen.findByText('已提交采集任务')).toBeInTheDocument();
  expect((input as HTMLInputElement).value).toBe('');
  const post = calls.find((c) => c.url === '/api/collect-tasks');
  expect(post?.init?.method).toBe('POST');
  expect(JSON.parse(String(post?.init?.body))).toEqual({ text: 'https://www.bilibili.com/video/BV1cp1' });
  expect(listCalls(calls).length).toBeGreaterThanOrEqual(2); // 初始 + 提交后 refresh
});

test('提交：Enter 触发；失败 → 错误提示 + toast，输入保留', async () => {
  const calls = setup(() => [], (url, init) => {
    if (url === '/api/collect-tasks' && init?.method === 'POST') {
      return new Response(JSON.stringify({ ok: false, error: '链接无法识别' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return baseHandler()(url, init);
  });
  await screen.findByText('还没有采集任务。粘贴一个视频链接试试。');
  const input = screen.getByPlaceholderText('粘贴视频链接或分享文本（B站 / YouTube）');
  fireEvent.change(input, { target: { value: '随便写' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByText(/提交失败：HTTP 400：链接无法识别/)).toBeInTheDocument();
  expect((input as HTMLInputElement).value).toBe('随便写');
  expect(calls.filter((c) => c.url === '/api/collect-tasks').length).toBe(1);
});

test('删除单条：失败 → 行恢复 + toast；成功 → 乐观移除 + toast', async () => {
  let deleteFails = true;
  const calls = setup(() => [task({ id: 7, status: 'succeeded', title: '待删任务' })], (url, init) => {
    if (init?.method === 'DELETE') {
      return deleteFails
        ? new Response(JSON.stringify({ ok: false, error: 'x' }), { status: 500, headers: { 'content-type': 'application/json' } })
        : { ok: true };
    }
    return baseHandler(() => [task({ id: 7, status: 'succeeded', title: '待删任务' })])(url, init);
  });
  expect(await screen.findByText('待删任务')).toBeInTheDocument();

  // 失败路径：乐观移除后 DELETE 500 → refresh 拉回真值，行恢复
  fireEvent.click(screen.getByRole('button', { name: '删除任务' }));
  expect(await screen.findByText('删除失败，已恢复列表')).toBeInTheDocument();
  expect(await screen.findByText('待删任务')).toBeInTheDocument();
  expect(listCalls(calls).length).toBeGreaterThanOrEqual(2);

  // 成功路径：行移除 + DELETE 命中正确 URL
  deleteFails = false;
  fireEvent.click(screen.getByRole('button', { name: '删除任务' }));
  expect(await screen.findByText('已删除任务')).toBeInTheDocument();
  expect(calls.find((c) => c.init?.method === 'DELETE')?.url).toBe('/api/collect-tasks/7');
  await waitFor(() => expect(screen.queryByText('待删任务')).toBe(null));
});

test('删除批次：级联删全部成员 → 成功 toast；部分失败 → 失败计数 toast + refresh', async () => {
  let failedOnce = false;
  const members = () => [task({ id: 1, batch_id: 'bx', title: '甲' }), task({ id: 2, batch_id: 'bx', title: '乙' })];
  const calls = setup(members, (url, init) => {
    if (init?.method === 'DELETE') {
      if (!failedOnce && url.endsWith('/2')) { failedOnce = true; return new Response('{"ok":false}', { status: 500 }); }
      return { ok: true };
    }
    return baseHandler(members)(url, init);
  });
  expect(await screen.findByText(/批量采集 · 2 个视频/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '删除整个批次' }));
  expect(await screen.findByText(/删除批次完成（失败 1 个，已恢复列表）/)).toBeInTheDocument();
  expect(calls.filter((c) => c.init?.method === 'DELETE').length).toBe(2);

  // 全成功路径
  cleanup();
  vi.unstubAllGlobals();
  const calls2 = setup(members, (url, init) => {
    if (init?.method === 'DELETE') return { ok: true };
    return baseHandler(members)(url, init);
  });
  expect(await screen.findByText(/批量采集 · 2 个视频/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '删除整个批次' }));
  expect(await screen.findByText('已删除批次（2 个任务）')).toBeInTheDocument();
  expect(listCalls(calls2).length).toBeGreaterThanOrEqual(2);
});

// ── R3：重试 ──

test('重试：retry 端点 → toast 汇总；失败 → 错误 toast + refresh', async () => {
  const calls = setup(() => [task({ id: 9, status: 'failed', title: '失败任务', error: 'e' })], (url, init) => {
    if (url.includes('/api/collect-tasks/retry')) {
      return { ok: true, retried: 1, tasks: [task({ id: 9, status: 'pending' })] };
    }
    return baseHandler(() => [task({ id: 9, status: 'failed', title: '失败任务', error: 'e' })])(url, init);
  });
  expect(await screen.findByText('失败任务')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试采集' }));
  expect(await screen.findByText('已重试 1 个任务（扩展在线即开始采集）')).toBeInTheDocument();
  expect(calls.find((c) => c.url.includes('/retry'))?.init?.method).toBe('POST');
  expect(JSON.parse(String(calls.find((c) => c.url.includes('/retry'))?.init?.body))).toEqual({ ids: [9] });

  // 失败路径
  cleanup();
  vi.unstubAllGlobals();
  setup(() => [task({ id: 9, status: 'failed', title: '失败任务', error: 'e' })], (url, init) => {
    if (url.includes('/retry')) return new Response(JSON.stringify({ ok: false, error: 'server down' }), { status: 500, headers: { 'content-type': 'application/json' } });
    return baseHandler(() => [task({ id: 9, status: 'failed', title: '失败任务', error: 'e' })])(url, init);
  });
  expect(await screen.findByText('失败任务')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试采集' }));
  expect(await screen.findByText(/重试失败：/)).toBeInTheDocument();
});

// ── R4：按 UP 批量 ──

const upperItems = [
  { bvid: 'BV1a', title: '已采视频', created: Math.floor(Date.now() / 1000) - 86400 * 3, play: 5000, length: '10:00', pic: 'https://pic/x.jpg', collected: true },
  { bvid: 'BV1b', title: '未采新视频', created: Math.floor(Date.now() / 1000) - 86400 * 10, play: 1500, length: '05:30', pic: null, collected: false },
  { bvid: 'BV1c', title: '老视频', created: Math.floor(Date.now() / 1000) - 86400 * 400, play: 200000, length: null, pic: null, collected: false },
  { bvid: 'BV1d', title: '缺数据视频', created: null, play: null, length: '01:00', pic: null, collected: false },
];

function setupUpper(expand: unknown = { total: 4, items: upperItems }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    let r: unknown;
    if (url.includes('/api/upper-videos/expand')) r = expand;
    else if (url.includes('/api/collect-tasks/batch')) r = { ok: true, created: 2, skipped: 1 };
    else r = baseHandler()(url, init);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(
    <ToastProvider>
      <CollectPage />
    </ToastProvider>,
  );
  return calls;
}

test('按 UP 批量：非法输入 → 提示不发请求；数字 UID / 空间链接都能解析', async () => {
  const calls = setupUpper();
  await screen.findByText('还没有采集任务。粘贴一个视频链接试试。');
  const upperInput = screen.getByPlaceholderText('B 站 UID / 空间链接，或 YouTube 频道 @handle / UC… / 频道页链接（需桌面扩展在线）');
  fireEvent.change(upperInput, { target: { value: '不是UID' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取' }));
  expect(await screen.findByText('输入 UP 的数字 UID / 空间页链接，或 YouTube 频道 @handle / UC 开头 ID / 频道页链接')).toBeInTheDocument();
  expect(calls.find((c) => c.url.includes('expand'))).toBe(undefined);

  fireEvent.change(upperInput, { target: { value: 'https://space.bilibili.com/296399504/upload/video' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取' }));
  expect(await screen.findByText('已采视频')).toBeInTheDocument();
  const expandCall = calls.find((c) => c.url.includes('expand'))!;
  expect(expandCall.init?.method).toBe('POST');
  expect(JSON.parse(String(expandCall.init?.body))).toEqual({ source: 'bilibili', mid: '296399504' });
});

test('按 UP 批量：拉取失败 → 错误文案；列表渲染（摘要/过滤 pill/封面占位/日期）', async () => {
  setupUpper(new Response(JSON.stringify({ ok: false, error: '扩展离线' }), { status: 503, headers: { 'content-type': 'application/json' } }));
  await screen.findByText('还没有采集任务。粘贴一个视频链接试试。');
  fireEvent.change(screen.getByPlaceholderText('B 站 UID / 空间链接，或 YouTube 频道 @handle / UC… / 频道页链接（需桌面扩展在线）'), { target: { value: '296399504' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取' }));
  expect(await screen.findByText(/扩展离线/)).toBeInTheDocument();

  cleanup();
  vi.unstubAllGlobals();
  const calls = setupUpper();
  await screen.findByText('还没有采集任务。粘贴一个视频链接试试。');
  fireEvent.change(screen.getByPlaceholderText('B 站 UID / 空间链接，或 YouTube 频道 @handle / UC… / 频道页链接（需桌面扩展在线）'), { target: { value: '296399504' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取' }));
  expect(await screen.findByText('已采视频')).toBeInTheDocument();
  // 摘要行数据经 pill 名断言（共 4 条文本跨嵌套 span，不适合 getByText）
  expect(screen.getByRole('button', { name: '全部 4' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /未采 3/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /已采 1/ })).toBeInTheDocument();
  expect(document.querySelector('img[src="https://pic/x.jpg"]')).not.toBe(null); // 有 pic
  expect(screen.getByTitle('字幕已采集')).toBeInTheDocument();
  expect(screen.getAllByTitle('未采集').length).toBe(3); // 三个未采条目的状态点
});

test('按 UP 批量：过滤 pill 组合（状态/时间/播放）与缺数据计数', async () => {
  const calls = setupUpper();
  await screen.findByText('还没有采集任务。粘贴一个视频链接试试。');
  fireEvent.change(screen.getByPlaceholderText('B 站 UID / 空间链接，或 YouTube 频道 @handle / UC… / 频道页链接（需桌面扩展在线）'), { target: { value: '296399504' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取' }));
  expect(await screen.findByText('已采视频')).toBeInTheDocument();

  // 状态：未采 → 只剩 3 条
  fireEvent.click(screen.getByRole('button', { name: /未采 3/ }));
  expect(screen.queryByText('已采视频')).toBe(null);
  expect(screen.getByText('未采新视频')).toBeInTheDocument();
  // 已采 → 只剩 1
  fireEvent.click(screen.getByRole('button', { name: /已采 1/ }));
  expect(screen.getByText('已采视频')).toBeInTheDocument();
  expect(screen.queryByText('未采新视频')).toBe(null);
  fireEvent.click(screen.getByRole('button', { name: /全部 4/ }));

  // 时间：近半年 → 排除 400 天前的老视频
  fireEvent.click(screen.getByRole('button', { name: '近半年' }));
  expect(screen.queryByTitle('老视频')).toBe(null);
  expect(screen.getByText('已采视频')).toBeInTheDocument();
  // 播放 10万+ → 只剩老视频（200000）——但时间已过滤，先关时间
  fireEvent.click(screen.getByRole('button', { name: '近半年' }));
  fireEvent.click(screen.getByRole('button', { name: '10万+' }));
  expect(screen.getByTitle('老视频')).toBeInTheDocument();
  expect(screen.queryByText('已采视频')).toBe(null);

  // 缺数据：时间+播放全开 → BV1d 被排除计 missing；无匹配提示
  fireEvent.click(screen.getByRole('button', { name: '近一年' }));
  fireEvent.click(screen.getByRole('button', { name: '1万+' }));
  expect(screen.getByText(/无匹配视频（调整过滤条件；另有 1 条缺播放量\/日期未纳入）/)).toBeInTheDocument();

  // 有结果 + 缺数据并存提示
  fireEvent.click(screen.getByRole('button', { name: '近一年' })); // 关时间
  fireEvent.click(screen.getByRole('button', { name: '1千+' }));
  expect(screen.getByText('已采视频')).toBeInTheDocument();
  expect(screen.getByText(/另有 1 条缺播放量\/日期未纳入过滤/)).toBeInTheDocument();
});

test('按 UP 批量：勾选 + 全选未采 + 批量提交（POST vids/source/creator_uid + toast）', async () => {
  const calls = setupUpper();
  await screen.findByText('还没有采集任务。粘贴一个视频链接试试。');
  fireEvent.change(screen.getByPlaceholderText('B 站 UID / 空间链接，或 YouTube 频道 @handle / UC… / 频道页链接（需桌面扩展在线）'), { target: { value: '296399504' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取' }));
  expect(await screen.findByText('已采视频')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '全选未采' }));
  expect(screen.getByRole('button', { name: /批量采集 \(3\)/ })).toBeInTheDocument();
  // 反选一个
  const cb = screen.getAllByRole('checkbox')[1]!; // BV1b
  fireEvent.click(cb);
  expect(screen.getByRole('button', { name: /批量采集 \(2\)/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /批量采集/ }));
  // 文案同时出现在 submitMsg 行与 toast（getAllBy 断言至少一处）
  expect((await screen.findAllByText(/已创建 2 个任务，跳过 1 个（已在队列）/)).length).toBeGreaterThanOrEqual(1);
  const batchCall = calls.find((c) => c.url.includes('/api/collect-tasks/batch'))!;
  expect(JSON.parse(String(batchCall.init?.body))).toEqual({ vids: ['BV1c', 'BV1d'], source: 'bilibili', creator_uid: '296399504' });
});

test('按 UP 批量：批量提交失败 → 错误 toast；>50 confirm 取消/确认', async () => {
  const many = Array.from({ length: 51 }, (_, i) => ({
    bvid: `BV${i}`, title: `视频${i}`, created: null, play: null, length: null, pic: null, collected: false,
  }));
  const calls = setupUpper({ total: 51, items: many });
  await screen.findByText('还没有采集任务。粘贴一个视频链接试试。');
  fireEvent.change(screen.getByPlaceholderText('B 站 UID / 空间链接，或 YouTube 频道 @handle / UC… / 频道页链接（需桌面扩展在线）'), { target: { value: '296399504' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取' }));
  expect(await screen.findByText('视频0')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '全选未采' }));

  // confirm=false → 中止，不发 batch
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: /批量采集/ }));
  expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/将创建 51 个采集任务/));
  expect(calls.find((c) => c.url.includes('/batch'))).toBe(undefined);

  // confirm=true → 提交；失败分支 → 错误 toast
  confirmSpy.mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/batch')) {
      return new Response(JSON.stringify({ ok: false, error: 'queue full' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/api/collect-tasks?limit=')) return new Response(JSON.stringify({ ok: true, total: 0, items: [] }), { headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/stats?type=overview')) return new Response(JSON.stringify({ ok: true, total: overview, by_source: {} }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }));
  fireEvent.click(screen.getByRole('button', { name: /批量采集/ }));
  expect(await screen.findByText(/批量提交失败：HTTP 500：queue full/)).toBeInTheDocument();
});

// ── R5：轮询与完成通知 ──

test('轮询：2s 重拉；pending→succeeded 全终态 → 系统通知 + 摘要行刷新', async () => {
  vi.useFakeTimers();
  const noteCalls: Array<{ title: string; options: unknown }> = [];
  const g = globalThis as any;
  const FakeNotification = class {
    static permission = 'granted';
    static requestPermission() { return 'granted'; }
    constructor(title: string, options: unknown) { noteCalls.push({ title, options }); }
  };
  g.Notification = FakeNotification;

  let list = [task({ id: 5, status: 'pending', title: '轮询任务' })];
  let overviewCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes('/api/collect-tasks?limit=')) {
      return new Response(JSON.stringify({ ok: true, total: list.length, items: list }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/api/stats?type=overview')) {
      overviewCalls++;
      return new Response(JSON.stringify({ ok: true, total: { ...overview, videos: 12 + overviewCalls - 1 }, by_source: {} }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }));

  render(<CollectPage />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText('轮询任务')).toBeInTheDocument();
  const overviewBefore = overviewCalls;

  // 轮询一轮：状态没变 → 无通知
  list = [task({ id: 5, status: 'pending', title: '轮询任务' })];
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(noteCalls).toHaveLength(0);

  // 下一轮：转 succeeded 且无进行中 → 通知 + 摘要刷新
  list = [task({ id: 5, status: 'succeeded', title: '轮询任务', result: JSON.stringify({ tracks: 2 }) })];
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('已完成')).toBeInTheDocument();
  expect(noteCalls).toHaveLength(1);
  expect(noteCalls[0]!.title).toBe('采集任务已全部完成');
  expect(overviewCalls).toBe(overviewBefore + 1);
  expect(screen.getByRole('button', { name: /库内 13 视频/ })).toBeInTheDocument();

  delete g.Notification;
});

// ── YouTube 频道批量（2026-08-24）：@handle 展开 → 频道名/列表渲染 → 勾选批量提交（source/creator_uid 跟随）──
test('YouTube 频道批量：@handle 展开 + 频道名摘要 + 批量提交 source=youtube/creator_uid=channelId', async () => {
  const calls = setupUpper({ total: 2, channel: { id: 'UCtest_channel_id_000001', name: '测试频道' }, items: [
    { bvid: 'ytvid00001', title: '频道视频一', created: 1700000000, play: 10, length: '1:00', pic: null, collected: false },
    { bvid: 'ytvid00002', title: '频道视频二', created: null, play: null, length: null, pic: null, collected: true },
  ] });
  await screen.findByText('还没有采集任务。粘贴一个视频链接试试。');
  fireEvent.change(screen.getByPlaceholderText(/YouTube 频道/), { target: { value: '@testch' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取' }));
  // 频道名进摘要行；列表渲染（摘要行文本拆多个 span，用子串断言；total 由 items/body 断言覆盖）
  expect(await screen.findByText(/测试频道 ·/)).toBeInTheDocument();
  expect(screen.getByText('频道视频一')).toBeInTheDocument();
  expect(screen.getByText('频道视频一')).toBeInTheDocument();
  // 展开请求体：平台 + 原始频道输入透传（细解析在 server）
  const expandCall = calls.find((c) => c.url.includes('expand'))!;
  expect(JSON.parse(String(expandCall.init?.body))).toEqual({ source: 'youtube', channel: '@testch' });

  // 频道页 URL 也路由到 YouTube（60-61 分支：youtube.com 域名识别）
  fireEvent.change(screen.getByPlaceholderText(/YouTube 频道/), { target: { value: 'https://www.youtube.com/@testch/videos' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取' }));
  expect(await screen.findByText(/测试频道 ·/)).toBeInTheDocument();
  expect(JSON.parse(String(calls.filter((c) => c.url.includes('expand')).at(-1)!.init?.body))).toEqual({ source: 'youtube', channel: 'https://www.youtube.com/@testch/videos' });

  // 勾选未采视频 → 批量提交：vids 按 YouTube ID、source=youtube、creator_uid=channelId（展开回执）
  fireEvent.click(screen.getAllByRole('checkbox')[0]!); // ytvid00001（未采）
  fireEvent.click(screen.getByRole('button', { name: /批量采集/ }));
  // 文案在 submitMsg 行与 toast 双份（对齐既有用例），完整串含跳过数
  expect((await screen.findAllByText(/已创建 2 个任务，跳过 1 个（已在队列）/)).length).toBeGreaterThanOrEqual(1);
  const batchCall = calls.find((c) => c.url.includes('/api/collect-tasks/batch'))!;
  expect(JSON.parse(String(batchCall.init?.body))).toEqual({
    vids: ['ytvid00001'],
    source: 'youtube',
    creator_uid: 'UCtest_channel_id_000001',
  });
});

// ── 已采跳过与强制重采（2026-08-25）：server 侧默认跳过有轨入库，勾选「强制重采」带 force ──
test('批量提交：已采跳过计数提示；勾选强制重采 → body 带 force:true', async () => {
  setupUpper();
  await screen.findByText('还没有采集任务。粘贴一个视频链接试试。');
  fireEvent.change(screen.getByPlaceholderText(/B 站 UID/), { target: { value: '296399504' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取' }));
  expect(await screen.findByText('已采视频')).toBeInTheDocument();

  // 勾选含已采视频 → 默认提交（无 force）：文案带「已采跳过」提示（mock skipped_collected=1）
  vi.unstubAllGlobals();
  const calls2: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    calls2.push({ url, init });
    if (url.includes('/api/collect-tasks/batch')) {
      return new Response(JSON.stringify({ ok: true, created: 1, skipped: 0, skipped_collected: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const r = baseHandler()(url, init);
    return r instanceof Response ? r : new Response(JSON.stringify(r ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  // 全选未采 + 手动勾一个已采 → 提交
  fireEvent.click(screen.getByRole('button', { name: '全选未采' }));
  fireEvent.click(screen.getAllByRole('checkbox')[0]!); // 补勾已采的第一条
  fireEvent.click(screen.getByRole('button', { name: /批量采集/ }));
  expect((await screen.findAllByText(/已采跳过 1 个/)).length).toBeGreaterThanOrEqual(1);
  const batch1 = calls2.find((c) => c.url.includes('/api/collect-tasks/batch'))!;
  expect(JSON.parse(String(batch1.init?.body)).force).toBe(undefined);

  // 勾选「强制重采」再提交 → body 带 force:true
  fireEvent.click(screen.getByRole('button', { name: '全选未采' }));
  fireEvent.click(screen.getByLabelText(/强制重采/));
  fireEvent.click(screen.getByRole('button', { name: /批量采集/ }));
  await waitFor(() => {
    const batches = calls2.filter((c) => c.url.includes('/api/collect-tasks/batch'));
    const last = batches.at(-1)!;
    expect(JSON.parse(String(last.init?.body)).force).toBe(true);
  });
});
