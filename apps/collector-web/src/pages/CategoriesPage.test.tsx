// CategoriesPage 测试：单一列表（值域合一，无 scope 维度）、新建/改名/删除三组交互（Dialog + confirm + toast）、
// 加载/错误/空态、创作者数量列跳转。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | scope 切换 + CRUD 流 + 错误/空态/骨架 | 通过 | confirm 用 spy；Dialog 内输入 fireEvent.change |
// | R2 | 创作者数量列：count>0 点击跳 /creators 过滤（带 scope）、count=0 不可点 | 通过 | 断言 location.hash；human scope 同测 |
// | R3 | 值域合一（2026-08-25）：去 scope 切换/参数；数量列跳转不带 scope（两槽位任一）；POST body 去 scope | 通过 | R1 的 scope 切换用例随 UI 删除 |
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { CategoriesPage } from './CategoriesPage';
import type { Category } from '@/api';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}
function httpErr(status: number, body: unknown = ''): Response {
  return typeof body === 'string'
    ? new Response(body, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

function cat(id: number, name: string, sortOrder = id, creatorCount = 0): Category {
  return { id, name, sort_order: sortOrder, created_at: 1_700_000_000_000, creator_count: creatorCount };
}
// 科技 count=3（可点）、生活 count=0（灰文本）；sort_order 显式 1/2 与 count 值错开避免 getByText 歧义
const CATS: Category[] = [cat(1, '科技', 1, 3), cat(2, '生活', 2, 0)];

function listRoute(items: Category[] = CATS) {
  return (url: string): Response | null =>
    url.startsWith('/api/categories') ? ok({ items }) : null;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    const r = listRoute()(url);
    if (r) return Promise.resolve(r);
    return Promise.reject(new Error(`unmatched: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '#/categories');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('初始渲染：无参拉取一套分类值，展示行与总数', async () => {
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  expect(await screen.findByText('科技')).toBeInTheDocument();
  expect(screen.getByText('生活')).toBeInTheDocument();
  expect(screen.getByText('共 2 条')).toBeInTheDocument();
  expect(screen.getByText('2').textContent).toBe('2'); // sort_order 列
  const urls = fetchMock.mock.calls.map((c) => String(c[0]));
  expect(urls[0]).toBe('/api/categories');
  // 值域合一副标题
  expect(screen.getByText(/Agent 与人工共用同一套分类/)).toBeInTheDocument();
});

test('加载骨架：pending 期间 skeleton 行', () => {
  fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
});

test('加载失败：错误行 + 重试恢复', async () => {
  let fail = true;
  fetchMock.mockImplementation((url: string) =>
    fail ? Promise.resolve(httpErr(500, { error: 'db 损坏' })) : Promise.resolve(listRoute()!(url)));
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  expect(await screen.findByText('加载失败：HTTP 500：db 损坏')).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('科技')).toBeInTheDocument();
});

test('空列表：暂无分类提示', async () => {
  fetchMock.mockImplementation((url: string) => Promise.resolve(listRoute([])(url) !));
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  expect(await screen.findByText(/暂无创作者分类/)).toBeInTheDocument();
});

test('创作者数量列：count>0 点击跳 /creators 按分类名过滤（不带 scope，两槽位任一）；count=0 灰文本不可点', async () => {
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  expect(await screen.findByText('科技')).toBeInTheDocument();
  // 生活 count=0：纯文本，非可点按钮
  expect(screen.queryByRole('button', { name: '0' })).not.toBeInTheDocument();
  // 科技 count=3：点击 → hash 只带 cat（CreatorsPage 三态缺省=全部）+ URL 编码分类名
  fireEvent.click(screen.getByRole('button', { name: '3' }));
  expect(window.location.hash).toBe(`#/creators?cat=${encodeURIComponent('科技')}`);
});

test('新建：Dialog 输入保存 → POST + toast + 关闭 + reload', async () => {
  const post = vi.fn(() => Promise.resolve(ok({ category: cat(3, '游戏') })));
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url === '/api/categories') return post();
    return Promise.resolve(listRoute()(url) ?? httpErr(500));
  });
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  await screen.findByText('科技');
  fireEvent.click(screen.getByRole('button', { name: '新建' }));
  const input = await screen.findByLabelText('名称');
  fireEvent.change(input, { target: { value: '游戏' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('已新建')).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith();
  expect(JSON.parse(String(fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST')![1].body)))
    .toEqual({ name: '游戏' });
  // 关闭 + reload：GET 再次发生
  await waitFor(() => expect(fetchMock.mock.calls.filter((c) => !c[1]).length).toBeGreaterThanOrEqual(2));
});

test('新建：空名保存禁用；失败 toast 带错误文案', async () => {
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  await screen.findByText('科技');
  fireEvent.click(screen.getByRole('button', { name: '新建' }));
  await screen.findByLabelText('名称');
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'x' } });
  fetchMock.mockImplementationOnce(() => Promise.resolve(httpErr(400, { error: '重名' })));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('新建失败：HTTP 400：重名')).toBeInTheDocument();
});

test('改名：回显旧名 → PATCH + toast + reload；取消关闭', async () => {
  const patch = vi.fn(() => Promise.resolve(ok({ category: cat(1, '新名') })));
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return patch();
    return Promise.resolve(listRoute()(url) ?? httpErr(500));
  });
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  await screen.findByText('科技');
  fireEvent.click(screen.getAllByRole('button', { name: '改名' })[0]);
  const input = await screen.findByLabelText('名称');
  expect((input as HTMLInputElement).value).toBe('科技');
  fireEvent.change(input, { target: { value: '新名' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('已改名')).toBeInTheDocument();
  expect(patch).toHaveBeenCalled();

  // 取消
  fireEvent.click(screen.getAllByRole('button', { name: '改名' })[0]);
  await screen.findByLabelText('名称');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByLabelText('名称')).not.toBeInTheDocument());
});

test('改名：同名保存 → 直接关闭不调 PATCH', async () => {
  const patch = vi.fn(() => Promise.resolve(ok({})));
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return patch();
    return Promise.resolve(listRoute()(url) ?? httpErr(500));
  });
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  await screen.findByText('科技');
  fireEvent.click(screen.getAllByRole('button', { name: '改名' })[0]);
  await screen.findByLabelText('名称');
  fireEvent.click(screen.getByRole('button', { name: '保存' })); // 名字未改
  await waitFor(() => expect(screen.queryByLabelText('名称')).not.toBeInTheDocument());
  expect(patch).not.toHaveBeenCalled();
});

test('改名失败：toast 错误文案', async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Promise.resolve(httpErr(409, { error: '撞名' }));
    return Promise.resolve(listRoute()(url) ?? httpErr(500));
  });
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  await screen.findByText('科技');
  fireEvent.click(screen.getAllByRole('button', { name: '改名' })[0]);
  const input = await screen.findByLabelText('名称');
  fireEvent.change(input, { target: { value: '别的' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('改名失败：HTTP 409：撞名')).toBeInTheDocument();
});

test('删除：confirm 取消不调 DELETE；确认 → DELETE + toast + reload', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const del = vi.fn(() => Promise.resolve(ok({})));
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return del();
    return Promise.resolve(listRoute()(url) ?? httpErr(500));
  });
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  await screen.findByText('科技');

  confirmSpy.mockReturnValue(false);
  fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);
  expect(del).not.toHaveBeenCalled();

  confirmSpy.mockReturnValue(true);
  fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);
  expect(await screen.findByText('已删除')).toBeInTheDocument();
  expect(del).toHaveBeenCalledWith();
  confirmSpy.mockRestore();
});

test('删除失败：toast 错误文案', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return Promise.resolve(httpErr(400, { error: '占用' }));
    return Promise.resolve(listRoute()(url) ?? httpErr(500));
  });
  render(<ToastProvider><CategoriesPage /></ToastProvider>);
  await screen.findByText('科技');
  fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);
  expect(await screen.findByText('删除失败：HTTP 400：占用')).toBeInTheDocument();
  vi.spyOn(window, 'confirm').mockRestore();
});
