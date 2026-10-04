// TrackExportBar 组件单测：按轨导出条（CLI export subtitle 的 web 形态，挂 VideoDetail 字幕正文区）。
// 无轨兜底 / 默认轨选中 / 轨与格式下拉 / 导出 URL 组装（track+format）/ 成功与失败 toast。
// 跑法：npx vitest run src/components/TrackExportBar.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | tracks 空数组 → 整体不渲染（兜底在组件内，父级零分支） | 通过 | |
// | R2 | 默认选中默认轨（label = lan_doc + 默认标 + lan）；轨/格式选项齐全；version 不进 URL（server 该轨默认版本） | 通过 | Radix Select jsdom stub |
// | R3 | 导出：GET /api/export/subtitle/:source/:vid?track=&format=；成功 toast 带文件名（Content-Disposition 优先） | 通过 | 下载链 stub + ToastProvider |
// | R4 | 切轨+切格式 → URL 跟随；无 Content-Disposition 回落 <vid>.<fmt>；失败 → 错误 toast（含 server available_lans 文案） | 通过 | |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TrackExportBar } from './TrackExportBar';
import { ToastProvider } from '@/components/ui/toast';
import type { TrackInfo } from '../types';

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

// ── 基建 ──

function stubAnchorDownload() {
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
}

const tracks: TrackInfo[] = [
  {
    id: 11, lan: 'zh-CN', lan_doc: '中文（简体）', track_type: 1, is_default: true,
    versions: [
      { id: 111, origin: 'external', source_url: null, asr_engine: null, captured_at: 0, body_size: null, is_default: true },
      { id: 112, origin: 'asr', source_url: null, asr_engine: 'fireredasr', captured_at: 0, body_size: null },
    ],
  },
  {
    id: 12, lan: 'ai-ZH', lan_doc: '中文（自动）', track_type: 2,
    versions: [{ id: 121, origin: 'asr', source_url: null, asr_engine: 'fireredasr', captured_at: 0, body_size: null }],
  },
];

function renderBar(tracksArg: TrackInfo[] = tracks, source = 'bilibili', sourceVid = 'BV1test') {
  return render(
    <ToastProvider>
      <TrackExportBar source={source} sourceVid={sourceVid} tracks={tracksArg} />
    </ToastProvider>,
  );
}

// ── R1：无轨兜底 ──

test('tracks 为空 → 整体不渲染（VideoDetail 挂载处保持零分支）', () => {
  renderBar([]);
  expect(screen.queryByText('按轨导出：')).toBe(null);
  expect(screen.queryByLabelText('选择导出字幕轨')).toBe(null);
});

// ── R2：默认选中与选项 ──

test('默认选中默认轨（label = lan_doc + 默认标 + lan）；轨/格式选项齐全', async () => {
  stubAnchorDownload();
  renderBar();
  expect(screen.getByLabelText('选择导出字幕轨')).toHaveTextContent('中文（简体）（默认） · zh-CN');
  expect(screen.getByLabelText('选择导出格式')).toHaveTextContent('SRT'); // 格式缺省 srt

  fireEvent.click(screen.getByLabelText('选择导出字幕轨'));
  expect(await screen.findByRole('option', { name: '中文（自动） · ai-ZH' })).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('选择导出格式'));
  expect(await screen.findByRole('option', { name: 'VTT' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'TXT' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'JSON' })).toBeInTheDocument();
});

// ── R3：导出成功 ──

test('导出：GET /api/export/subtitle/:source/:vid?track=&format=；成功 toast 带文件名', async () => {
  stubAnchorDownload();
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    return new Response('1\n00:00:01,000 --> 00:00:02,000\n字幕行', {
      status: 200,
      headers: {
        'content-type': 'application/x-subrip',
        'content-disposition': 'attachment; filename="BV1test.srt"',
        'x-version-id': '111',
        'x-track-lan': 'zh-CN',
      },
    });
  }));
  renderBar();
  fireEvent.click(screen.getByRole('button', { name: '导出' }));
  // version 不传 = 该轨默认版本（server 侧解析）
  await waitFor(() => expect(calls).toEqual(['/api/export/subtitle/bilibili/BV1test?track=11&format=srt']));
  expect(await screen.findByText('已导出 BV1test.srt')).toBeInTheDocument();
});

// ── R4：切轨/切格式 + 失败 ──

test('切轨+切格式 → URL 跟随；无 Content-Disposition 回落 <vid>.<fmt>；失败 → 错误 toast', async () => {
  stubAnchorDownload();
  const calls: string[] = [];
  let fail = false;
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (fail) {
      return new Response(JSON.stringify({ ok: false, error: '轨不存在，可用: zh-CN, ai-ZH' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response('WEBVTT', { status: 200, headers: { 'content-type': 'text/vtt' } });
  }));
  renderBar();
  fireEvent.click(screen.getByLabelText('选择导出字幕轨'));
  fireEvent.click(await screen.findByRole('option', { name: '中文（自动） · ai-ZH' }));
  fireEvent.click(screen.getByLabelText('选择导出格式'));
  fireEvent.click(await screen.findByRole('option', { name: 'VTT' }));
  fireEvent.click(screen.getByRole('button', { name: '导出' }));

  await waitFor(() => expect(calls[0]).toBe('/api/export/subtitle/bilibili/BV1test?track=12&format=vtt'));
  // 响应无 content-disposition → 文件名回落 fallback（<vid>.<fmt>）
  expect(await screen.findByText('已导出 BV1test.vtt')).toBeInTheDocument();

  fail = true;
  fireEvent.click(screen.getByRole('button', { name: '导出' }));
  expect(await screen.findByText('导出失败：HTTP 404：轨不存在，可用: zh-CN, ai-ZH')).toBeInTheDocument();
});
