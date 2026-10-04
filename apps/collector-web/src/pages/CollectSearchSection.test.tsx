// CollectSearchSection 单测：搜索采集卡（CLI collect search 的 web 形态）。
// 覆盖：B 站搜索请求形状（tid 缺省不发）、已采/已入库徽章、勾选批量建任务（created/skipped/
// skippedCollected 文案 + body {vids, source}）、YouTube 高级项映射（order/pages/since_days）、
// 503 扩展离线统一文案、502 原文透出、搜索态不写 URL。
// 跑法：npx vitest run src/pages/CollectSearchSection.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | B 站搜索+徽章+批量 / YouTube 高级项映射 / tid 可选 / 503+502 文案 / URL 不携带 七例 | 通过 | 2026-10 Phase 3 搜索采集 |
// | R2 | 模式切换互斥 + 条件采集 POST /api/jobs body 全字段 / 仅 keyword 缺省不发可选键 / keyword 空提交禁用 | 通过 | 2026-10 Phase 4 collect-find job 化 |
// | R3 | 补 coverage：Enter 直搜 / youtube vid 形态候选（length 直出、title 回落 vid）/ 勾选再点取消 / 批量失败红字+勾选保留 / 搜索空结果 / find 提交 400 | 通过 | 2026-10 Phase 4 收尾 |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { CollectSearchSection } from './CollectSearchSection';
import { ToastProvider } from '@/components/ui/toast';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

// jsdom 缺失 API stub：Radix Select 开面板需要（平台/排序/页数下拉）
window.HTMLElement.prototype.scrollIntoView = () => {};
(window.HTMLElement.prototype as any).hasPointerCapture = () => false;
(window.HTMLElement.prototype as any).releasePointerCapture = () => {};
(window.HTMLElement.prototype as any).setPointerCapture = () => {};

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

const cands = [
  { bvid: 'BV1AAA', title: '加息解读', up: '财经UP', play: 12345, duration: 600, exists: true, has_subtitle: true },
  { bvid: 'BV1BBB', title: '通胀跟踪', up: '宏观UP', play: 999, duration: 300, exists: true, has_subtitle: false },
  { bvid: 'BV1CCC', title: '新发布', up: '新人UP', exists: false, has_subtitle: false },
];

const searchOk = {
  ok: true, source: 'bilibili', keyword: '加息', client_id: 'c1',
  total: cands.length, items: cands,
  raw_total: null, pages_fetched: null, since_days: null, since_filtered: 0,
};

function searchHandler(over?: (url: string) => unknown) {
  return (url: string) => {
    if (url.includes('/api/collect-search')) return over ? over(url) : searchOk;
    if (url.includes('/api/collect-tasks/batch')) return { ok: true, created: 1, skipped: 1, skipped_collected: 1 };
    return {};
  };
}

function setup(handler: (url: string) => unknown) {
  const calls = stubFetch(handler);
  render(
    <ToastProvider>
      <CollectSearchSection onTasksChanged={() => {}} />
    </ToastProvider>,
  );
  return calls;
}

function postedBody(calls: Call[], urlPart: string): Record<string, unknown> {
  const c = calls.find((x) => x.url.includes(urlPart));
  if (!c) throw new Error(`no call to ${urlPart}`);
  return JSON.parse(String(c.init?.body));
}

async function doSearch(kw = '加息') {
  fireEvent.change(screen.getByPlaceholderText('B 站搜索关键词（需桌面扩展在线）'), { target: { value: kw } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  await screen.findByText('加息解读');
}

// ── B 站搜索 + 徽章 + 批量 ──

test('B 站搜索：POST body 只带 source/keyword（tid 留空不发），行渲染徽章三态，搜索态不写 URL', async () => {
  const calls = setup(searchHandler());
  await doSearch();
  // 请求形状：bilibili、tid 空=不发；order/pages/since_days 为 youtube 项亦不发
  expect(postedBody(calls, '/api/collect-search')).toEqual({ source: 'bilibili', keyword: '加息' });
  // 徽章：已采（绿字样）/已入库·无字幕；未采行不标
  expect(screen.getByText('已采')).toBeInTheDocument();
  expect(screen.getByText('已入库·无字幕')).toBeInTheDocument();
  const third = screen.getByText('新发布').closest('label')!;
  expect(within(third).queryByText('已采')).toBe(null);
  expect(within(third).queryByText('已入库·无字幕')).toBe(null);
  // 搜索态不进 URL（临时探索操作，无深链语义）
  expect(window.location.hash).toBe('');
});

test('分区 tid：填 21 后搜索 → body 带 tid=21（数字）', async () => {
  const calls = setup(searchHandler());
  fireEvent.change(screen.getByLabelText('B 站分区 tid（可选）'), { target: { value: '21' } });
  await doSearch();
  expect(postedBody(calls, '/api/collect-search')).toEqual({ source: 'bilibili', keyword: '加息', tid: 21 });
});

test('批量采集：勾选两条 → POST /api/collect-tasks/batch 带 vids+source，三段提示文案，勾选清空', async () => {
  const calls = setup(searchHandler());
  await doSearch();
  fireEvent.click(screen.getByLabelText('选择 加息解读'));
  fireEvent.click(screen.getByLabelText('选择 通胀跟踪'));
  fireEvent.click(screen.getByRole('button', { name: '采集勾选 (2)' }));
  expect(await screen.findByRole('status')).toHaveTextContent(
    '已创建 1 个任务，跳过 1 个（已在队列），已采跳过 1 个',
  );
  expect(postedBody(calls, '/api/collect-tasks/batch')).toEqual({ vids: ['BV1AAA', 'BV1BBB'], source: 'bilibili' });
  // 提交后清空勾选：按钮归 0 且禁用
  expect(screen.getByRole('button', { name: '采集勾选 (0)' })).toBeDisabled();
});

// ── YouTube 高级项 ──

test('YouTube 高级项：排序/页数/近 N 天映射 order/pages/since_days 进 body', async () => {
  const calls = setup(searchHandler());
  fireEvent.click(screen.getByLabelText('搜索平台'));
  fireEvent.click(await screen.findByRole('option', { name: 'YouTube' }));
  fireEvent.click(screen.getByLabelText('排序'));
  fireEvent.click(await screen.findByRole('option', { name: '最多播放' }));
  fireEvent.click(screen.getByLabelText('翻页数'));
  fireEvent.click(await screen.findByRole('option', { name: '3' }));
  fireEvent.change(screen.getByLabelText('近几天内发布（1-365，留空不限）'), { target: { value: '30' } });
  fireEvent.change(screen.getByPlaceholderText('YouTube 搜索关键词（需桌面扩展在线）'), { target: { value: 'fed rate' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  await screen.findByText('加息解读');
  expect(postedBody(calls, '/api/collect-search')).toEqual({
    source: 'youtube', keyword: 'fed rate', order: 'views', pages: 3, since_days: 30,
  });
});

// ── 错误分支 ──

test('搜索 503（扩展离线）：统一文案「扩展离线：请在浏览器扩展 popup 侧确认」', async () => {
  setup(searchHandler(() => new Response(JSON.stringify({ ok: false, error: 'no online client（扩展未连接）' }), { status: 503, headers: { 'content-type': 'application/json' } })));
  fireEvent.change(screen.getByPlaceholderText('B 站搜索关键词（需桌面扩展在线）'), { target: { value: '加息' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  expect(await screen.findByText('扩展离线：请在浏览器扩展 popup 侧确认')).toBeInTheDocument();
});

test('搜索 502（上游失败）：server 错误文案原样透出（不套扩展离线话术）', async () => {
  setup(searchHandler(() => new Response(JSON.stringify({ ok: false, error: '上游搜索失败' }), { status: 502, headers: { 'content-type': 'application/json' } })));
  fireEvent.change(screen.getByPlaceholderText('B 站搜索关键词（需桌面扩展在线）'), { target: { value: '加息' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  expect(await screen.findByText('HTTP 502：上游搜索失败')).toBeInTheDocument();
});

// ── 条件采集模式（Phase 4：CLI collect find 的 job 化形态）──

// server 直回原始形态（*_json 字符串）——JobCard 经 api 层 parseJobRow 归一
const findJobRow = {
  id: 9, type: 'collect-find', status: 'pending',
  params_json: '{"keyword":"加息"}', progress_json: null, result_json: null, error: null,
  created_at: 1_000, updated_at: 2_000, started_at: null, finished_at: null,
};

function findHandler() {
  return (url: string) => {
    if (url === '/api/jobs') return { ok: true, job: findJobRow };
    if (/\/api\/jobs\/\d+$/.test(url)) return { ok: true, job: findJobRow };
    return {};
  };
}

async function switchMode(mode: string) {
  fireEvent.click(screen.getByLabelText('采集模式'));
  fireEvent.click(await screen.findByRole('option', { name: mode }));
}

test('采集模式切换：find 出条件表单藏快速搜索表单，切回 quick 恢复（两模式互斥）', async () => {
  setup(searchHandler());
  expect(screen.getByPlaceholderText('B 站搜索关键词（需桌面扩展在线）')).toBeInTheDocument();
  expect(screen.queryByLabelText('条件采集关键词')).toBe(null);
  await switchMode('条件采集');
  expect(screen.getByLabelText('条件采集关键词')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('B 站搜索关键词（需桌面扩展在线）')).toBe(null);
  expect(screen.queryByLabelText('搜索平台')).toBe(null); // quick 的平台下拉也随模式隐藏
  await switchMode('快速搜索');
  expect(screen.getByPlaceholderText('B 站搜索关键词（需桌面扩展在线）')).toBeInTheDocument();
  expect(screen.queryByLabelText('条件采集关键词')).toBe(null);
});

test('条件采集：全字段表单 → POST /api/jobs body 全键位（keyword 去空白/可选数值化），提交后 JobCard 挂载', async () => {
  const calls = setup(findHandler());
  await switchMode('条件采集');
  fireEvent.change(screen.getByLabelText('条件采集关键词'), { target: { value: '  加息  ' } });
  fireEvent.click(screen.getByLabelText('搜索页数'));
  fireEvent.click(await screen.findByRole('option', { name: '2' }));
  fireEvent.change(screen.getByLabelText('最少粉丝数（留空不限）'), { target: { value: '1000' } });
  fireEvent.change(screen.getByLabelText('最多粉丝数（留空不限）'), { target: { value: '500000' } });
  fireEvent.change(screen.getByLabelText('近几天内发布（1-365，留空不限）'), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText('B 站分区 tid（可选）'), { target: { value: '21' } });
  fireEvent.click(screen.getByLabelText('命中候选自动建采集任务'));
  fireEvent.click(screen.getByRole('button', { name: '提交' }));
  await waitFor(() => expect(postedBody(calls, '/api/jobs')).toEqual({
    type: 'collect-find',
    params: { keyword: '加息', pages: 2, min_fans: 1000, max_fans: 500000, since_days: 30, tid: 21, collect: true },
  }));
  expect(await screen.findByText('#9')).toBeInTheDocument(); // JobCard 已挂载（行首 #id；标题行也有「搜索采集」故用 #id 断言）
});

test('条件采集：可选留空不发缺省键位（body 只 keyword+pages）；keyword 空白时提交禁用', async () => {
  const calls = setup(findHandler());
  await switchMode('条件采集');
  const submit = screen.getByRole('button', { name: '提交' });
  expect(submit).toBeDisabled(); // keyword 空：提交禁用
  fireEvent.change(screen.getByLabelText('条件采集关键词'), { target: { value: '加息' } });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() => expect(postedBody(calls, '/api/jobs')).toEqual({
    type: 'collect-find', params: { keyword: '加息', pages: 1 },
  }));
});

test('条件采集提交 400：红字透出 server 文案，不挂 JobCard', async () => {
  setup((url) => (url === '/api/jobs'
    ? new Response(JSON.stringify({ ok: false, error: 'params.pages: 1..10 required' }), { status: 400, headers: { 'content-type': 'application/json' } })
    : {}));
  await switchMode('条件采集');
  fireEvent.change(screen.getByLabelText('条件采集关键词'), { target: { value: '加息' } });
  fireEvent.click(screen.getByRole('button', { name: '提交' }));
  expect(await screen.findByText('HTTP 400：params.pages: 1..10 required')).toBeInTheDocument();
  expect(screen.queryByText('#9')).toBe(null); // JobCard 未挂载
});

// ── coverage 收尾：候选形态/勾选取消/批量失败/空结果/Enter 直搜 ──

test('YouTube 候选 vid 形态：无 play/duration 时 meta 省略、title 缺失回落 vid、勾选键用 vid', async () => {
  const calls = setup((url) => (url.includes('/api/collect-search')
    ? { ok: true, items: [{ vid: 'ytV1', title: null, exists: false, has_subtitle: false, up: 'YT 频道', length: '10:00' }] }
    : { ok: true, created: 1, skipped: 0, skipped_collected: 0 }));
  fireEvent.click(screen.getByLabelText('搜索平台'));
  fireEvent.click(await screen.findByRole('option', { name: 'YouTube' }));
  fireEvent.change(screen.getByPlaceholderText('YouTube 搜索关键词（需桌面扩展在线）'), { target: { value: 'fed' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  expect(await screen.findByText('ytV1')).toBeInTheDocument(); // title 缺失回落 vid
  expect(screen.getByText('YT 频道 · 时长 10:00')).toBeInTheDocument(); // length 直出、play 缺省省略
  fireEvent.click(screen.getByLabelText('选择 ytV1'));
  fireEvent.click(screen.getByRole('button', { name: '采集勾选 (1)' }));
  await screen.findByRole('status');
  expect(postedBody(calls, '/api/collect-tasks/batch')).toEqual({ vids: ['ytV1'], source: 'youtube' });
});

test('勾选再点取消：toggle 两态往返（选中高亮 → 取消归零禁用）', async () => {
  setup(searchHandler());
  await doSearch();
  fireEvent.click(screen.getByLabelText('选择 加息解读'));
  expect(screen.getByRole('button', { name: '采集勾选 (1)' })).toBeEnabled();
  fireEvent.click(screen.getByLabelText('选择 加息解读'));
  expect(screen.getByRole('button', { name: '采集勾选 (0)' })).toBeDisabled();
});

test('批量采集失败：role=status 红字透出 + toast error，勾选保留可重试', async () => {
  setup((url) => {
    if (url.includes('/api/collect-search')) return searchOk;
    return new Response(JSON.stringify({ ok: false, error: '扩展未连接' }), { status: 503, headers: { 'content-type': 'application/json' } });
  });
  await doSearch();
  fireEvent.click(screen.getByLabelText('选择 加息解读'));
  fireEvent.click(screen.getByRole('button', { name: '采集勾选 (1)' }));
  // role=status 行内红字是 msg.text（collectErrorText 产物，无前缀）；toast 带「批量提交失败：」前缀
  expect(await screen.findByRole('status')).toHaveTextContent('扩展离线：请在浏览器扩展 popup 侧确认');
  expect(screen.getByText('批量提交失败：扩展离线：请在浏览器扩展 popup 侧确认')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '采集勾选 (1)' })).toBeEnabled(); // 勾选未清，可重试
});

test('搜索空结果：「无搜索结果」占位，采集按钮归零禁用', async () => {
  setup((url) => (url.includes('/api/collect-search') ? { ...searchOk, total: 0, items: [] } : {}));
  fireEvent.change(screen.getByPlaceholderText('B 站搜索关键词（需桌面扩展在线）'), { target: { value: '冷门词' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  expect(await screen.findByText('无搜索结果')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '采集勾选 (0)' })).toBeDisabled();
});

test('关键词输入框按 Enter 直接触发搜索（与按钮同路径）', async () => {
  const calls = setup(searchHandler());
  fireEvent.change(screen.getByPlaceholderText('B 站搜索关键词（需桌面扩展在线）'), { target: { value: '加息' } });
  fireEvent.keyDown(screen.getByPlaceholderText('B 站搜索关键词（需桌面扩展在线）'), { key: 'Enter' });
  await screen.findByText('加息解读');
  expect(postedBody(calls, '/api/collect-search')).toEqual({ source: 'bilibili', keyword: '加息' });
});

test('近 N 天输入非数：回落 0 不发 since_days（防御）', async () => {
  const calls = setup(searchHandler());
  fireEvent.click(screen.getByLabelText('搜索平台'));
  fireEvent.click(await screen.findByRole('option', { name: 'YouTube' }));
  const days = screen.getByLabelText('近几天内发布（1-365，留空不限）');
  fireEvent.change(days, { target: { value: 'abc' } }); // 非数 → Number NaN → ||0 → 0=不限
  fireEvent.change(screen.getByPlaceholderText('YouTube 搜索关键词（需桌面扩展在线）'), { target: { value: 'fed' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  await screen.findByText('加息解读');
  expect(postedBody(calls, '/api/collect-search')).toEqual({ source: 'youtube', keyword: 'fed', order: 'relevance', pages: 1 });
});

test('缺 id 候选（无 bvid 无 vid）：键回落空串不炸，行照常渲染可勾选', async () => {
  const calls = setup((url) => (url.includes('/api/collect-search')
    ? { ok: true, items: [{ title: '无 id 行', exists: false, has_subtitle: false }] } // 异常形态：server 不应返回，防炸
    : { ok: true, created: 1, skipped: 0, skipped_collected: 0 }));
  fireEvent.change(screen.getByPlaceholderText('B 站搜索关键词（需桌面扩展在线）'), { target: { value: '加息' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  expect(await screen.findByText('无 id 行')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('选择 无 id 行'));
  fireEvent.click(screen.getByRole('button', { name: '采集勾选 (1)' }));
  await screen.findByRole('status');
  expect(postedBody(calls, '/api/collect-tasks/batch')).toEqual({ vids: [''], source: 'bilibili' });
});
