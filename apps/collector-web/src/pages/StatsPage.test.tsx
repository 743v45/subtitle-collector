// StatsPage 测试：overview 数字卡 + 时间范围、groupBy 按钮 URL 驱动聚合、榜单渲染（track-type 标签/宽度档）、空错态。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | overview + groupBy 切换 + 榜单 + 空错态 + 非法 groupBy 回落 | 通过 | fmtTime null → '-' |
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { StatsPage } from './StatsPage';
import type { StatsOverview } from '../types';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

const OVERVIEW: StatsOverview = {
  videos: 123, tracks: 456, versions: 789, creators: 22, languages: 9, categories: 7,
  today_videos: 5, first_seen_min: 1_700_000_000_000, first_seen_max: 1_710_000_000_000,
};

function aggregate(items: Array<{ key: string; count: number }>) {
  return { items };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/stats?type=overview') return Promise.resolve(ok({ overview: OVERVIEW }));
    if (url.startsWith('/api/stats?')) return Promise.resolve(ok(aggregate([{ key: '主分区', count: 8 }, { key: '次分区', count: 3 }])));
    return Promise.reject(new Error(`unmatched: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '#/stats');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('overview 数字卡 + 采集时间范围（null → -）', async () => {
  render(<StatsPage />);
  expect(await screen.findByText('123')).toBeInTheDocument();
  expect(screen.getByText('456')).toBeInTheDocument();
  expect(screen.getByText('789')).toBeInTheDocument();
  expect(screen.getByText('22')).toBeInTheDocument();
  expect(screen.getByText('9')).toBeInTheDocument(); // 语言数（榜单计数已错开为 8/3）
  expect(screen.getByText('7')).toBeInTheDocument();
  ['视频', '字幕轨', '字幕版本', '创作者', '语言数', '分区数'].forEach((l) => expect(screen.getByText(l)).toBeInTheDocument());
  expect(screen.getByText(/采集时间范围：/).textContent).toMatch(/202\d/);

  cleanup();
  fetchMock.mockImplementation((url: string) =>
    url === '/api/stats?type=overview'
      ? Promise.resolve(ok({ overview: { ...OVERVIEW, first_seen_min: null, first_seen_max: null } }))
      : Promise.resolve(ok(aggregate([]))));
  render(<StatsPage />);
  await screen.findByText('123');
  expect(screen.getByText(/采集时间范围：- ~ -/)).toBeInTheDocument();
});

test('overview 失败：错误 + 重试恢复', async () => {
  let fail = true;
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/stats?type=overview' && fail) return Promise.resolve(new Response('x', { status: 500 }));
    if (url === '/api/stats?type=overview') return Promise.resolve(ok({ overview: OVERVIEW }));
    return Promise.resolve(ok(aggregate([{ key: 'k', count: 1 }])));
  });
  render(<StatsPage />);
  expect(await screen.findByText(/加载统计失败：HTTP 500/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('123')).toBeInTheDocument();
});

test('榜单：排序编号 + 计数 + 最大值满宽档（w-[100%]）', async () => {
  render(<StatsPage />);
  expect(await screen.findByText('主分区')).toBeInTheDocument();
  expect(screen.getByText('#1')).toBeInTheDocument();
  expect(screen.getByText('#2')).toBeInTheDocument();
  expect(screen.getByText('8')).toBeInTheDocument(); // 最大计数
  const full = document.querySelector('.w-\\[100\\%\\]');
  expect(full).not.toBeNull(); // max=8 → floor(8/8*10)=10 → min(10,10) → w-[100%]
});

test('groupBy 按钮：切换写 URL 并按新维度重拉；默认 tname 不带参', async () => {
  render(<StatsPage />);
  await screen.findByText('主分区');
  expect(String(fetchMock.mock.calls.find((c) => String(c[0]).includes('aggregate'))![0])).toContain('groupBy=tname');
  fireEvent.click(screen.getByRole('button', { name: '按语言' }));
  await waitFor(() => expect(window.location.hash).toBe('#/stats?groupBy=lang'));
  await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('groupBy=lang'));
  fireEvent.click(screen.getByRole('button', { name: '按分区' }));
  await waitFor(() => expect(window.location.hash).toBe('#/stats'));
});

test('URL 带非法 groupBy → 回落 tname；合法值透传', async () => {
  window.history.replaceState(null, '', '#/stats?groupBy=bogus');
  render(<StatsPage />);
  await screen.findByText('主分区');
  expect(String(fetchMock.mock.calls.find((c) => String(c[0]).includes('aggregate'))![0])).toContain('groupBy=tname');

  cleanup();
  fetchMock.mockClear();
  window.history.replaceState(null, '', '#/stats?groupBy=tag');
  render(<StatsPage />);
  await screen.findByText('主分区');
  expect(String(fetchMock.mock.calls.find((c) => String(c[0]).includes('aggregate'))![0])).toContain('groupBy=tag');
});

test('track-type：1/2 键映射 AI 字幕/CC 字幕；未知键透传', async () => {
  window.history.replaceState(null, '', '#/stats?groupBy=track-type');
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/stats?type=overview') return Promise.resolve(ok({ overview: OVERVIEW }));
    return Promise.resolve(ok(aggregate([{ key: '1', count: 5 }, { key: '2', count: 3 }, { key: '7', count: 1 }])));
  });
  render(<StatsPage />);
  expect(await screen.findByText('AI 字幕')).toBeInTheDocument();
  expect(screen.getByText('CC 字幕')).toBeInTheDocument();
  // 未知键 '7' 原样透传（与分区数卡 7 各一处）
  expect(screen.getAllByText('7').length).toBe(2);
});

test('聚合失败：错误行 + 重试恢复；空数据提示', async () => {
  let fail = true;
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/stats?type=overview') return Promise.resolve(ok({ overview: OVERVIEW }));
    if (fail) return Promise.resolve(new Response('x', { status: 500 }));
    return Promise.resolve(ok(aggregate([])));
  });
  render(<StatsPage />);
  expect(await screen.findByText(/加载失败：HTTP 500/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText(/暂无数据/)).toBeInTheDocument();
});

test('加载中：榜单骨架（overview 已到、aggregate pending）', async () => {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/stats?type=overview') return Promise.resolve(ok({ overview: OVERVIEW }));
    return new Promise<Response>(() => {});
  });
  render(<StatsPage />);
  await screen.findByText('123');
  // 聚合 pending → aria-busy 骨架组
  expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(8);
});
