// AsrBackfillCard 单测：无字幕转写兜底（ASR）提交卡（CLI asr backfill 的 web 形态）。
// 覆盖：buildAsrParams 纯函数（size 夹取回落 / max_duration 仅 >0 发 / 平台白名单）、
// 预览圈定（dry_run:true body + 列表行 + 空态 + 失败红字）、提交转写（body 不带 dry_run +
// warning 黄条透出 / 缺省不出 + JobCard 挂载）、400 错误红字不挂卡。
// 跑法：npx vitest run src/pages/AsrBackfillCard.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | buildAsrParams 七态 + 预览四分支 + 提交三态 + 平台切换 | 通过 | 2026-10 Phase 4 |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { AsrBackfillCard, buildAsrParams } from './AsrBackfillCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// jsdom 缺失 API stub：Radix Select 开面板需要（转写平台下拉）
window.HTMLElement.prototype.scrollIntoView = () => {};
(window.HTMLElement.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
(window.HTMLElement.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
(window.HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};

interface Call { url: string; init?: RequestInit }

function stubFetch(handler: (url: string) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    calls.push({ url, init });
    const r = await handler(url);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

function setup(handler: (url: string) => unknown) {
  const calls = stubFetch(handler);
  render(
    <ToastProvider>
      <AsrBackfillCard />
    </ToastProvider>,
  );
  return calls;
}

function postedBody(calls: Call[]): Record<string, unknown> {
  const c = calls.find((x) => x.url === '/api/jobs');
  if (!c) throw new Error('no call to /api/jobs');
  return JSON.parse(String(c.init?.body));
}

// server 直回原始形态（*_json 字符串）——JobCard 经 api 层 parseJobRow 归一
const asrJobRow = {
  id: 12, type: 'asr-backfill', status: 'running',
  params_json: '{"source":"bilibili","size":5}',
  progress_json: '{"done":1,"total":5}', result_json: null, error: null,
  created_at: 1_000, updated_at: 2_000, started_at: 1_500, finished_at: null,
};

function httpErr(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: { 'content-type': 'application/json' } });
}

// ── buildAsrParams 纯函数（表单态 → 提交参数）──

test('buildAsrParams：size 空串/非数/0 回落 5、超界夹取 1..50；max_duration 仅正数发；平台白名单回落 bilibili', () => {
  expect(buildAsrParams('bilibili', '', '')).toEqual({ source: 'bilibili', size: 5 });
  expect(buildAsrParams('bilibili', 'abc', '')).toEqual({ source: 'bilibili', size: 5 });
  expect(buildAsrParams('bilibili', '0', '')).toEqual({ source: 'bilibili', size: 5 });
  expect(buildAsrParams('bilibili', '999', '125')).toEqual({ source: 'bilibili', size: 50, max_duration: 125 });
  expect(buildAsrParams('douyin', '3', '0')).toEqual({ source: 'douyin', size: 3 }); // 0 与空同义不限
  expect(buildAsrParams('douyin', '3', '')).toEqual({ source: 'douyin', size: 3 });
  expect(buildAsrParams('whatever', '8', '-5')).toEqual({ source: 'bilibili', size: 8 }); // 非法平台回落
});

// ── 预览圈定（dry_run 同步直答，不建 job）──

test('预览圈定：POST body 强制 dry_run:true，列表渲染 vid/标题/时长（null 时长出 ?）', async () => {
  const items = [
    { source_vid: 'BV1x', title: '无字幕视频甲', duration: 61 },
    { source_vid: 'BV1y', title: null, duration: null },
  ];
  const calls = setup((url) => (url === '/api/jobs' ? { ok: true, dry_run: true, items } : {}));
  fireEvent.click(screen.getByRole('button', { name: '预览圈定' }));
  await screen.findByText('无字幕视频甲');
  expect(postedBody(calls)).toEqual({ type: 'asr-backfill', params: { source: 'bilibili', size: 5, dry_run: true } });
  expect(screen.getByText('BV1x')).toBeInTheDocument();
  expect(screen.getByText('1:01')).toBeInTheDocument(); // 61s → 1:01
  expect(screen.getByText('?')).toBeInTheDocument();    // duration null → ?（不猜）
});

test('预览空态：items 空数组 → 「没有 no-subtitle 视频」', async () => {
  setup((url) => (url === '/api/jobs' ? { ok: true, dry_run: true, items: [] } : {}));
  fireEvent.click(screen.getByRole('button', { name: '预览圈定' }));
  expect(await screen.findByText('没有 no-subtitle 视频')).toBeInTheDocument();
});

test('预览失败：红字透出 server 文案，列表不出', async () => {
  setup(() => httpErr(500, '圈定失败'));
  fireEvent.click(screen.getByRole('button', { name: '预览圈定' }));
  expect(await screen.findByText('HTTP 500：圈定失败')).toBeInTheDocument();
  expect(screen.queryByText('没有 no-subtitle 视频')).toBe(null);
});

// ── 提交转写（建后台 job → JobCard 轮询）──

test('提交转写：body 不带 dry_run，warning 黄条 role=alert 透出，JobCard 挂载', async () => {
  const calls = setup((url) => {
    if (url === '/api/jobs') return { ok: true, job: asrJobRow, warning: '未配置 B 站 cookie，转写将 need_login' };
    if (/\/api\/jobs\/\d+$/.test(url)) return { ok: true, job: asrJobRow };
    return {};
  });
  fireEvent.click(screen.getByRole('button', { name: '提交转写' }));
  await waitFor(() => expect(postedBody(calls)).toEqual({ type: 'asr-backfill', params: { source: 'bilibili', size: 5 } }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未配置 B 站 cookie，转写将 need_login');
  expect(await screen.findByText('转写中 1/5')).toBeInTheDocument(); // JobCard 已挂载并取到进度
});

test('提交转写：无 warning 不出黄条（页面无 alert）', async () => {
  setup((url) => {
    if (url === '/api/jobs') return { ok: true, job: { ...asrJobRow, status: 'done', result_json: '{"circled":5,"done":5}' } };
    if (/\/api\/jobs\/\d+$/.test(url)) return { ok: true, job: { ...asrJobRow, status: 'done', result_json: '{"circled":5,"done":5}' } };
    return {};
  });
  fireEvent.click(screen.getByRole('button', { name: '提交转写' }));
  expect(await screen.findByText('圈定 5 · 成功 5')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBe(null);
});

test('提交 400：红字透出 server 文案，不挂 JobCard', async () => {
  setup(() => httpErr(400, 'params.size: 1..50 required'));
  fireEvent.click(screen.getByRole('button', { name: '提交转写' }));
  expect(await screen.findByText('HTTP 400：params.size: 1..50 required')).toBeInTheDocument();
  expect(screen.queryByText('ASR 转写')).toBe(null); // JobCard 未挂载（其类型标签不出）
});

// ── 平台切换（Radix Select 交互）──

test('平台切抖音：预览 body source=douyin', async () => {
  const calls = setup((url) => (url === '/api/jobs' ? { ok: true, dry_run: true, items: [] } : {}));
  fireEvent.click(screen.getByLabelText('转写平台'));
  fireEvent.click(await screen.findByRole('option', { name: '抖音' }));
  fireEvent.click(screen.getByRole('button', { name: '预览圈定' }));
  await screen.findByText('没有 no-subtitle 视频');
  expect(postedBody(calls)).toEqual({ type: 'asr-backfill', params: { source: 'douyin', size: 5, dry_run: true } });
});

test('表单改参：每轮条数/时长上限输入改动进 body（size=8、max_duration=125）', async () => {
  const calls = setup((url) => (url === '/api/jobs' ? { ok: true, dry_run: true, items: [] } : {}));
  fireEvent.change(screen.getByLabelText('每轮条数（1-50）'), { target: { value: '8' } });
  fireEvent.change(screen.getByLabelText('时长上限秒（留空不限）'), { target: { value: '125' } });
  fireEvent.click(screen.getByRole('button', { name: '预览圈定' }));
  await screen.findByText('没有 no-subtitle 视频');
  expect(postedBody(calls)).toEqual({ type: 'asr-backfill', params: { source: 'bilibili', size: 8, max_duration: 125, dry_run: true } });
});
