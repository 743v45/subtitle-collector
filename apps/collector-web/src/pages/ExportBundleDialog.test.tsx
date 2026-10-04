// ExportBundleDialog 组件单测：原料包导出表单（CLI export bundle 的 web 形态）。
// limit 校验 / name_order 预设 / track 可选 / URL 组装 / X-Bundle 三数与缺字幕警告 / 失败行内错误 / 重开重置。
// 跑法：npx vitest run src/pages/ExportBundleDialog.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 默认表单（limit 500 / 名序默认档 / track 空占位）+ 描述文案 + 确认可用 | 通过 | |
// | R2 | limit 校验：空/0/1001/abc/12.5 → 确认禁用 + 行内提示；边界 1 与 1000 可用 | 通过 | server 同口径 400 的前端镜像 |
// | R3 | 确认下载：URL 组装（filter+limit+name_order+track）；成功展示文件名 + 三数；E>0 黄色警告 | 通过 | 下载链 stub（createObjectURL + anchor click） |
// | R4 | track 留空不进 URL；E=0 无警告 | 通过 | |
// | R5 | 失败：400 JSON 行内错误带 server 文案；修正后重试成功且错误清除 | 通过 | |
// | R6 | 打包中：按钮文案「打包中…」+ 取消/确认双禁用；完成恢复 | 通过 | deferred fetch 控时序 |
// | R7 | 关闭重开：结果/错误清除，表单保留上次选择 | 通过 | rerender open false→true |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ExportBundleDialog } from './ExportBundleDialog';
import type { VideoFilter } from '../types';

// jsdom 缺失 API stub：Radix Select 开面板需要
window.HTMLElement.prototype.scrollIntoView = () => {};
(window.HTMLElement.prototype as any).hasPointerCapture = () => false;
(window.HTMLElement.prototype as any).releasePointerCapture = () => {};
(window.HTMLElement.prototype as any).setPointerCapture = () => {};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 基建：下载链 / fetch / 渲染 ──

function stubAnchorDownload() {
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
}

const exportCalls: string[] = [];

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  exportCalls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    exportCalls.push(url);
    return handler(url);
  }));
}

function zipResponse(errors = '3'): Response {
  return new Response('PK\u0003\u0004-fake', {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="bundle-1728000000000.zip"',
      'x-bundle-total': '140',
      'x-bundle-exported': '137',
      'x-bundle-errors': errors,
    },
  });
}

function renderDialog(opts: { open?: boolean; filter?: VideoFilter; onOpenChange?: (o: boolean) => void } = {}) {
  return render(
    <ExportBundleDialog
      open={opts.open ?? true}
      onOpenChange={opts.onOpenChange ?? (() => {})}
      filter={opts.filter ?? { q: '关键词', source: 'youtube' }}
    />,
  );
}

const limitInput = () => screen.getByLabelText('打包上限（1–1000）') as HTMLInputElement;
const confirmBtn = () => screen.getByRole('button', { name: '打包下载' });
const trackInput = () => screen.getByPlaceholderText(/留空=各视频默认轨/);

// ── R1：默认表单 ──

test('默认表单：描述文案、limit 缺省 500、名序默认档、track 空占位、确认可用', () => {
  stubAnchorDownload();
  renderDialog();
  expect(screen.getByText(/manifest\.json/)).toBeInTheDocument();
  expect(limitInput().value).toBe('500');
  expect(screen.getByText('ID + 标题（默认）')).toBeInTheDocument();
  expect(trackInput()).toBeInTheDocument();
  expect(confirmBtn()).toBeEnabled();
});

// ── R2：limit 校验 ──

test('limit 校验：空/0/1001/abc/12.5 → 确认禁用 + 行内提示；边界 1 与 1000 可用', () => {
  stubAnchorDownload();
  renderDialog();
  fireEvent.change(limitInput(), { target: { value: '' } });
  expect(confirmBtn()).toBeDisabled();
  expect(screen.getByText('上限须为 1–1000 的整数')).toBeInTheDocument();
  for (const bad of ['0', '1001', 'abc', '12.5', '-5']) {
    fireEvent.change(limitInput(), { target: { value: bad } });
    expect(confirmBtn(), `limit=${bad} 应禁用`).toBeDisabled();
  }
  fireEvent.change(limitInput(), { target: { value: '1' } });
  expect(confirmBtn()).toBeEnabled();
  fireEvent.change(limitInput(), { target: { value: '1000' } });
  expect(confirmBtn()).toBeEnabled();
});

// ── R3：确认下载 + 成功展示 ──

test('确认下载：URL 组装 filter+limit+name_order+track；成功展示文件名 + 匹配/导出/错误三数；E>0 黄色警告', async () => {
  stubAnchorDownload();
  stubFetch(() => zipResponse('3'));
  renderDialog();
  fireEvent.change(limitInput(), { target: { value: '100' } });
  fireEvent.change(trackInput(), { target: { value: 'zh-CN' } });
  fireEvent.click(confirmBtn());

  await waitFor(() => expect(exportCalls).toHaveLength(1));
  expect(exportCalls[0]!.startsWith('/api/export/bundle?')).toBe(true);
  const p = new URL(exportCalls[0]!, 'http://x').searchParams;
  expect(p.get('q')).toBe('关键词');
  expect(p.get('source')).toBe('youtube');
  expect(p.get('limit')).toBe('100');
  expect(p.get('name_order')).toBe('id,name'); // 默认档
  expect(p.get('track')).toBe('zh-CN');

  // 成功：文件名（Content-Disposition）+ 三数内联 + 缺字幕黄色警告
  expect(await screen.findByText('bundle-1728000000000.zip')).toBeInTheDocument();
  expect(screen.getByText('匹配 140 · 导出 137 · 错误 3')).toBeInTheDocument();
  expect(screen.getByText(/部分视频缺字幕未导出（3 个）/)).toBeInTheDocument();
});

// ── R4：E=0 与 track 留空 ──

test('track 留空不进 URL；E=0 不出缺字幕警告', async () => {
  stubAnchorDownload();
  stubFetch(() => zipResponse('0'));
  renderDialog();
  fireEvent.click(confirmBtn());
  await waitFor(() => expect(exportCalls).toHaveLength(1));
  const p = new URL(exportCalls[0]!, 'http://x').searchParams;
  expect(p.has('track')).toBe(false);
  expect(await screen.findByText('匹配 140 · 导出 137 · 错误 0')).toBeInTheDocument();
  expect(screen.queryByText(/部分视频缺字幕未导出/)).toBe(null);
});

// ── R5：失败与重试 ──

test('失败：400 JSON 行内错误带 server 文案；修正后重试成功且错误清除', async () => {
  stubAnchorDownload();
  let fail = true;
  stubFetch(() => (fail
    ? new Response(JSON.stringify({ ok: false, error: 'limit 必须在 1..1000' }), { status: 400, headers: { 'content-type': 'application/json' } })
    : zipResponse('0')));
  renderDialog();
  fireEvent.click(confirmBtn());
  expect(await screen.findByText('导出失败：HTTP 400：limit 必须在 1..1000')).toBeInTheDocument();

  fail = false;
  fireEvent.click(confirmBtn());
  expect(await screen.findByText('匹配 140 · 导出 137 · 错误 0')).toBeInTheDocument();
  expect(screen.queryByText(/导出失败/)).toBe(null);
});

// ── R6：打包中状态 ──

test('打包中：按钮文案「打包中…」+ 取消/确认双禁用；完成恢复可用', async () => {
  stubAnchorDownload();
  let resolveExport!: (r: Response) => void;
  stubFetch(() => new Promise<Response>((res) => { resolveExport = res; }));
  renderDialog();
  fireEvent.click(confirmBtn());
  expect(await screen.findByText('打包中…')).toBeDisabled();
  expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();

  resolveExport(zipResponse('0'));
  expect(await screen.findByText('匹配 140 · 导出 137 · 错误 0')).toBeInTheDocument();
  expect(confirmBtn()).toBeEnabled();
  expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
});

// ── R7：重开重置 ──

test('关闭重开：上次结果清除、表单保留上次选择', async () => {
  stubAnchorDownload();
  stubFetch(() => zipResponse('3'));
  const onOpenChange = vi.fn();
  const { rerender } = render(<ExportBundleDialog open onOpenChange={onOpenChange} filter={{ q: '词' }} />);
  fireEvent.change(limitInput(), { target: { value: '77' } });
  fireEvent.click(confirmBtn());
  expect(await screen.findByText(/错误 3/)).toBeInTheDocument();

  rerender(<ExportBundleDialog open={false} onOpenChange={onOpenChange} filter={{ q: '词' }} />);
  rerender(<ExportBundleDialog open onOpenChange={onOpenChange} filter={{ q: '词' }} />);
  expect(screen.queryByText(/错误 3/)).toBe(null); // 结果清除
  expect(limitInput().value).toBe('77'); // 表单保留
});
