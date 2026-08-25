// CreatorsPage 测试：列表渲染 / 搜索防抖 300ms / 槽位三态筛选（全部/Agent/人工）/ 分类筛选 / 排序 / 分页 / 行内分类变更 / 空错态。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 渲染 + 防抖 + URL 筛选流 + Select 分类变更 + 空错态 | 通过 | 防抖 fake timers；输入期间防抖未触发 |
// | R2 | 值域合一（2026-08-25）：三态槽位筛选；分类下拉一套；cat 筛选请求不带 scope | 通过 | 缺省从 human 改「全部」 |
import { test, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { CreatorsPage } from './CreatorsPage';
import type { CreatorListItem, } from '@/api';
import type { Category } from '@/api';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

function creatorItem(id: number, p: Partial<CreatorListItem> = {}): CreatorListItem {
  return {
    id, source: 'bilibili', source_uid: String(1000 + id), name: `UP${id}`, avatar: null,
    fans: 100 * id, video_count: id, category_agent_id: null, category_agent_name: null,
    category_human_id: null, category_human_name: null, first_seen_at: 1,
    ...p,
  };
}
// 值域合一：一套分类，Agent/人工两个下拉共用
const CATS: Category[] = [
  { id: 1, name: '科技', sort_order: 1, created_at: 1, creator_count: 0 },
  { id: 3, name: '优质', sort_order: 2, created_at: 1, creator_count: 0 },
];

function defaultRoutes(items: CreatorListItem[] = [creatorItem(1), creatorItem(2)], total = items.length) {
  return (url: string): Response | null => {
    if (url.startsWith('/api/creators?')) return ok({ total, items });
    if (url === '/api/categories') return ok({ items: CATS });
    return null;
  };
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  (window.HTMLElement.prototype as any).hasPointerCapture = vi.fn(() => false);
  (window.HTMLElement.prototype as any).releasePointerCapture = vi.fn();
});
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes()(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error(`unmatched: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '#/creators');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('渲染：行数据（名称/uid/粉丝千分位/视频数）+ 行点击 onOpen + 外链', async () => {
  const onOpen = vi.fn();
  render(<ToastProvider><CreatorsPage onOpen={onOpen} /></ToastProvider>);
  expect(await screen.findByText('UP1')).toBeInTheDocument();
  expect(screen.getByText('UP2')).toBeInTheDocument();
  expect(screen.getByText('1001')).toBeInTheDocument(); // source_uid（不做千分位）
  expect(screen.getByText('100')).toBeInTheDocument();   // fans（UP1）
  expect(screen.getByRole('link', { name: '在原站打开 UP1 的空间' })).toHaveAttribute('href', 'https://space.bilibili.com/1001');
  fireEvent.click(screen.getByText('UP2'));
  expect(onOpen).toHaveBeenCalledWith(2);
  expect(screen.getByText('共 2 条')).toBeInTheDocument();
});

test('未分类占位与 fans null → —；名称 null → (未知)', async () => {
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes([creatorItem(1, { name: null, fans: null })])(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  expect(await screen.findByText('(未知)')).toBeInTheDocument();
  expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1); // fans 列
});

test('空态：无筛选 → 暂无创作者；有 q/cat → 没有匹配', async () => {
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes([], 0)(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  expect(await screen.findByText(/暂无创作者/)).toBeInTheDocument();

  window.history.replaceState(null, '', '#/creators?q=不存在');
  cleanup();
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  expect(await screen.findByText(/没有匹配的创作者/)).toBeInTheDocument();
});

test('错误行 + 重试恢复', async () => {
  let fail = true;
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/creators?') && fail) return Promise.resolve(new Response('e', { status: 502 }));
    const r = defaultRoutes()(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  expect(await screen.findByText(/加载失败：HTTP 502/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('UP1')).toBeInTheDocument();
});

test('搜索防抖：输入后 300ms 才写 URL q 并重拉；期间不触发', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  await screen.findByText('UP1');
  const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes('q=')).length;
  fireEvent.change(screen.getByPlaceholderText('搜索 创作者名/ID'), { target: { value: '游戏' } });
  // 未到 300ms：不写 URL
  act(() => { vi.advanceTimersByTime(200); });
  expect(window.location.hash).toBe('#/creators');
  act(() => { vi.advanceTimersByTime(150); });
  await waitFor(() => expect(window.location.hash).toBe('#/creators?q=' + encodeURIComponent('游戏')));
  await waitFor(() => {
    const qCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('q='));
    expect(qCalls.length).toBeGreaterThan(before);
  });
});

test('槽位三态切换：缺省全部（URL 无 scope）；agent/human 写 query；cat 不被清掉（值域共享）', async () => {
  window.history.replaceState(null, '', '#/creators?cat=' + encodeURIComponent('科技'));
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  await screen.findByText('UP1');
  const catQ = 'cat=' + encodeURIComponent('科技');
  // 全部 → Agent：写 scope，cat 保留（一套分类值对任何槽位都有意义）；query 序由 useQueryUpdater 决定，断言顺序无关
  fireEvent.click(screen.getByRole('button', { name: 'Agent 打标' }));
  await waitFor(() => {
    expect(window.location.hash).toContain('scope=agent');
    expect(window.location.hash).toContain(catQ);
  });
  // Agent → 人工：scope 换值，cat 仍在
  fireEvent.click(screen.getByRole('button', { name: '人工打标' }));
  await waitFor(() => {
    expect(window.location.hash).toContain('scope=human');
    expect(window.location.hash).toContain(catQ);
  });
  // 点当前槽位：no-op
  fireEvent.click(screen.getByRole('button', { name: '人工打标' }));
  await screen.findByText('UP1');
  expect(window.location.hash).toContain('scope=human');
  expect(window.location.hash).toContain(catQ);
  // 人工 → 全部：scope 删除，cat 保留
  fireEvent.click(screen.getByRole('button', { name: '全部' }));
  await waitFor(() => expect(window.location.hash).toBe('#/creators?' + catQ));
});

test('排序 select：fans → URL sort=fans；first_seen 默认删除', async () => {
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  await screen.findByText('UP1');
  // combobox 顺序：[0]=分类筛选 [1]=排序 [2]=平台筛选 [3+] 行内
  fireEvent.pointerDown(screen.getAllByRole('combobox')[1], { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '粉丝数' }));
  await waitFor(() => expect(window.location.hash).toBe('#/creators?sort=fans'));
  await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('sort=fans'));

  fireEvent.pointerDown(screen.getAllByRole('combobox')[1], { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '首见时间' }));
  await waitFor(() => expect(window.location.hash).toBe('#/creators'));
});

test('分页：下一页 → page=2 重拉；上一页回 1', async () => {
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes([creatorItem(1)], 25)(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  await screen.findByText('第 1/2 页');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(window.location.hash).toBe('#/creators?page=2'));
  expect(await screen.findByText('第 2/2 页')).toBeInTheDocument();
  expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('page=2');
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  await waitFor(() => expect(window.location.hash).toBe('#/creators'));
});

// 平台筛选（2026-08-24）：Select 切换写 URL source 且请求带参
test('平台筛选 Select：切换写 URL source 且按平台重拉', async () => {
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  await screen.findByText('UP1');
  fireEvent.pointerDown(screen.getByRole('combobox', { name: '平台筛选' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '哔哩哔哩' }));
  await waitFor(() => expect(window.location.hash).toBe('#/creators?source=bilibili'));
  await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('source=bilibili'));
});

test('行内分类变更：Select 选择 → POST + toast + reload；失败 toast', async () => {  const post = vi.fn(() => Promise.resolve(ok({})));
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return post();
    const r = defaultRoutes()(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  await screen.findByText('UP1');
  // 行内第二个 combobox（人工分类）——前面是筛选/排序/平台区
  const rowTriggers = screen.getAllByRole('combobox');
  fireEvent.pointerDown(rowTriggers[4], { button: 0, ctrlKey: false, pointerType: 'mouse' }); // [0]=cat筛选 [1]=排序 [2]=平台 [3]=UP1 agent [4]=UP1 human
  fireEvent.click(await screen.findByRole('option', { name: '优质' }));
  expect(await screen.findByText('已更新')).toBeInTheDocument();
  const postCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
  expect(postCall[0]).toBe('/api/creators/by-uid/bilibili/1001/category');
  expect(JSON.parse(String(postCall[1].body))).toEqual({ scope: 'human', name: '优质' });
  // reload：/api/creators 再拉
  await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/creators?')).length).toBeGreaterThanOrEqual(2));

  post.mockImplementation(() => Promise.resolve(new Response('', { status: 400 })));
  fireEvent.pointerDown(screen.getAllByRole('combobox')[3], { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '科技' }));
  expect(await screen.findByText(/失败：HTTP 400/)).toBeInTheDocument();
});

test('cat 筛选 Select：选择后写 cat（缺省全部槽位，请求不带 scope）并重拉', async () => {
  render(<ToastProvider><CreatorsPage onOpen={() => {}} /></ToastProvider>);
  await screen.findByText('UP1');
  fireEvent.pointerDown(screen.getAllByRole('combobox')[0], { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '优质' }));
  await waitFor(() => expect(window.location.hash).toBe('#/creators?cat=' + encodeURIComponent('优质')));
  // 三态缺省=全部：请求只带 category 不带 scope（两槽位任一命中）
  await waitFor(() => {
    const last = String(fetchMock.mock.calls.at(-1)![0]);
    expect(last).toContain('category=' + encodeURIComponent('优质'));
    expect(last).not.toContain('scope=');
  });
});
