// SubtitleView 组件单测：toTxt/toSrt/toVtt 纯函数格式 + 复制（clipboard / execCommand 兜底）+ 下载（Blob→a.click）。
// 跑法：npx vitest run src/components/SubtitleView.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | toTxt/toSrt/toVtt 时间码与块格式 | 通过 | 逗号/点毫秒分隔、序号、WEBVTT 头 |
// | R2 | 渲染：行时间码 + 内容；三个复制按钮 | 通过 | stub navigator.clipboard |
// | R3 | 复制兜底路径（clipboard 不可用 → execCommand） | 通过 | writeText reject + execCommand spy |
// | R4 | 下载三格式：createObjectURL + a.download 文件名 + revoke | 通过 | spy URL.createObjectURL / a.click |
// | R5 | 复制结果 toast 反馈（成功/兜底成功/双路径失败） | 通过 | 包 ToastProvider 断言 toast 文案 |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SubtitleView, toTxt, toSrt, toVtt } from './SubtitleView';
import { ToastProvider } from '@/components/ui/toast';

const LINES = [
  { from: 3661.5, to: 3663.25, content: '第一句' },
  { from: 65, to: 68, content: 'second line' },
];

afterEach(() => {
  cleanup(); // vitest 未开 globals:true，RTL 自动 cleanup 不生效，手动挂
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── 纯函数 ──

test('toTxt：内容换行拼接，无时间轴', () => {
  expect(toTxt(LINES)).toBe('第一句\nsecond line');
});

test('toSrt：序号 + HH:MM:SS,mmm --> HH:MM:SS,mmm，块间空行', () => {
  expect(toSrt(LINES)).toBe(
    [
      '1\n01:01:01,500 --> 01:01:03,250\n第一句',
      '2\n00:01:05,000 --> 00:01:08,000\nsecond line',
    ].join('\n\n'),
  );
});

test('toVtt：WEBVTT 头 + HH:MM:SS.mmm（点分隔）、无序号', () => {
  expect(toVtt(LINES)).toBe(
    'WEBVTT\n\n' + [
      '01:01:01.500 --> 01:01:03.250\n第一句',
      '00:01:05.000 --> 00:01:08.000\nsecond line',
    ].join('\n\n'),
  );
});

test('空 body：三种格式均为空串（txt）/头（vtt）', () => {
  expect(toTxt([])).toBe('');
  expect(toSrt([])).toBe('');
  expect(toVtt([])).toBe('WEBVTT\n\n');
});

// ── 渲染 ──

test('渲染：每行 mm:ss → mm:ss 时间码 + 内容（分钟可溢出，如 61:01）', () => {
  render(<SubtitleView body={LINES} />);
  expect(screen.getByText('61:01 → 61:03')).toBeInTheDocument();
  expect(screen.getByText('01:05 → 01:08')).toBeInTheDocument();
  expect(screen.getByText('第一句')).toBeInTheDocument();
  expect(screen.getByText('second line')).toBeInTheDocument();
});

test('复制三格式：navigator.clipboard.writeText 收到对应格式文本', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<SubtitleView body={LINES} />);
  fireEvent.click(screen.getByRole('button', { name: '复制 SRT' }));
  fireEvent.click(screen.getByRole('button', { name: '复制 VTT' }));
  fireEvent.click(screen.getByRole('button', { name: '复制 TXT' }));
  expect(writeText).toHaveBeenCalledTimes(3);
  expect(writeText).toHaveBeenNthCalledWith(1, toSrt(LINES));
  expect(writeText).toHaveBeenNthCalledWith(2, toVtt(LINES));
  expect(writeText).toHaveBeenNthCalledWith(3, toTxt(LINES));
});

test('复制兜底：clipboard 不可用 → textarea + execCommand（jsdom 无 clipboard API 的真实路径）', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('not allowed'));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const execCommand = vi.fn().mockReturnValue(true);
  (document as any).execCommand = execCommand;
  render(<SubtitleView body={LINES} />);
  fireEvent.click(screen.getByRole('button', { name: '复制 TXT' }));
  // copy 是 async：writeText reject 后走 catch 的 execCommand 兜底（微任务时序）
  await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
  // 临时 textarea 用后即删，不残留 DOM
  expect(document.querySelector('textarea')).toBe(null);
});

// ── 复制结果 toast 反馈（R5）──

test('复制成功（clipboard 路径）→ toast「已复制 SRT」', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(
    <ToastProvider>
      <SubtitleView body={LINES} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '复制 SRT' }));
  expect(await screen.findByText('已复制 SRT')).toBeInTheDocument();
});

test('复制成功（execCommand 兜底路径）→ toast「已复制 TXT」', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('not allowed'));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const execCommand = vi.fn().mockReturnValue(true);
  (document as any).execCommand = execCommand;
  render(
    <ToastProvider>
      <SubtitleView body={LINES} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '复制 TXT' }));
  expect(await screen.findByText('已复制 TXT')).toBeInTheDocument();
});

test('复制失败（clipboard reject 且 execCommand 返回 false）→ error toast', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('not allowed'));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const execCommand = vi.fn().mockReturnValue(false);
  (document as any).execCommand = execCommand;
  render(
    <ToastProvider>
      <SubtitleView body={LINES} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '复制 VTT' }));
  expect(await screen.findByText('复制 VTT 失败')).toBeInTheDocument();
});

test('下载三格式：Blob→createObjectURL→a[download=sourceVid.fmt].click()→revoke', () => {
  const createObjectURL = vi.fn(() => 'blob:fake');
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

  const { unmount } = render(<SubtitleView body={LINES} sourceVid="BV1ab234567" />);
  fireEvent.click(screen.getByRole('button', { name: '下载 SRT' }));
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(clickSpy).toHaveBeenCalledTimes(1);
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  // spy 实例（this）即被点的 <a>：download 文件名用 sourceVid
  expect((clickSpy.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('BV1ab234567.srt');
  unmount();

  // 文件名：无 sourceVid 回落 'subtitle'
  render(<SubtitleView body={LINES} />);
  fireEvent.click(screen.getByRole('button', { name: '下载 TXT' }));
  const a = clickSpy.mock.instances.at(-1) as unknown as HTMLAnchorElement;
  expect(a.download).toBe('subtitle.txt');
});
