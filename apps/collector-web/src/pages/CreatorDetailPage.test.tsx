// CreatorDetailPage 测试：资料卡字段（含 bilibili 独有）、分类 Select 变更、已采视频列表格式化与跳转、错误态。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 字段渲染 + 分类变更成败 + 视频列表交互 + fmtView/fmtDur 分支 | 通过 | fmtDur 的 h 分支用 3661s 断言 |
import { test, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { CreatorDetailPage } from './CreatorDetailPage';
import type { CreatorDetail, VideoListItem } from '../types';
import type { Category } from '@/api';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

function creator(p: Partial<CreatorDetail> = {}): CreatorDetail {
  return {
    id: 7, source: 'bilibili', source_uid: '42', name: '测试 UP', avatar: 'https://cdn/x.png',
    sign: '签名档', level: 6, sex: '男', official_type: 1, official_title: '金标',
    fans: 12345, following: 100, category_agent_id: 1, category_agent_name: '科技',
    category_human_id: null, category_human_name: null, first_seen_at: 1_700_000_000_000, updated_at: 1,
    ...p,
  };
}
function video(id: number, p: Partial<VideoListItem> = {}): VideoListItem {
  return {
    id, source: 'bilibili', source_vid: `BV${id}`, title: `视频标题${id}`,
    creator_name: '测试 UP', duration: 90, published_at: 1, track_count: 1,
    first_seen_at: 1, view: 500,
    ...p,
  };
}
// 值域合一（2026-08-25）：一套分类，两个下拉共用；「游戏」在 agent 槽可选、「优质」在 human 槽可选，同源
const CATS: Category[] = [
  { id: 1, name: '科技', sort_order: 1, created_at: 1, creator_count: 0 },
  { id: 2, name: '游戏', sort_order: 2, created_at: 1, creator_count: 0 },
  { id: 3, name: '优质', sort_order: 3, created_at: 1, creator_count: 0 },
];

// 默认路由：detail + 一套分类 + 该 UP 视频
function defaultRoutes(c: CreatorDetail = creator(), vids: VideoListItem[] = [video(1), video(2)], total = vids.length) {
  return (url: string): Response | null => {
    if (url === '/api/creators/7') return ok({ creator: c });
    if (url === '/api/categories') return ok({ items: CATS });
    if (url.startsWith('/api/videos?')) return ok({ total, items: vids });
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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('渲染：头像/名称/uid/分类 Badge/资料字段（bilibili 独有档）', async () => {
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  expect(await screen.findByText('测试 UP')).toBeInTheDocument();
  expect((screen.getByRole('img', { name: '测试 UP' }) as HTMLImageElement).src).toBe('https://cdn/x.png');
  expect(screen.getByText('42')).toBeInTheDocument();
  expect(screen.getByText('Agent: 科技')).toBeInTheDocument();
  expect(screen.queryByText(/人工:/)).not.toBeInTheDocument();
  // 资料字段
  expect(screen.getByText('签名档')).toBeInTheDocument();
  expect(screen.getByText('6')).toBeInTheDocument(); // 等级
  expect(screen.getByText('男')).toBeInTheDocument();
  expect(screen.getByText('金标')).toBeInTheDocument();
  expect(screen.getByText('12,345')).toBeInTheDocument(); // fans 千分位
  expect(screen.getByText('100')).toBeInTheDocument(); // following
  // 外链锚点
  expect(screen.getByRole('link', { name: /在原站打开 测试 UP 的空间/ })).toHaveAttribute('href', 'https://space.bilibili.com/42');
  // 已采视频
  expect(screen.getByText('已采集视频（2）')).toBeInTheDocument();
  expect(screen.getByText('视频标题1')).toBeInTheDocument();
});

test('youtube 源：不渲染 等级/性别/认证 字段', async () => {
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes(creator({ source: 'youtube', source_uid: 'UCxxx', level: null, sex: null, official_title: null }))(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  await screen.findByText('测试 UP');
  expect(screen.queryByText('等级')).not.toBeInTheDocument();
  expect(screen.queryByText('性别')).not.toBeInTheDocument();
  expect(screen.queryByText('认证')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '在原站打开 测试 UP 的空间' })).toHaveAttribute('href', 'https://www.youtube.com/channel/UCxxx');
});

test('avatar null：占位图标（无 img）；name null → (未知)', async () => {
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes(creator({ avatar: null, name: null }))(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  expect(await screen.findByText('(未知)')).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

test('字段空值渲染 —（sign/等级/认证 null）', async () => {
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes(creator({ sign: null, level: null, official_title: null, fans: null }))(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  expect(await screen.findAllByText('—')).not.toHaveLength(0);
  expect(screen.queryByText('金标')).not.toBeInTheDocument();
});

test('视频列表：播放量/时长格式化（万档、H:MM:SS）+ 点击行回调 onOpenVideo', async () => {
  const onOpenVideo = vi.fn();
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes(creator(), [
      video(1, { view: 23456, duration: 3661 }),
      video(2, { view: null, duration: null }),
    ])(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={onOpenVideo} />
    </ToastProvider>,
  );
  await screen.findByText('视频标题1');
  const row1 = screen.getByText('视频标题1').closest('div.cursor-pointer')!;
  expect(row1.textContent).toContain('播放 2.3万');
  expect(row1.textContent).toContain('1:01:01'); // fmtDur h 分支
  // view/duration null：无「播放」段
  const row2 = screen.getByText('视频标题2').closest('div.cursor-pointer')!;
  expect(row2.textContent).not.toContain('播放');
  fireEvent.click(screen.getByText('视频标题1'));
  expect(onOpenVideo).toHaveBeenCalledWith('bilibili', 'BV1');
});

test('视频总数超展示数：标题注明仅显示前 N；空列表提示', async () => {
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes(creator(), [video(1)], 120)(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  expect(await screen.findByText('已采集视频（120，仅显示前 1）')).toBeInTheDocument();

  cleanup();
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes(creator(), [], 0)(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  expect(await screen.findByText(/该 UP 暂无已采集视频/)).toBeInTheDocument();
});

test('视频列表：亿档播放量与负时长（fmtView 亿 / fmtDur 负数空串）', async () => {
  fetchMock.mockImplementation((url: string) => {
    const r = defaultRoutes(creator(), [video(1, { view: 234_000_000, duration: -5 })])(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  await screen.findByText('视频标题1');
  const row = screen.getByText('视频标题1').closest('div.cursor-pointer')!;
  expect(row.textContent).toContain('2.3亿');
  expect(row.textContent).not.toMatch(/\d+:\d+/); // 负时长 → 无时长段
});

test('返回按钮触发 onBack', async () => {
  const onBack = vi.fn();
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={onBack} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  await screen.findByText('测试 UP');
  fireEvent.click(screen.getByRole('button', { name: /返回/ }));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('加载失败：错误卡 + 重试恢复；加载中骨架', async () => {
  let fail = true;
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/creators/7' && fail) return Promise.resolve(new Response('x', { status: 500 }));
    const r = defaultRoutes()(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  expect(await screen.findByText(/加载失败：HTTP 500/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('测试 UP')).toBeInTheDocument();

  // 初始 pending → DetailSkeleton（aria-busy）
  fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
  cleanup();
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
});

test('分类变更：Select 选择 → POST setCreatorCategory → toast + reload；失败 toast', async () => {
  const post = vi.fn(() => Promise.resolve(ok({})));
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return post();
    const r = defaultRoutes()(url);
    return r ? Promise.resolve(r) : Promise.reject(new Error('x'));
  });
  render(
    <ToastProvider>
      <CreatorDetailPage id={7} onBack={() => {}} onOpenVideo={() => {}} />
    </ToastProvider>,
  );
  await screen.findByText('测试 UP');
  // 人工分类（当前 null → placeholder）
  const triggers = screen.getAllByRole('combobox');
  fireEvent.pointerDown(triggers[1], { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '优质' }));
  await screen.findByText('已更新');
  expect(post).toHaveBeenCalledWith();
  const postCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
  expect(postCall[0]).toBe('/api/creators/by-uid/bilibili/42/category');
  expect(JSON.parse(String(postCall[1].body))).toEqual({ scope: 'human', name: '优质' });

  // Agent 分类失败分支
  post.mockImplementation(() => Promise.resolve(new Response('', { status: 400 })));
  fireEvent.pointerDown(screen.getAllByRole('combobox')[0], { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: '游戏' }));
  expect(await screen.findByText(/失败：HTTP 400/)).toBeInTheDocument();
});
