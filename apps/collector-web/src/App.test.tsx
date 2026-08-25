// App 壳层测试：hash 路由驱动 tab/详情切换、侧栏分组导航、移动端「更多」弹层、
// 品牌头回视频库、videoView 的 query 剥离回跳（track/ver 不带回列表）。
//
// 注：CollectPage/VideoList/VideoDetail/TasksHistoryPage 归并行测试线（web-core），此处 vi.mock 成标记组件，
// 只验 App 的路由装配；其余页面用真实组件 + fetch mock。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | tab 切换 + 更多弹层 + 品牌跳转 + 详情回跳 | 通过 | 桌面/移动两套「主导航」均存在，取第一个断言 |
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import App from './App';

vi.mock('./pages/CollectPage', () => ({ CollectPage: () => <div data-testid="page-collect">COLLECT</div> }));
vi.mock('./pages/VideoList', () => ({ VideoList: () => <div data-testid="page-videos">VIDEOLIST</div> }));
vi.mock('./pages/TasksHistoryPage', () => ({ TasksHistoryPage: () => <div data-testid="page-history">HISTORY</div> }));
vi.mock('./pages/VideoDetail', () => ({
  VideoDetail: ({ onBack }: { onBack: () => void }) => (
    <button data-testid="vd-back" onClick={onBack}>VD 返回</button>
  ),
}));
vi.mock('./pages/CreatorDetailPage', () => ({
  CreatorDetailPage: ({ onBack, onOpenVideo }: { onBack: () => void; onOpenVideo: (s: string, v: string) => void }) => (
    <div data-testid="page-creator-detail">
      <button data-testid="cd-back" onClick={onBack}>CD 返回</button>
      <button data-testid="cd-open-video" onClick={() => onOpenVideo('bilibili', 'BV9')}>CD 开视频</button>
    </div>
  ),
}));

function ok(json: unknown): Response {
  return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/tags')) return Promise.resolve(ok({ items: [] }));
    if (url === '/api/settings/tag-priority') return Promise.resolve(ok({ priority: ['manual', 'batch', 'bili', 'season', 'ai'] }));
    if (url.startsWith('/api/categories')) return Promise.resolve(ok({ items: [] }));
    if (url === '/api/settings/collect-timeout') return Promise.resolve(ok({ bilibili: 90000, youtube: 45000 }));
    if (url.startsWith('/api/creators')) return Promise.resolve(ok({ total: 0, items: [] }));
    if (url.startsWith('/api/videos')) return Promise.resolve(ok({ total: 0, items: [] }));
    if (url.startsWith('/api/stats?type=overview')) return Promise.resolve(ok({
      total: { videos: 1, tracks: 2, versions: 3, creators: 4, languages: 5, categories: 6, today_videos: 0, first_seen_min: null, first_seen_max: null },
      by_source: {},
    }));
    if (url.startsWith('/api/stats')) return Promise.resolve(ok({ items: [] }));
    if (url.startsWith('/api/clients')) return Promise.resolve(ok({ clients: [] }));
    if (url.startsWith('/api/changes')) return Promise.resolve(ok({ total: 0, items: [] }));
    return Promise.reject(new Error(`unmatched: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '#');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function desktopNav(): HTMLElement {
  // 桌面侧栏 aside 内的 nav（第一个「主导航」；第二个是移动底部 bar）
  return screen.getAllByRole('navigation', { name: '主导航' })[0];
}

test('默认 hash → collect tab，侧栏当前项 aria-current', () => {
  render(<App />);
  expect(screen.getByTestId('page-collect')).toBeInTheDocument();
  const collectBtn = desktopNav().querySelector('button[aria-current="page"]');
  expect(collectBtn).not.toBeNull();
  expect(collectBtn!.textContent).toContain('采集');
  // 侧栏三组分组标题
  ['工作流', '内容组织', '系统'].forEach((t) => expect(screen.getByText(t)).toBeInTheDocument());
});

test('hash 直达 tags → 真实 TagsPage 挂载', async () => {
  window.history.replaceState(null, '', '#/tags');
  render(<App />);
  expect(await screen.findByText('标签管理')).toBeInTheDocument();
});

test('侧栏点击切 tab：创作者分类 → 真实 CategoriesPage', async () => {
  render(<App />);
  fireEvent.click(withinNav(desktopNav(), '创作者分类'));
  // heading 定位：侧栏按钮同名，纯 text 查询会多匹配
  expect(await screen.findByRole('heading', { name: '创作者分类' })).toBeInTheDocument();
  expect(window.location.hash).toBe('#/categories');
});

test('hash 直达 history → TasksHistoryPage（mock 标记）', () => {
  window.history.replaceState(null, '', '#/history');
  render(<App />);
  expect(screen.getByTestId('page-history')).toBeInTheDocument();
});

test('hash 直达 stats / clients / changes → 对应真实页面挂载', async () => {
  window.history.replaceState(null, '', '#/stats');
  const { unmount } = render(<App />);
  expect(await screen.findByText('数据看板')).toBeInTheDocument();
  unmount();

  window.history.replaceState(null, '', '#/clients');
  const c2 = render(<App />);
  expect(await c2.findByText(/客户端 0 个 · 在线 0/)).toBeInTheDocument();
  c2.unmount();

  window.history.replaceState(null, '', '#/changes');
  const c3 = render(<App />);
  expect(await c3.findByText(/采集 \/ 变更日志/)).toBeInTheDocument();
});

test('「更多」弹层：低频入口网格 → 点设置切 tab 并关闭', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '更多入口' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  // 二级入口齐全（history/creators/categories/tags/clients/changes/settings）
  ['历史', '创作者', '创作者分类', '标签', '客户端', '日志', '设置'].forEach((t) => {
    expect(screen.getByRole('dialog')!.querySelector('button')! && withinDialogButton(t)).toBeTruthy();
  });
  fireEvent.click(withinDialogButton('设置'));
  expect(await screen.findByText('采集超时')).toBeInTheDocument();
  expect(window.location.hash).toBe('#/settings');
  // 弹层关闭
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  // 低频 tab 激活时「更多」按钮高亮
  expect(screen.getByRole('button', { name: '更多入口' }).className).toContain('font-medium');
});

test('品牌头点击 → 回视频库（VideoList mock 挂载）', () => {
  render(<App />);
  // 侧栏 + 移动顶栏两个品牌头，点第一个即可
  fireEvent.click(screen.getAllByRole('button', { name: '回到视频库' })[0]);
  expect(window.location.hash).toBe('#/videos');
  expect(screen.getByTestId('page-videos')).toBeInTheDocument();
});

test('移动底部 bar：主入口按钮切 tab', () => {
  render(<App />);
  const bottomNav = screen.getAllByRole('navigation', { name: '主导航' })[1];
  fireEvent.click(withinNav(bottomNav, '视频'));
  expect(screen.getByTestId('page-videos')).toBeInTheDocument();
});

test('视频详情回跳：剥离 track/ver，保留列表筛选 query', () => {
  window.history.replaceState(null, '', '#/videos/bilibili/BV1?source=youtube&page=2&track=1&ver=3');
  render(<App />);
  expect(screen.getByTestId('vd-back')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('vd-back'));
  expect(window.location.hash).toBe('#/videos?source=youtube&page=2');
  expect(screen.getByTestId('page-videos')).toBeInTheDocument();
});

test('创作者详情：onBack 回列表、onOpenVideo 进视频详情', async () => {
  window.history.replaceState(null, '', '#/creators/5');
  render(<App />);
  expect(screen.getByTestId('page-creator-detail')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('cd-open-video'));
  expect(window.location.hash).toBe('#/videos/bilibili/BV9');
  expect(screen.getByTestId('vd-back')).toBeInTheDocument();

  window.history.replaceState(null, '', '#/creators/5');
  cleanup();
  render(<App />);
  fireEvent.click(screen.getByTestId('cd-back'));
  expect(window.location.hash).toBe('#/creators');
  // 回列表 → 真实 CreatorsPage 挂载（fetch mock 支撑）
  expect(await screen.findByText('创作者管理')).toBeInTheDocument();
});

function withinNav(nav: HTMLElement, label: string): HTMLElement {
  const btn = Array.from(nav.querySelectorAll('button')).find((b) => b.textContent!.includes(label));
  if (!btn) throw new Error(`nav 内找不到按钮：${label}`);
  return btn as HTMLElement;
}
function withinDialogButton(label: string): HTMLElement {
  const dlg = screen.getByRole('dialog');
  const btn = Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent!.trim() === label);
  if (!btn) throw new Error(`弹层内找不到按钮：${label}`);
  return btn as HTMLElement;
}
