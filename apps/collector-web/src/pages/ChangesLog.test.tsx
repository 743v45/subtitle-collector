// ChangesLog 测试：行渲染（entity 标签/值截断）、entity 筛选 Select、分页 URL、错误/空态。
// Q8a（2026-10-05）：标识列内链——video 带 ref_source/ref_vid → #/videos/{source}/{vid}、
// creator 带 ref_creator_id → #/creators/{id}；ref 缺失保持纯文本（向后兼容）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 行渲染 + 截断 + 分页 + Select 切换 + 空态/错误 | 通过 | radix Select pointerDown 打开 |
// | R2 | douyin 平台白名单（2026-08-29 接入）：URL source=douyin 透传 + 下拉第四项 | 通过 | |
// | R3 | Q8a 内链（2026-10-05）：video/creator ref 齐全 → 标识变按钮点击跳详情；ref 缺失保持纯文本 | 通过 | hash 断言跳转目标 |
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
  fireEvent.pointerDown(screen.getByRole('combobox', { name: '类型筛选' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '创作者' }));
  await waitFor(() => expect(window.location.hash).toBe('#/changes?entity=creator'));
});

// 平台筛选（2026-08-24）：Select 切换写 URL source 且请求带参；行内平台图标随派生 source 列渲染
test('Select 切换平台：写 URL source 且请求带参', async () => {
  window.history.replaceState(null, '', '#/changes');
  fetchMock.mockImplementation(() => Promise.resolve(ok({ total: 1, items: [row({ id: 1, source: 'bilibili' })] })));
  render(<ChangesLog />);
  await screen.findByText('title'); // 首屏列表已渲染
  fireEvent.pointerDown(screen.getByRole('combobox', { name: '平台筛选' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '哔哩哔哩' }));
  await waitFor(() => expect(window.location.hash).toBe('#/changes?source=bilibili'));
  await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('source=bilibili'));
});

// douyin URL 白名单（2026-08-29）：source=douyin 直入 → 请求透传；下拉第四项在列
test('douyin：URL source=douyin 直入 → 请求带 source=douyin；抖音选项在列', async () => {
  window.history.replaceState(null, '', '#/changes?source=douyin');
  render(<ChangesLog />);
  await screen.findByText('共 0 条');
  await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('source=douyin'));
  fireEvent.pointerDown(screen.getByRole('combobox', { name: '平台筛选' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  expect(await screen.findByRole('option', { name: '抖音' })).toBeInTheDocument();
});

// ── Q8a 标识列内链（2026-10-05）──

test('Q8a 内链：video 行带 ref_source/ref_vid → 标识渲染为链接，点击跳 #/videos/{source}/{vid}', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(ok({
    total: 1,
    items: [row({ id: 1, entity: 'video', ref_source: 'bilibili', ref_vid: 'BVxx' })],
  })));
  render(<ChangesLog />);
  const link = await screen.findByRole('button', { name: '10' });
  expect(link).toHaveAttribute('title', '打开视频详情');
  fireEvent.click(link);
  expect(window.location.hash).toBe('#/videos/bilibili/BVxx');
});

test('Q8a 内链：creator 行带 ref_creator_id → 点击跳 #/creators/{id}；ref 缺失行保持纯文本', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(ok({
    total: 2,
    items: [
      row({ id: 1, entity: 'creator', ref_creator_id: 5 }),
      row({ id: 2, entity: 'video' }), // 无 ref 字段（旧 server 响应形状）
    ],
  })));
  render(<ChangesLog />);
  // ref 齐全的 creator 行：标识变按钮，点击跳创作者详情
  const link = await screen.findByRole('button', { name: '10' });
  expect(link).toHaveAttribute('title', '打开创作者详情');
  fireEvent.click(link);
  expect(window.location.hash).toBe('#/creators/5');
  // ref 缺失的 video 行：标识仍是纯文本（不在任何按钮里）
  expect(screen.queryByRole('button', { name: '打开视频详情' })).not.toBeInTheDocument();
  expect(screen.getAllByText('10').length).toBe(2);
});
