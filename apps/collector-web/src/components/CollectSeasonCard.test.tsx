// CollectSeasonCard 单测：视频详情合集卡（CLI collect season 的 web 形态）。
// 覆盖：无 ugc_season 渲染 null、展开拉全集（body {arg}）、已采/入库行无勾选框+徽章、
// 未采行默认勾选、批量建任务（body {vids, source:'bilibili'} + 提示 + 勾选清空）、
// 收起隐藏列表、503 扩展离线文案 / 502 原文透出。
// 与详情页的集成（extra 直通渲染）在 VideoDetail.test.tsx。
// 跑法：npx vitest run src/components/CollectSeasonCard.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | null 门 / 展开+默认勾选+批量 / 收起 / 503+502 五例 | 通过 | 2026-10 Phase 3 合集卡 |
// | R2 | 勾选切换双向 / 提交失败红字 / 缺字段回落 / loading 重入守卫 四例 | 通过 | 覆盖率门 branches 92.9→93 偿还（主会话 R2） |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CollectSeasonCard } from './CollectSeasonCard';
import { ToastProvider } from '@/components/ui/toast';
import type { VideoExtra } from '../types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Call { url: string; init?: RequestInit }

function stubFetch(handler: (url: string) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const r = await handler(url);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

const seasonItems = [
  { bvid: 'BV1have', title: '第一集（已采）', play: 1000, length: '10:00', exists: true, has_subtitle: true },
  { bvid: 'BV2none', title: '第二集（入库无字幕）', play: 500, length: '8:00', exists: true, has_subtitle: false },
  { bvid: 'BV3new', title: '第三集（未采）', play: 100, length: '6:00', exists: false, has_subtitle: false },
];

const seasonOk = {
  ok: true, season: { id: 12345, mid: 9 }, client_id: 'c1',
  total: seasonItems.length, items: seasonItems,
};

function seasonHandler(over?: (url: string) => unknown) {
  return (url: string) => {
    if (url.includes('/api/season/preview')) return over ? over(url) : seasonOk;
    if (url.includes('/api/collect-tasks/batch')) return { ok: true, created: 1, skipped: 0, skipped_collected: 0 };
    return {};
  };
}

function setup(handler: (url: string) => unknown, extra: VideoExtra | undefined) {
  const calls = stubFetch(handler);
  render(
    <ToastProvider>
      <CollectSeasonCard extra={extra} />
    </ToastProvider>,
  );
  return calls;
}

const seasonExtra: VideoExtra = { ugc_season: { id: 12345, title: '加息系列' } };

// ── 渲染门 ──

test('无 ugc_season / 缺 id：渲染 null（不占卡片）', () => {
  const { container: c1 } = render(<CollectSeasonCard extra={{}} />);
  expect(c1).toBeEmptyDOMElement();
  const { container: c2 } = render(<CollectSeasonCard extra={{ ugc_season: { title: '无 id' } }} />);
  expect(c2).toBeEmptyDOMElement();
});

// ── 展开 + 默认勾选 + 批量 ──

test('展开合集：POST season/preview 带 arg，已采/入库行无勾选框带徽章，未采行默认勾选', async () => {
  const calls = setup(seasonHandler(), seasonExtra);
  // 初始只渲染折叠头
  expect(screen.queryByText('第三集（未采）')).toBe(null);
  fireEvent.click(screen.getByRole('button', { name: /合集：加息系列/ }));
  await screen.findByText('第三集（未采）');
  const preview = calls.find((c) => c.url.includes('/api/season/preview'))!;
  expect(JSON.parse(String(preview.init?.body))).toEqual({ arg: '12345' });
  // 已入库两行：无勾选框（query 断言不存在）+ 徽章（已采 / 已入库·无字幕）
  expect(screen.queryByLabelText('选择 第一集（已采）')).toBe(null);
  expect(screen.queryByLabelText('选择 第二集（入库无字幕）')).toBe(null);
  expect(screen.getByText('已采')).toBeInTheDocument();
  expect(screen.getByText('已入库·无字幕')).toBeInTheDocument();
  // 未采行默认勾选：按钮计数 1
  expect(screen.getByRole('button', { name: '采集勾选 (1)' })).toBeInTheDocument();
  expect(screen.getByLabelText('选择 第三集（未采）')).toBeChecked();
});

test('采集勾选：POST /api/collect-tasks/batch 带 vids+bilibili，提示文案，勾选清空', async () => {
  const calls = setup(seasonHandler(), seasonExtra);
  fireEvent.click(screen.getByRole('button', { name: /合集：加息系列/ }));
  await screen.findByText('第三集（未采）');
  fireEvent.click(screen.getByRole('button', { name: '采集勾选 (1)' }));
  expect(await screen.findByRole('status')).toHaveTextContent('已创建 1 个任务');
  const batch = calls.find((c) => c.url.includes('/api/collect-tasks/batch'))!;
  expect(JSON.parse(String(batch.init?.body))).toEqual({ vids: ['BV3new'], source: 'bilibili' });
  // 提交后清空勾选：按钮归 0 禁用
  expect(screen.getByRole('button', { name: '采集勾选 (0)' })).toBeDisabled();
});

test('收起：再点折叠头隐藏全集列表（数据保留，重开不重拉）', async () => {
  const calls = setup(seasonHandler(), seasonExtra);
  const head = screen.getByRole('button', { name: /合集：加息系列/ });
  fireEvent.click(head);
  await screen.findByText('第三集（未采）');
  fireEvent.click(head);
  expect(screen.queryByText('第三集（未采）')).toBe(null);
  fireEvent.click(head);
  await screen.findByText('第三集（未采）');
  expect(calls.filter((c) => c.url.includes('/api/season/preview'))).toHaveLength(1);
});

// ── 错误分支 ──

test('展开 503（扩展离线）：统一文案；收起重开按「已有错误」不重拉，文案保留', async () => {
  setup(seasonHandler(() => new Response(JSON.stringify({ ok: false, error: 'no online client（扩展未连接）' }), { status: 503, headers: { 'content-type': 'application/json' } })), seasonExtra);
  fireEvent.click(screen.getByRole('button', { name: /合集：加息系列/ }));
  expect(await screen.findByText('扩展离线：请在浏览器扩展 popup 侧确认')).toBeInTheDocument();
});

test('展开 502（上游失败）：server 错误文案原样透出', async () => {
  setup(seasonHandler(() => new Response(JSON.stringify({ ok: false, error: '合集拉取失败' }), { status: 502, headers: { 'content-type': 'application/json' } })), seasonExtra);
  fireEvent.click(screen.getByRole('button', { name: /合集：加息系列/ }));
  expect(await screen.findByText('HTTP 502：合集拉取失败')).toBeInTheDocument();
});

// ── 勾选切换 / 提交失败 / 缺字段回落（R2：覆盖率门 branches 92.9→93 偿还）──

test('未采行勾选切换：点两下 = 取消再勾回，按钮计数 1→0→1', async () => {
  setup(seasonHandler(), seasonExtra);
  fireEvent.click(screen.getByRole('button', { name: /合集：加息系列/ }));
  await screen.findByText('第三集（未采）');
  const box = screen.getByLabelText('选择 第三集（未采）');
  fireEvent.click(box); // 默认已勾 → 取消
  expect(screen.getByRole('button', { name: '采集勾选 (0)' })).toBeDisabled();
  fireEvent.click(box); // 再勾回
  expect(screen.getByRole('button', { name: '采集勾选 (1)' })).toBeInTheDocument();
});

test('提交失败：batch 500 → 红字错误原文，勾选保留可重试', async () => {
  // seasonHandler 的 over 只接管 preview 路由——batch 500 需整体自定义 handler
  stubFetch((url) => {
    if (url.includes('/api/season/preview')) return seasonOk;
    return new Response(JSON.stringify({ ok: false, error: '队列写入失败' }), { status: 500, headers: { 'content-type': 'application/json' } });
  });
  render(
    <ToastProvider>
      <CollectSeasonCard extra={seasonExtra} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /合集：加息系列/ }));
  await screen.findByText('第三集（未采）');
  fireEvent.click(screen.getByRole('button', { name: '采集勾选 (1)' }));
  expect(await screen.findByRole('status')).toHaveTextContent('HTTP 500：队列写入失败');
  // 失败不清勾选：按钮仍可重试
  expect(screen.getByRole('button', { name: '采集勾选 (1)' })).toBeEnabled();
});

test('行缺字段回落：无标题行显 BV 号、无播放/时长不显 meta、无标题合集头回落「合集」', async () => {
  const bare = [...seasonItems, { bvid: 'BV4bare', exists: false, has_subtitle: false }];
  const extra: VideoExtra = { ugc_season: { id: 999 } }; // 无 title → 头部回落「合集」
  setup(seasonHandler(() => ({ ok: true, season: { id: 999, mid: 9 }, total: bare.length, items: bare })), extra);
  fireEvent.click(screen.getByRole('button', { name: /合集：合集/ }));
  await screen.findByLabelText('选择 BV4bare');
  // 标题位与 meta 位（无 play/length 时 meta 只剩 bvid）都以 BV 号文本回落——恰好两处
  expect(screen.getAllByText('BV4bare')).toHaveLength(2);
});

test('加载中收起再展开：不重复拉取（loading 守卫拦重入）', async () => {
  let resolvePreview!: (v: unknown) => void;
  const calls = stubFetch(() => new Promise((resolve) => { resolvePreview = resolve; }));
  render(
    <ToastProvider>
      <CollectSeasonCard extra={seasonExtra} />
    </ToastProvider>,
  );
  const head = screen.getByRole('button', { name: /合集：加息系列/ });
  fireEvent.click(head); // 展开触发首次拉取（pending）
  fireEvent.click(head); // 收起
  fireEvent.click(head); // 再展开：items/err 皆空 → 走 load()，但 loading 仍 true → 守卫直接返回
  expect(calls.filter((c) => c.url.includes('/api/season/preview'))).toHaveLength(1);
  resolvePreview(seasonOk); // 收尾放行，避免悬挂 act 警告
});
