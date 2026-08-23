// TagsPage 测试：展示优先级（默认/服务端序、上下移、拖拽、保存成败）、档位过滤 URL、
// 标签行（改名/删除/点击跳视频页）、空态两种文案、错误重试。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 优先级操作 + 档位过滤 + CRUD + 空错态 + 名称跳转 | 通过 | 拖拽用 dragStart/drop 事件模拟 |
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { TagsPage } from './TagsPage';
import type { TagItem } from '@/api';
import { TAG_SOURCE_LABEL, type TagSource } from '@/lib/tagSources';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

function tag(id: number, name: string, counts = { manual: 1, batch: 2, ai: 3, system: 0, total: 6 }): TagItem {
  return { id, name, created_at: 1_700_000_000_000, counts };
}
const TAGS: TagItem[] = [tag(1, '游戏'), tag(2, '音乐')];
const DEFAULT_PRIORITY: TagSource[] = ['manual', 'batch', 'bili', 'season', 'ai', 'system'];

function defaultRoutes(items: TagItem[] = TAGS, priority: TagSource[] = DEFAULT_PRIORITY) {
  return (url: string, init?: RequestInit): Response | null => {
    if (url === '/api/settings/tag-priority') return ok({ priority });
    if (url.startsWith('/api/tags?')) return ok({ items });
    return null;
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes()(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error(`unmatched: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '#/tags');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function priorityLabels(): string[] {
  return DEFAULT_PRIORITY.map((s) => TAG_SOURCE_LABEL[s]);
}

test('渲染：优先级五档（服务端序）+ 标签行计数 + bili 档不可编辑注记', async () => {
  render(<ToastProvider><TagsPage /></ToastProvider>);
  expect(await screen.findByText('展示优先级')).toBeInTheDocument();
  // 每档在优先级列表出现（手动/批量/AI 与档位过滤按钮同名，至少各一处）
  priorityLabels().forEach((l) => expect(screen.getAllByText(l).length).toBeGreaterThanOrEqual(1));
  expect(screen.getByText('来自视频自带，不可编辑')).toBeInTheDocument();
  expect(screen.getByText('游戏')).toBeInTheDocument();
  expect(screen.getByText('音乐')).toBeInTheDocument();
  expect(screen.getAllByText('6').length).toBe(2); // 总计列
  expect(screen.getByText('共 2 条')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存排序' })).toBeDisabled();
});

test('服务端优先级：非默认序回显', async () => {
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes(TAGS, ['ai', 'manual', 'season', 'bili', 'batch', 'system'])(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><TagsPage /></ToastProvider>);
  await screen.findByText('展示优先级');
  const rows = screen.getAllByText(/手动|批量|B站|合集|AI/).map((e) => e.textContent);
  expect(rows[0]).toBe('AI');
  expect(rows[4]).toBe('批量');
});

test('上移/下移：本地重排 + 保存按钮启用 + 边界禁用', async () => {
  render(<ToastProvider><TagsPage /></ToastProvider>);
  await screen.findByText('展示优先级');
  const upButtons = screen.getAllByRole('button', { name: '上移' });
  const downButtons = screen.getAllByRole('button', { name: '下移' });
  expect(upButtons[0]).toBeDisabled(); // 第一行
  expect(downButtons[5]).toBeDisabled(); // 最后一行（六档）
  fireEvent.click(upButtons[1]); // 批量 上移
  expect(screen.getByRole('button', { name: '保存排序' })).toBeEnabled();
  // 首行变成 批量
  const first = screen.getAllByText(/手动|批量|B站|合集|AI/)[0];
  expect(first.textContent).toBe('批量');
});

test('moveItem 无操作：from===to / 越界不改序', async () => {
  render(<ToastProvider><TagsPage /></ToastProvider>);
  await screen.findByText('展示优先级');
  fireEvent.click(screen.getAllByRole('button', { name: '下移' })[5]); // 越界（最后一行下移被禁，直接调用 disabled click 不触发）
  expect(screen.getByRole('button', { name: '保存排序' })).toBeDisabled();
});

test('拖拽：dragStart + drop 重排', async () => {
  render(<ToastProvider><TagsPage /></ToastProvider>);
  await screen.findByText('展示优先级');
  const rows = () => screen.getAllByText(/手动|批量|B站|合集|AI/).map((e) => e.textContent);
  const rowEls = () => screen.getAllByText(/手动|批量|B站|合集|AI/).map((e) => e.closest('div.border')!);
  fireEvent.dragStart(rowEls()[4]); // AI 拖到最前
  fireEvent.drop(rowEls()[0]);
  expect(rows()[0]).toBe('AI');
  expect(screen.getByRole('button', { name: '保存排序' })).toBeEnabled();
  // dragEnd 清 dragFrom（幂等）
  fireEvent.dragEnd(rowEls()[0]);
});

test('保存排序：PUT 新序 + toast + 编辑态复位；失败 toast', async () => {
  const put = vi.fn(() => Promise.resolve(ok({})));
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return put();
    const r = defaultRoutes()(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><TagsPage /></ToastProvider>);
  await screen.findByText('展示优先级');
  fireEvent.click(screen.getAllByRole('button', { name: '上移' })[1]);
  fireEvent.click(screen.getByRole('button', { name: '保存排序' }));
  expect(await screen.findByText('已保存排序')).toBeInTheDocument();
  const putCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')!;
  expect(JSON.parse(String(putCall[1].body))).toEqual({ priority: ['batch', 'manual', 'bili', 'season', 'ai', 'system'] });
  // 复位：保存按钮重新禁用
  await waitFor(() => expect(screen.getByRole('button', { name: '保存排序' })).toBeDisabled());

  // 失败分支
  put.mockImplementation(() => Promise.resolve(new Response('', { status: 400 })));
  fireEvent.click(screen.getAllByRole('button', { name: '上移' })[1]);
  fireEvent.click(screen.getByRole('button', { name: '保存排序' }));
  expect(await screen.findByText(/保存排序失败：HTTP 400/)).toBeInTheDocument();
});

test('档位过滤：按钮写 URL scope 且按 source 重拉', async () => {
  render(<ToastProvider><TagsPage /></ToastProvider>);
  await screen.findByText('游戏');
  fireEvent.click(screen.getByRole('button', { name: '手动' }));
  await waitFor(() => expect(window.location.hash).toBe('#/tags?scope=manual'));
  await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('source=manual'));
  fireEvent.click(screen.getByRole('button', { name: '全部' }));
  await waitFor(() => expect(window.location.hash).toBe('#/tags'));
});

test('URL 非法 scope 回落全部', async () => {
  window.history.replaceState(null, '', '#/tags?scope=bili');
  render(<ToastProvider><TagsPage /></ToastProvider>);
  await screen.findByText('游戏');
  const tagUrls = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/tags?'));
  expect(String(tagUrls[0][0])).not.toContain('source=');
});

test('点击标签名 → 跳视频页 tags 过滤', async () => {
  render(<ToastProvider><TagsPage /></ToastProvider>);
  await screen.findByText('游戏');
  fireEvent.click(screen.getByRole('button', { name: '游戏' }));
  expect(window.location.hash).toBe('#/videos?tags=' + encodeURIComponent('游戏'));
});

test('改名：回显 → PATCH + toast + reload；同名直接关闭；失败 toast', async () => {
  const patch = vi.fn(() => Promise.resolve(ok({ tag: tag(1, '新游戏') })));
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return patch();
    const r = defaultRoutes()(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><TagsPage /></ToastProvider>);
  await screen.findByText('游戏');
  fireEvent.click(screen.getAllByRole('button', { name: '改名' })[0]);
  const input = await screen.findByLabelText('名称');
  expect((input as HTMLInputElement).value).toBe('游戏');
  fireEvent.change(input, { target: { value: '新游戏' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('已改名')).toBeInTheDocument();
  const patchCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')!;
  expect(patchCall[0]).toBe('/api/tags/1');
  expect(JSON.parse(String(patchCall[1].body))).toEqual({ name: '新游戏' });

  // 同名
  fireEvent.click(screen.getAllByRole('button', { name: '改名' })[0]);
  await screen.findByLabelText('名称');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.queryByLabelText('名称')).not.toBeInTheDocument());
  expect(patch).toHaveBeenCalledTimes(1);

  // 失败
  patch.mockImplementation(() => Promise.resolve(new Response('', { status: 409 })));
  fireEvent.click(screen.getAllByRole('button', { name: '改名' })[0]);
  const input2 = await screen.findByLabelText('名称');
  fireEvent.change(input2, { target: { value: '又一个' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText(/改名失败：HTTP 409/)).toBeInTheDocument();
});

test('删除：confirm 取消不调 DELETE；确认 → DELETE + toast + reload；失败 toast', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const del = vi.fn(() => Promise.resolve(ok({})));
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return del();
    const r = defaultRoutes()(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><TagsPage /></ToastProvider>);
  await screen.findByText('游戏');
  confirmSpy.mockReturnValue(false);
  fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);
  expect(del).not.toHaveBeenCalled();
  confirmSpy.mockReturnValue(true);
  fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);
  expect(await screen.findByText('已删除')).toBeInTheDocument();
  expect(del).toHaveBeenCalledWith();
  const delCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')!;
  expect(delCall[0]).toBe('/api/tags/1');

  del.mockImplementation(() => Promise.resolve(new Response('', { status: 400 })));
  fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);
  expect(await screen.findByText(/删除失败：HTTP 400/)).toBeInTheDocument();
  confirmSpy.mockRestore();
});

test('空态：全档与单档文案区分', async () => {
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes([])(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><TagsPage /></ToastProvider>);
  expect(await screen.findByText(/暂无标签——在视频详情页/)).toBeInTheDocument();

  window.history.replaceState(null, '', '#/tags?scope=ai');
  cleanup();
  render(<ToastProvider><TagsPage /></ToastProvider>);
  expect(await screen.findByText('该档位暂无标签')).toBeInTheDocument();
});

test('错误行 + 重试恢复', async () => {
  let fail = true;
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/tags?') && fail) return Promise.resolve(new Response('x', { status: 500 }));
    const r = defaultRoutes()(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(<ToastProvider><TagsPage /></ToastProvider>);
  expect(await screen.findByText(/加载失败：HTTP 500/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('游戏')).toBeInTheDocument();
});
