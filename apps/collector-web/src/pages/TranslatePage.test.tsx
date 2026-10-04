// TranslatePage 单测：pending 清单（langs chips/分页/筛选防抖/空态/错误态）+ 工作台
// （vid 解析、只读双栏、返回清单、from 透传、错误态、无效 vid）+ 补翻写回（Phase 3：
// 行数校验/文件载入/写回请求形状/成功与 400 提示）。
// 跑法：npx vitest run src/pages/TranslatePage.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 清单渲染/chips 交互/分页/筛选防抖/空态/错误态 + 工作台 fetch/渲染/返回/错误/无效 vid | 通过 | |
// | R2 | 补翻写回（Phase 3）：右栏行数对账/文件载入/写回 body/成功+详情链接/400 原文透出 | 通过 | 原「右栏占位」断言随实现替换（splitFillLines 单测在 TranslateWorkbench.splitFillLines.test.ts） |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { TranslatePage } from './TranslatePage';
import { ToastProvider } from '@/components/ui/toast';

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

const onePending = {
  source: 'bilibili',
  source_vid: 'BV1xx',
  title: '美国加息解读',
  creator_name: '财经UP',
  duration: 600,
  published_at: 1735689600000,
  first_seen: 1735689600000,
  langs: [
    { lan: 'en', lan_doc: '英语', lines: 320 },
    { lan: 'ja', lan_doc: null, lines: 180 },
    { lan: null, lan_doc: null, lines: null },
  ],
};

function pendingPayload(items: unknown[], total = items.length) {
  return { ok: true, total, page: 1, size: 20, items };
}

function pendingHandler(impl?: (url: string) => unknown) {
  return (url: string) => {
    if (url.includes('/api/translate/pending')) return impl ? impl(url) : pendingPayload([onePending]);
    if (url.includes('/api/translate/source/')) {
      return {
        ok: true,
        source: 'bilibili',
        source_vid: 'BV1xx',
        lan: 'en',
        version_id: 100,
        lines: [
          { line: 1, text: 'Hello world' },
          { line: 2, text: 'Fed hikes rate' },
        ],
        text: '1\tHello world\n2\tFed hikes rate',
      };
    }
    return {};
  };
}

function setup(handler: (url: string) => unknown, hash = '#/translate') {
  window.location.hash = hash;
  const calls = stubFetch(handler);
  render(<TranslatePage />);
  return calls;
}

// ── pending 清单 ──

test('清单渲染：langs chips「en (320行)」、未知语言、空 langs、null 字段降级', async () => {
  setup(pendingHandler(() => pendingPayload([
    onePending,
    { ...onePending, source: 'youtube', source_vid: 'abc', title: '无轨视频', creator_name: null, duration: null, published_at: null, langs: [] },
  ])));
  await screen.findByText('美国加息解读');
  // 共 2 条待补翻（数字被 span 包裹 → 函数匹配拼接文本）
  expect(screen.getByText((_, el) => el?.textContent === '共 2 条待补翻')).toBeInTheDocument();
  expect(screen.getByText('财经UP')).toBeInTheDocument();
  expect(screen.getByText('10:00')).toBeInTheDocument(); // 时长 600s
  // chips：「英语 (320行)」「ja (180行)」（lan_doc 缺失回落 lan）、「未知语言」
  expect(screen.getByText('英语 (320行)')).toBeInTheDocument();
  expect(screen.getByText('ja (180行)')).toBeInTheDocument();
  expect(screen.getByText('未知语言')).toBeInTheDocument();
  // 空 langs → '—'（源轨列占位；该行 creator/时长/发布时间的 null 降级也各有一个「—」，故定位最后一列）
  expect(screen.getByText('无轨视频')).toBeInTheDocument();
  const emptyCell = screen.getByText('无轨视频').closest('tr')!;
  const tds = emptyCell.querySelectorAll('td');
  expect(tds[tds.length - 1]!.textContent).toBe('—');
});

test('行点击进工作台：URL 写 vid=source:vid（清单随工作台替换而卸载）', async () => {
  setup(pendingHandler());
  await screen.findByText('美国加息解读');
  // 整行点击 → vid（不带 from）
  fireEvent.click(screen.getByText('美国加息解读'));
  expect(window.location.hash).toBe('#/translate?vid=bilibili%3ABV1xx');
  // 清单已被工作台替换，chip 不在 DOM
  expect(screen.queryByText('ja (180行)')).not.toBeInTheDocument();
});

test('chip 点击进工作台：vid + from=ja（lan_doc 缺失回落 lan）', async () => {
  setup(pendingHandler());
  await screen.findByText('美国加息解读');
  // chip 点击 → vid + from=ja（lan_doc 缺失时用 lan）
  fireEvent.click(screen.getByText('ja (180行)'));
  expect(window.location.hash).toBe('#/translate?vid=bilibili%3ABV1xx&from=ja');
});

test('chip 点击以 lan_doc 语言打开工作台并拉源文（from 透传请求）', async () => {
  const calls = setup(pendingHandler(), '#/translate');
  await screen.findByText('美国加息解读');
  fireEvent.click(screen.getByText('英语 (320行)'));
  expect(window.location.hash).toBe('#/translate?vid=bilibili%3ABV1xx&from=en');
  await screen.findByText('Hello world');
  const u = new URL(calls.filter((c) => c.url.includes('/api/translate/source/')).at(-1)!.url, 'http://x');
  expect(u.pathname).toBe('/api/translate/source/bilibili/BV1xx');
  expect(u.searchParams.get('from')).toBe('en');
});

test('分页：41 条 → 3 页；下一页写 page=2 重拉；上一页回删 page', async () => {
  const calls = setup(pendingHandler(() => pendingPayload([onePending], 41)));
  await screen.findByText('美国加息解读');
  expect(screen.getByText('第 1/3 页')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(window.location.hash).toBe('#/translate?page=2'));
  await waitFor(() => expect(new URL(calls.at(-1)!.url, 'http://x').searchParams.get('page')).toBe('2'));
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  await waitFor(() => expect(window.location.hash).toBe('#/translate'));
});

test('平台下拉筛选：选抖音写 source=douyin 并重拉（resetPage）', async () => {
  const calls = setup(pendingHandler());
  await screen.findByText('美国加息解读');
  fireEvent.click(screen.getByRole('combobox', { name: '平台筛选' }));
  fireEvent.click(within(screen.getByRole('listbox')).getByText('抖音'));
  await waitFor(() => expect(window.location.hash).toContain('source=douyin'));
  await waitFor(() => expect(new URL(calls.at(-1)!.url, 'http://x').searchParams.get('source')).toBe('douyin'));
});

test('源语言输入 300ms 防抖写 from 并重拉；清空删除 from', async () => {
  const calls = setup(pendingHandler());
  await screen.findByText('美国加息解读');
  fireEvent.change(screen.getByLabelText('源语言'), { target: { value: 'en' } });
  await waitFor(() => expect(window.location.hash).toContain('from=en'), { timeout: 1500 });
  await waitFor(() => expect(new URL(calls.at(-1)!.url, 'http://x').searchParams.get('from')).toBe('en'));
  fireEvent.change(screen.getByLabelText('源语言'), { target: { value: '' } });
  await waitFor(() => expect(window.location.hash).toBe('#/translate'));
});

test('空态：没有待补翻视频', async () => {
  setup(pendingHandler(() => pendingPayload([])));
  expect(await screen.findByText('没有待补翻视频')).toBeInTheDocument();
});

test('清单错误态：文案 + 重试拉到数据', async () => {
  let fail = true;
  setup((url) => {
    if (fail) return new Response(JSON.stringify({ ok: false, error: '数据库不可用' }), { status: 500, headers: { 'content-type': 'application/json' } });
    return pendingHandler()(url);
  });
  expect(await screen.findByText('加载失败：HTTP 500：数据库不可用')).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('美国加息解读')).toBeInTheDocument();
});

// ── 工作台（#/translate?vid=...）──

test('工作台：拉源文渲染行号+原文双栏、lan/version 信息、右栏填写面板初始态', async () => {
  const calls = setup(pendingHandler(), '#/translate?vid=bilibili%3ABV1xx&from=en');
  await screen.findByText('Hello world');
  // 清单不请求（直接进工作台），只拉 source
  expect(calls.filter((c) => c.url.includes('/api/translate/pending'))).toHaveLength(0);
  expect(calls.filter((c) => c.url.includes('/api/translate/source/'))).toHaveLength(1);
  expect(screen.getByText('bilibili:BV1xx')).toBeInTheDocument();
  // lan 徽章：shadcn Badge 渲染 div，直接断言文本
  expect(screen.getByText('en')).toBeInTheDocument();
  expect(screen.getByText('版本 #100')).toBeInTheDocument();
  expect(screen.getByText('1')).toBeInTheDocument(); // 行号
  expect(screen.getByText('Fed hikes rate')).toBeInTheDocument();
  expect(screen.getByText('返回清单')).toBeInTheDocument();
  // 右栏填写面板初始态：空 textarea + 0/2 未匹配（红） + 写回禁用 + 文件载入入口
  expect(screen.getByLabelText('译文（每行一条）')).toHaveValue('');
  const count = screen.getByTestId('fill-line-count');
  expect(count).toHaveTextContent('译文 0 行 / 原文 2 行');
  expect(count.className).toContain('text-destructive');
  expect(screen.getByRole('button', { name: '写回 zh-manual 轨' })).toBeDisabled();
  expect(document.querySelector('input[type="file"]')).not.toBe(null);
});

test('工作台 from 缺省：请求不带 from query（路径干净）', async () => {
  const calls = setup(pendingHandler(), '#/translate?vid=youtube%3Aabc123');
  await screen.findByText('Hello world');
  const u = new URL(calls.filter((c) => c.url.includes('/api/translate/source/')).at(-1)!.url, 'http://x');
  expect(u.pathname).toBe('/api/translate/source/youtube/abc123');
  expect(u.search.startsWith('?from=')).toBe(false);
});

test('返回清单：删除 vid 与 from，其余 query 保留；回到清单后拉 pending', async () => {
  const calls = setup(pendingHandler(), '#/translate?vid=bilibili%3ABV1xx&from=en');
  await screen.findByText('Hello world');
  fireEvent.click(screen.getByRole('button', { name: /返回清单/ }));
  expect(window.location.hash).toBe('#/translate');
  await screen.findByText('美国加息解读');
  expect(calls.filter((c) => c.url.includes('/api/translate/pending'))).toHaveLength(1);
});

test('工作台错误态（404 无该轨）：文案 + 重试 + 返回清单', async () => {
  setup(
    (url) =>
      url.includes('/api/translate/source/')
        ? new Response(JSON.stringify({ ok: false, error: '没有 en 轨' }), { status: 404, headers: { 'content-type': 'application/json' } })
        : pendingPayload([onePending]),
    '#/translate?vid=bilibili%3ABV1xx&from=en',
  );
  expect(await screen.findByText('拉取源文失败：HTTP 404：没有 en 轨')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('拉取源文失败：HTTP 404：没有 en 轨')).toBeInTheDocument();
  // 错误态有两个「返回清单」（页头 + 错误块），点页头那个
  fireEvent.click(screen.getAllByRole('button', { name: /返回清单/ })[0]);
  expect(window.location.hash).toBe('#/translate');
});

test('无效 vid（无冒号）：提示形态错误，不发请求', async () => {
  const calls = setup(pendingHandler(), '#/translate?vid=bilibiliBV1xx');
  expect(await screen.findByText('无效的 vid 参数（应为 source:source_vid 形态）')).toBeInTheDocument();
  expect(calls.filter((c) => c.url.includes('/api/translate/'))).toHaveLength(0);
});

test('vid 含多个冒号：首个冒号切分，后半整体作 source_vid（encodeURIComponent 转冒号）', async () => {
  const calls = setup(pendingHandler(), '#/translate?vid=douyin%3A7301%3Aextra');
  await screen.findByText('Hello world');
  const u = new URL(calls.filter((c) => c.url.includes('/api/translate/source/')).at(-1)!.url, 'http://x');
  // source_vid 经 encodeURIComponent 进路径：7301:extra → 7301%3Aextra
  expect(u.pathname).toBe('/api/translate/source/douyin/7301%3Aextra');
});

// ── 补翻写回（Phase 3：右栏填写面板）──

// /api/translate/fill 的 200 应答（成功写回 zh-manual，lines=服务端确认行数）
const fillOk = {
  ok: true,
  source: 'bilibili',
  source_vid: 'BV1xx',
  from_lan: 'en',
  lan: 'zh-manual',
  lines: 2,
  zh_manual_versions_before: 0,
};

// 进工作台并给 fill 路由挂应答（源文走既有 pendingHandler fixture）
function workbenchWithFill(fillResponse: () => unknown) {
  return setup(
    (url) => (url.includes('/api/translate/fill') ? fillResponse() : pendingHandler()(url)),
    '#/translate?vid=bilibili%3ABV1xx&from=en',
  );
}

test('写回成功：POST body 带 source/source_vid/from_lan/lines，绿色提示行数 + 详情页链接', async () => {
  const calls = workbenchWithFill(() => fillOk);
  await screen.findByText('Hello world');
  fireEvent.change(screen.getByLabelText('译文（每行一条）'), { target: { value: '你好世界\n美联储加息' } });
  // 行数对账：2/2 匹配（非红），写回按钮解禁
  const count = screen.getByTestId('fill-line-count');
  expect(count).toHaveTextContent('译文 2 行 / 原文 2 行');
  expect(count.className).not.toContain('text-destructive');
  fireEvent.click(screen.getByRole('button', { name: '写回 zh-manual 轨' }));
  const ok = await screen.findByTestId('fill-ok');
  expect(ok).toHaveTextContent('已写入 zh-manual（2 行）');
  expect(ok.className).toContain('text-emerald-600');
  // 详情链接：#/videos/<source>/<vid>
  expect(ok.querySelector('a')).toHaveAttribute('href', '#/videos/bilibili/BV1xx');
  // 请求形状：POST + 契约字段（from_lan 取工作台查看语言，lines 逐行数组）
  const fillCall = calls.find((c) => c.url.includes('/api/translate/fill'))!;
  expect(fillCall.init?.method).toBe('POST');
  expect(new URL(fillCall.url, 'http://x').pathname).toBe('/api/translate/fill');
  expect(JSON.parse(String(fillCall.init?.body))).toEqual({
    source: 'bilibili',
    source_vid: 'BV1xx',
    from_lan: 'en',
    lines: ['你好世界', '美联储加息'],
  });
});

test('行数不符：3 行 vs 原文 2 行 → 对账标红 + 写回禁用（不发请求）', async () => {
  const calls = workbenchWithFill(() => fillOk);
  await screen.findByText('Hello world');
  fireEvent.change(screen.getByLabelText('译文（每行一条）'), { target: { value: '一\n二\n三' } });
  const count = screen.getByTestId('fill-line-count');
  expect(count).toHaveTextContent('译文 3 行 / 原文 2 行');
  expect(count.className).toContain('text-destructive');
  expect(screen.getByRole('button', { name: '写回 zh-manual 轨' })).toBeDisabled();
  expect(calls.filter((c) => c.url.includes('/api/translate/fill'))).toHaveLength(0);
});

test('写回 400（服务端行数不符，如源轨并发变化）：server 文案含 expected/got 原样透出', async () => {
  workbenchWithFill(() =>
    new Response(
      JSON.stringify({ ok: false, error: '译文行数不符: 源字幕 2 行, 收到 3 行', expected: 2, got: 3 }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
  await screen.findByText('Hello world');
  // 客户端侧 2/2 已匹配（按钮可点），400 来自服务端对账
  fireEvent.change(screen.getByLabelText('译文（每行一条）'), { target: { value: '你好世界\n美联储加息' } });
  fireEvent.click(screen.getByRole('button', { name: '写回 zh-manual 轨' }));
  expect(await screen.findByTestId('fill-err')).toHaveTextContent(
    '写回失败：HTTP 400：译文行数不符: 源字幕 2 行, 收到 3 行',
  );
});

test('从文件载入：选文本文件读入 textarea，尾随换行按 2 行对账', async () => {
  workbenchWithFill(() => fillOk);
  await screen.findByText('Hello world');
  const file = new File(['Hello world\nFed hikes rate\n'], 't.txt', { type: 'text/plain' });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  // jsdom 无真实文件选择：直接向隐藏 input 塞 files 再触发 change
  Object.defineProperty(input, 'files', { value: [file] });
  fireEvent.change(input);
  await waitFor(() => expect(screen.getByLabelText('译文（每行一条）')).toHaveValue('Hello world\nFed hikes rate\n'));
  expect(screen.getByTestId('fill-line-count')).toHaveTextContent('译文 2 行 / 原文 2 行');
});
