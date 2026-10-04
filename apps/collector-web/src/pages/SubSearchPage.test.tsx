// SubSearchPage 单测：URL 还原、检索请求参数、结果渲染（高亮/汇总/截断徽章）、
// 空态/错误态（400 非法正则文案直出）、重置、buildSegments 纯函数。
// 跑法：npx vitest run src/pages/SubSearchPage.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 引导态/提交写 URL（含平台下拉与回车路径）/结果渲染/截断/空态/错误态/重置/buildSegments | 通过 | |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { SubSearchPage } from './SubSearchPage';
import { buildSegments } from './subSearchHighlight';

// jsdom 缺失 API stub：Radix Select 开面板需要（PlatformSelect）
window.HTMLElement.prototype.scrollIntoView = () => {};
(window.HTMLElement.prototype as any).hasPointerCapture = () => false;
(window.HTMLElement.prototype as any).releasePointerCapture = () => {};
(window.HTMLElement.prototype as any).setPointerCapture = () => {};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

interface Call { url: string; init?: RequestInit }

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const r = await handler(url, init);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

const oneHit = {
  ok: true,
  keyword: '加息',
  regex: false,
  matched_videos: 1,
  total_snippets: 1,
  truncated: false,
  items: [
    {
      video: { id: 1, source: 'bilibili', source_vid: 'BV1xx', title: '美国加息解读', creator_name: '财经UP', duration: 600, published_at: 1735689600000 },
      track: { id: 10, lan: 'zh-Hans', lan_doc: '中文（简体）' },
      version: { id: 100, origin: 'api' },
      snippets: [
        { from: 65, to: 68, content: '美联储宣布加息', context: '[60-70] 利率决议 美联储宣布加息 25 个基点' },
      ],
    },
  ],
};

function setup(handler: (url: string) => unknown, hash = '#/search') {
  window.location.hash = hash;
  const calls = stubFetch(handler);
  render(<SubSearchPage />);
  return calls;
}

test('初始态：无 kw 不发请求，显示引导文案，搜索按钮禁用', async () => {
  const calls = setup(() => ({}));
  // useAsync 首帧 loading=true（骨架）→ Promise.resolve(null) 落地后才出引导态
  expect(await screen.findByText('输入关键词开始检索字幕内容（支持正则模式）')).toBeInTheDocument();
  expect(calls.filter((c) => c.url.includes('/api/sub-search'))).toHaveLength(0);
  expect(screen.getByRole('button', { name: /搜索/ })).toBeDisabled();
});

test('提交：写 URL query 并触发 sub-search 请求（复选框/平台/创作者全参数）', async () => {
  const calls = setup(() => oneHit);
  fireEvent.change(screen.getByLabelText('检索关键词'), { target: { value: '  加息  ' } });
  fireEvent.click(screen.getByLabelText('正则模式'));
  fireEvent.click(screen.getByLabelText('区分大小写'));
  fireEvent.change(screen.getByLabelText('上下文秒数'), { target: { value: '20' } });
  fireEvent.change(screen.getByLabelText('创作者名'), { target: { value: '某UP' } });
  // Radix 平台下拉：开面板选抖音
  fireEvent.click(screen.getByRole('combobox', { name: '平台筛选' }));
  fireEvent.click(within(screen.getByRole('listbox')).getByText('抖音'));
  fireEvent.click(screen.getByRole('button', { name: /搜索/ }));
  // URL 承载（kw trim；regex/case 用 1；ctx 非默认写 20）
  expect(window.location.hash).toBe('#/search?kw=%E5%8A%A0%E6%81%AF&regex=1&case=1&ctx=20&source=douyin&creator=%E6%9F%90UP');
  await screen.findByText('美国加息解读');
  const u = new URL(calls.filter((c) => c.url.includes('/api/sub-search')).at(-1)!.url, 'http://x');
  expect(u.pathname).toBe('/api/sub-search');
  expect(u.searchParams.get('keyword')).toBe('加息');
  expect(u.searchParams.get('regex')).toBe('1');
  expect(u.searchParams.get('case_sensitive')).toBe('1');
  expect(u.searchParams.get('ctx')).toBe('20');
  expect(u.searchParams.get('source')).toBe('douyin');
  expect(u.searchParams.get('creator')).toBe('某UP');
});

test('回车提交：空关键词守卫不跳转，有效关键词 Enter 触发检索', async () => {
  const calls = setup(() => oneHit);
  const input = screen.getByLabelText('检索关键词');
  fireEvent.change(input, { target: { value: '   ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(window.location.hash).toBe('#/search'); // 空关键词守卫
  fireEvent.change(input, { target: { value: '加息' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(window.location.hash).toBe('#/search?kw=%E5%8A%A0%E6%81%AF');
  await screen.findByText('美国加息解读');
  expect(calls.filter((c) => c.url.includes('/api/sub-search'))).toHaveLength(1);
});

test('结果渲染：命中汇总、轨 lan、时间戳、高亮命中词、上下文折叠默认收起、标题跳详情', async () => {
  setup(() => oneHit, '#/search?kw=%E5%8A%A0%E6%81%AF');
  await screen.findByText('美国加息解读');
  expect(screen.getByText('中文（简体）')).toBeInTheDocument();
  // 命中汇总行
  expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent!.includes('命中 1 个视频'))).toBeInTheDocument();
  // 时间戳 [01:05]
  expect(screen.getByText('[01:05]')).toBeInTheDocument();
  // 命中词高亮（mark 元素）
  expect(document.querySelector('mark')!.textContent).toBe('加息');
  // 上下文 details 默认收起：open 属性缺席（jsdom 不做视觉折叠，文本仍在 DOM，故以 open 属性断言）
  const summary = screen.getByText('上下文');
  const details = summary.closest('details')!;
  expect(details).not.toBeNull();
  expect(details.hasAttribute('open')).toBe(false);
  // 点 summary（jsdom 30 支持原生激活行为）→ 展开
  fireEvent.click(summary);
  expect(details.hasAttribute('open')).toBe(true);
  expect(screen.getByText('[60-70] 利率决议 美联储宣布加息 25 个基点')).toBeInTheDocument();
  // 标题点击 → 视频详情
  fireEvent.click(screen.getByRole('button', { name: '美国加息解读' }));
  expect(window.location.hash).toBe('#/videos/bilibili/BV1xx');
});

test('截断徽章：truncated=true 显示提示', async () => {
  setup(() => ({ ...oneHit, truncated: true }), '#/search?kw=%E5%8A%A0%E6%81%AF');
  expect(await screen.findByText('结果已截断，可收紧关键词')).toBeInTheDocument();
});

test('空结果态：无命中给放宽提示', async () => {
  setup(() => ({ ok: true, matched_videos: 0, total_snippets: 0, truncated: false, items: [] }), '#/search?kw=%E4%B8%8D%E5%AD%98%E5%9C%A8');
  expect(await screen.findByText('没有匹配的字幕片段——试试更换关键词或放宽筛选')).toBeInTheDocument();
});

test('错误态：400 非法正则文案直出 + 重试', async () => {
  setup(
    () => new Response(JSON.stringify({ ok: false, error: '非法正则: ([' }), { status: 400, headers: { 'content-type': 'application/json' } }),
    '#/search?kw=(%5B&regex=1',
  );
  // 错误态经 fetch 异步落地 → findBy
  expect(await screen.findByText('检索失败：HTTP 400：非法正则: ([')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
});

test('重置：回干净 #/search 并清空表单', async () => {
  setup(() => oneHit, '#/search?kw=%E5%8A%A0%E6%81%AF');
  await screen.findByText('美国加息解读');
  fireEvent.click(screen.getByRole('button', { name: /重置/ }));
  expect(window.location.hash).toBe('#/search');
  expect(screen.getByLabelText('检索关键词')).toHaveValue('');
});

// ── buildSegments 纯函数：子串/正则/大小写/零宽匹配 ──

test('buildSegments：子串大小写不敏感命中', () => {
  const segs = buildSegments('Fed Hikes Rate', 'hikes', { regex: false, caseSensitive: false });
  expect(segs).toEqual([
    { text: 'Fed ', hit: false },
    { text: 'Hikes', hit: true },
    { text: ' Rate', hit: false },
  ]);
});

test('buildSegments：正则分组命中；非法正则回落不分段', () => {
  const segs = buildSegments('利率3.25%', '\\d+\\.\\d+', { regex: true, caseSensitive: true });
  expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['3.25']);
  // 非法正则 → 单段不高亮（不抛）
  expect(buildSegments('abc', '([', { regex: true, caseSensitive: false })).toEqual([{ text: 'abc', hit: false }]);
});

test('buildSegments：无命中全段不高亮；空 kw 单段', () => {
  expect(buildSegments('abc', 'zz', { regex: false, caseSensitive: false })).toEqual([{ text: 'abc', hit: false }]);
  expect(buildSegments('abc', '', { regex: false, caseSensitive: false })).toEqual([{ text: 'abc', hit: false }]);
});
