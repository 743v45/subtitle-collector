// RecentJobs 单测：最近 jobs 轻量台账（listJobs({limit:10}) 折叠列表 + 行内展开 JobCard）。
// 覆盖：默认折叠零请求、首次展开才拉取（query 带 limit=10）、行展开挂 JobCard（终态停轮）、
// 展开互斥（单开）、刷新手动重拉、收起再展开走缓存不重拉、空态、错误红字。
// 跑法：npx vitest run src/components/RecentJobs.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 折叠/拉取/展开/互斥/刷新/缓存/空态/错误 八例 | 通过 | 2026-10 Phase 4 |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { RecentJobs } from './RecentJobs';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Call { url: string; init?: RequestInit }

function stubFetch(handler: (url: string) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    calls.push({ url, init });
    const r = await handler(url);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

// server 直回原始形态（*_json 字符串）；两行都非终态，终态文案「已完成」只可能来自展开的 JobCard
const listRows = [
  {
    id: 7, type: 'asr-backfill', status: 'running',
    params_json: '{"source":"bilibili","size":5}', progress_json: '{"done":1,"total":5}',
    result_json: null, error: null,
    created_at: 1_760_000_000_000, updated_at: 1_760_000_000_000, started_at: 1_760_000_000_000, finished_at: null,
  },
  {
    id: 8, type: 'collect-find', status: 'pending',
    params_json: '{"keyword":"加息"}', progress_json: null,
    result_json: null, error: null,
    created_at: 1_760_000_000_000, updated_at: 1_760_000_000_000, started_at: null, finished_at: null,
  },
];

const doneRow = {
  ...listRows[0]!, status: 'done', finished_at: 1_760_000_100_000,
  result_json: '{"circled":5,"done":4,"failed":{"need_login":1}}',
};

function listHandler(jobOver?: (url: string) => unknown) {
  return (url: string): unknown => {
    if (url === '/api/jobs?limit=10') return { ok: true, items: listRows };
    if (/\/api\/jobs\/\d+$/.test(url)) return jobOver ? jobOver(url) : { ok: true, job: doneRow };
    return {};
  };
}

function listCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.url === '/api/jobs?limit=10');
}

// ── 折叠与拉取 ──

test('默认折叠：渲染零请求，无刷新按钮无列表内容', () => {
  const calls = stubFetch(listHandler());
  render(<RecentJobs />);
  expect(calls).toHaveLength(0);
  expect(screen.getByRole('button', { name: '最近任务折叠开关' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '刷新' })).toBe(null);
  expect(screen.queryByText('暂无任务')).toBe(null);
});

test('首次展开才拉取：GET /api/jobs?limit=10，行渲染类型中文+#id+徽章；收起再展开走缓存不重拉', async () => {
  const calls = stubFetch(listHandler());
  render(<RecentJobs />);
  fireEvent.click(screen.getByRole('button', { name: '最近任务折叠开关' }));
  expect(await screen.findByText('#7')).toBeInTheDocument();
  expect(screen.getByText('#8')).toBeInTheDocument();
  expect(screen.getByText('ASR 转写')).toBeInTheDocument(); // 类型中文标签
  expect(screen.getByText('运行中')).toBeInTheDocument();   // 行内 StatusBadge
  expect(screen.getByRole('button', { name: '最近任务折叠开关' })).toHaveAttribute('aria-expanded', 'true');
  expect(listCalls(calls)).toHaveLength(1);

  // 收起再展开：items 已缓存，不重拉
  fireEvent.click(screen.getByRole('button', { name: '最近任务折叠开关' })); // 收起
  expect(screen.queryByText('#7')).toBe(null);
  fireEvent.click(screen.getByRole('button', { name: '最近任务折叠开关' })); // 再展开
  expect(await screen.findByText('#7')).toBeInTheDocument();
  expect(listCalls(calls)).toHaveLength(1);
});

// ── 行展开 JobCard ──

test('行展开：内联 JobCard 挂载自取（GET /api/jobs/:id）渲染终态汇总；再点同行收起、两行互斥单开', async () => {
  const calls = stubFetch(listHandler());
  render(<RecentJobs />);
  fireEvent.click(screen.getByRole('button', { name: '最近任务折叠开关' }));
  await screen.findByText('#7');
  fireEvent.click(screen.getByRole('button', { name: '展开任务 #7' }));
  expect(await screen.findByText('圈定 5 · 成功 4 · 失败 need_login 1')).toBeInTheDocument(); // JobCard done 汇总
  expect(calls.some((c) => c.url === '/api/jobs/7')).toBe(true);
  // 「已完成」只来自展开的 JobCard（列表两行均非终态）
  expect(screen.getByText('已完成')).toBeInTheDocument();

  // 再点同行：收起（toggle 关分支）
  fireEvent.click(screen.getByRole('button', { name: '展开任务 #7' }));
  await waitFor(() => expect(screen.queryByText('圈定 5 · 成功 4 · 失败 need_login 1')).toBe(null));
  expect(screen.queryByRole('button', { name: '展开任务 #7' })).toHaveAttribute('aria-expanded', 'false');

  // 互斥单开：点开 #8 后 #7 保持收起
  fireEvent.click(screen.getByRole('button', { name: '展开任务 #8' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '展开任务 #8' })).toHaveAttribute('aria-expanded', 'true'));
  expect(screen.queryByRole('button', { name: '展开任务 #7' })).toHaveAttribute('aria-expanded', 'false');
});

// ── 刷新 ──

test('刷新按钮：手动重拉一次（共 2 次 list 调用）', async () => {
  const calls = stubFetch(listHandler());
  render(<RecentJobs />);
  fireEvent.click(screen.getByRole('button', { name: '最近任务折叠开关' }));
  await screen.findByText('#7');
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
  expect(screen.getByText('#7')).toBeInTheDocument(); // 重拉后行仍在
});

// ── 空态与错误 ──

test('空台账：展开后「暂无任务」', async () => {
  stubFetch((url) => (url === '/api/jobs?limit=10' ? { ok: true, items: [] } : {}));
  render(<RecentJobs />);
  fireEvent.click(screen.getByRole('button', { name: '最近任务折叠开关' }));
  expect(await screen.findByText('暂无任务')).toBeInTheDocument();
});

test('列表加载失败：红字透出 server 文案（role=alert），无行渲染', async () => {
  stubFetch(() => new Response(JSON.stringify({ ok: false, error: 'db down' }), { status: 500, headers: { 'content-type': 'application/json' } }));
  render(<RecentJobs />);
  fireEvent.click(screen.getByRole('button', { name: '最近任务折叠开关' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('加载失败：HTTP 500：db down');
  expect(screen.queryByText('#7')).toBe(null);
});
