// ChangesLog 测试：行渲染（entity 标签/值截断）、entity 筛选 Select、分页 URL、错误/空态。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 行渲染 + 截断 + 分页 + Select 切换 + 空态/错误 | 通过 | radix Select pointerDown 打开 |
import { test, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ChangesLog } from './ChangesLog';
import type { ChangeRow } from '../types';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

function row(p: Partial<ChangeRow>): ChangeRow {
  return {
    id: 1, entity: 'video', entity_id: 10, field: 'title',
    old_value: null, new_value: null, changed_at: 1_700_000_000_000, ...p,
  };
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  (window.HTMLElement.prototype as any).hasPointerCapture = vi.fn(() => false);
  (window.HTMLElement.prototype as any).releasePointerCapture = vi.fn();
});
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(ok({ total: 0, items: [] })));
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '#/changes');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('行渲染：entity 中文标签 / 标识 / 字段 / 旧→新 / 本地化时间', async () => {
  const items = [
    row({ id: 1, entity: 'video', old_value: '旧题', new_value: '新题' }),
    row({ id: 2, entity: 'creator', field: 'fans', old_value: null, new_value: '123' }),
    row({ id: 3, entity: 'unknown_kind', old_value: '', new_value: 'x' }),
  ];
  fetchMock.mockImplementation(() => Promise.resolve(ok({ total: 3, items })));
  render(<ChangesLog />);
  expect(await screen.findByText('新题')).toBeInTheDocument();
  expect(screen.getAllByText('→').length).toBe(3);
  expect(screen.getByText('视频')).toBeInTheDocument();
  expect(screen.getByText('UP')).toBeInTheDocument();
  expect(screen.getByText('unknown_kind')).toBeInTheDocument();
  // 三行默认 entity_id 都是 10
  expect(screen.getAllByText('10').length).toBe(3);
  expect(screen.getByText('fans')).toBeInTheDocument();
  // row2 old=null 与 row3 old='' 各渲染一个 —
  expect(screen.getAllByText('—').length).toBe(2);
  expect(screen.getByText('共 3 条')).toBeInTheDocument();
});

test('值截断：>80 字符截断加 …，title 保留全文', async () => {
  const long = 'a'.repeat(100);
  fetchMock.mockImplementation(() => Promise.resolve(ok({ total: 1, items: [row({ id: 1, new_value: long })] })));
  render(<ChangesLog />);
  const cell = await screen.findByTitle(long);
  expect(cell).toHaveTextContent('…');
  expect(cell.textContent!.length).toBe(81);
  // ≤80 不截断
  const short = 'b'.repeat(80);
  fetchMock.mockImplementation(() => Promise.resolve(ok({ total: 1, items: [row({ id: 2, new_value: short })] })));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(screen.getByTitle(short).textContent!.length).toBe(80));
});

test('空数据：暂无变更记录 + 说明卡隐藏；有数据时说明卡出现', async () => {
  render(<ChangesLog />);
  expect(await screen.findByText(/暂无变更记录/)).toBeInTheDocument();
  expect(screen.queryByText(/说明：记录视频/)).not.toBeInTheDocument();

  fetchMock.mockImplementation(() => Promise.resolve(ok({ total: 1, items: [row({})] })));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(await screen.findByText(/说明：记录视频/)).toBeInTheDocument();
});

test('错误行 + 重试恢复', async () => {
  let fail = true;
  fetchMock.mockImplementation(() =>
    fail ? Promise.resolve(new Response('boom', { status: 500 })) : Promise.resolve(ok({ total: 1, items: [row({})] })));
  render(<ChangesLog />);
  expect(await screen.findByText(/加载失败：HTTP 500/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.getByText(/说明：记录视频/)).toBeInTheDocument());
});

test('分页：下一页写 URL page=2 重拉；上一页回落 page 删除；边界禁用', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(ok({ total: 45, items: [row({ id: 1 })] })));
  render(<ChangesLog />);
  expect(await screen.findByText('第 1/2 页')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下一页' })).not.toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(window.location.hash).toBe('#/changes?page=2'));
  expect(await screen.findByText('第 2/2 页')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '上一页' })).not.toBeDisabled();
  const lastUrl = fetchMock.mock.calls.at(-1)![0] as string;
  expect(lastUrl).toBe('/api/changes?page=2&size=30');

  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  await waitFor(() => expect(window.location.hash).toBe('#/changes'));
  expect(await screen.findByText('第 1/2 页')).toBeInTheDocument();
});

test('total=0：两页按钮都禁用，显示第 1/1 页', async () => {
  render(<ChangesLog />);
  await screen.findByText(/暂无变更记录/);
  expect(screen.getByText('第 1/1 页')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
});

test('URL entity=video → 请求带 entity', async () => {
  window.history.replaceState(null, '', '#/changes?entity=video');
  render(<ChangesLog />);
  await screen.findByText('共 0 条');
  expect(fetchMock.mock.calls[0][0]).toBe('/api/changes?entity=video&page=1&size=30');
});

test('Select 切换 entity：写 URL 且 resetPage', async () => {
  window.history.replaceState(null, '', '#/changes?entity=video&page=3');
  fetchMock.mockImplementation(() => Promise.resolve(ok({ total: 90, items: [row({ id: 1 })] })));
  render(<ChangesLog />);
  await screen.findByText('第 3/3 页');
  fireEvent.pointerDown(screen.getByRole('combobox'), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '创作者' }));
  await waitFor(() => expect(window.location.hash).toBe('#/changes?entity=creator'));
});
