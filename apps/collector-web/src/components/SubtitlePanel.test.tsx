import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { toSrt, toVtt, toTxt } from './SubtitleView'; // 纯函数期望值与实现同源（SubtitlePanel 复用的就是它们）
import { SubtitlePanel } from './SubtitlePanel';
import { ToastProvider } from '@/components/ui/toast';

// SubtitlePanel 组件单测（2026-10-05 Q4：复制/下载六平铺按钮 → 两下拉）：
// 下拉开合与互斥、菜单外点击关闭、菜单项齐全（SRT/VTT/TXT）、复制三格式行为
// （clipboard / execCommand 兜底 / 双路径失败）、下载三格式（Blob→a.click→revoke、文件名回落）。
// 复用 SubtitleView 的 toSrt/toVtt/toTxt 纯函数做期望值（同一份处理函数）。
// 跑法：npx vitest run src/components/SubtitlePanel.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 渲染：触发按钮 + 正文行；旧平铺按钮不再存在 | 通过 | |
// | R2 | 菜单交互：开/合/互斥/外点关闭/选完即关 | 通过 | mousedown 外点 |
// | R3 | 复制：clipboard 成功、execCommand 兜底成功/失败/抛错 | 通过 | 包 ToastProvider 断言文案 |
// | R4 | 下载：三格式 Blob 链路 + 文件名（sourceVid/回落 subtitle） | 通过 | spy createObjectURL/a.click |

const LINES = [
  { from: 3661.5, to: 3663.25, content: '第一句' },
  { from: 65, to: 68, content: 'second line' },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPanel(props: { sourceVid?: string } = {}) {
  return render(
    <ToastProvider>
      <SubtitlePanel body={LINES} {...props} />
    </ToastProvider>,
  );
}

function stubClipboard(reject = false) {
  const writeText = reject ? vi.fn().mockRejectedValue(new Error('not allowed')) : vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

test('渲染：复制/下载两个下拉触发按钮 + 正文行；旧六个平铺按钮不存在', () => {
  render(<SubtitlePanel body={LINES} />);
  expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument();
  expect(screen.getByText('61:01 → 61:03')).toBeInTheDocument();
  expect(screen.getByText('第一句')).toBeInTheDocument();
  // 合并前的平铺按钮不再渲染（防止回归回六按钮形态）
  expect(screen.queryByRole('button', { name: '复制 SRT' })).toBe(null);
  expect(screen.queryByRole('button', { name: '下载 TXT' })).toBe(null);
});

test('菜单交互：点开显示三项、再点收起、两菜单互斥、菜单外 mousedown 关闭', () => {
  render(<SubtitlePanel body={LINES} />);
  const copyBtn = screen.getByRole('button', { name: '复制' });
  const dlBtn = screen.getByRole('button', { name: '下载' });

  fireEvent.click(copyBtn);
  expect(copyBtn.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: '复制 SRT' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '复制 VTT' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '复制 TXT' })).toBeInTheDocument();

  // 互斥：开下载菜单 → 复制菜单收起
  fireEvent.click(dlBtn);
  expect(dlBtn.getAttribute('aria-expanded')).toBe('true');
  expect(copyBtn.getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByRole('button', { name: '下载 SRT' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '复制 SRT' })).toBe(null);

  // 菜单外 mousedown → 全关
  fireEvent.mouseDown(document.body);
  expect(dlBtn.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: '下载 SRT' })).toBe(null);

  // 再点已展开的触发按钮 → 收起
  fireEvent.click(dlBtn);
  fireEvent.click(dlBtn);
  expect(dlBtn.getAttribute('aria-expanded')).toBe('false');
});

test('复制三格式：菜单项点击 → clipboard.writeText 收到对应格式文本，选完即关', async () => {
  const writeText = stubClipboard();
  render(<SubtitlePanel body={LINES} />);
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  fireEvent.click(screen.getByRole('button', { name: '复制 SRT' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(toSrt(LINES)));

  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  fireEvent.click(screen.getByRole('button', { name: '复制 VTT' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(toVtt(LINES)));

  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  fireEvent.click(screen.getByRole('button', { name: '复制 TXT' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(toTxt(LINES)));
  expect(writeText).toHaveBeenCalledTimes(3);
  // 选完即关：菜单项点击后菜单收起
  expect(screen.queryByRole('button', { name: '复制 SRT' })).toBe(null);
});

test('复制成功 toast 反馈（clipboard 路径）', async () => {
  stubClipboard();
  renderPanel(); // toast 断言必须包 ToastProvider（useToast 无 Provider 是 no-op）
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  fireEvent.click(screen.getByRole('button', { name: '复制 TXT' }));
  expect(await screen.findByText('已复制 TXT')).toBeInTheDocument();
});

test('复制兜底：clipboard reject → execCommand 成功 → toast 成功；返回 false → toast 失败', async () => {
  stubClipboard(true);
  const execCommand = vi.fn().mockReturnValue(true);
  (document as any).execCommand = execCommand;
  renderPanel(); // ToastProvider 包裹
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  fireEvent.click(screen.getByRole('button', { name: '复制 VTT' }));
  expect(await screen.findByText('已复制 VTT')).toBeInTheDocument();
  await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
  expect(document.querySelector('textarea')).toBe(null); // 临时 textarea 用后即删

  cleanup();
  stubClipboard(true);
  const execFail = vi.fn().mockReturnValue(false);
  (document as any).execCommand = execFail;
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  fireEvent.click(screen.getByRole('button', { name: '复制 SRT' }));
  expect(await screen.findByText('复制 SRT 失败')).toBeInTheDocument();
});

test('复制兜底二：execCommand 自身抛错 → 也落失败 toast（catch 内层 catch）', async () => {
  stubClipboard(true);
  (document as any).execCommand = vi.fn(() => { throw new Error('boom'); });
  renderPanel(); // ToastProvider 包裹
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  fireEvent.click(screen.getByRole('button', { name: '复制 TXT' }));
  expect(await screen.findByText('复制 TXT 失败')).toBeInTheDocument();
});

test('下载三格式：Blob→createObjectURL→a[download].click()→revoke；文件名用 sourceVid', () => {
  const createObjectURL = vi.fn(() => 'blob:fake');
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

  render(<SubtitlePanel body={LINES} sourceVid="BV1ab234567" />);
  for (const name of ['下载 SRT', '下载 VTT', '下载 TXT'] as const) {
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    fireEvent.click(screen.getByRole('button', { name }));
  }
  expect(createObjectURL).toHaveBeenCalledTimes(3);
  expect(clickSpy).toHaveBeenCalledTimes(3);
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  const downloads = clickSpy.mock.instances.map((inst) => (inst as unknown as HTMLAnchorElement).download);
  expect(downloads).toEqual(['BV1ab234567.srt', 'BV1ab234567.vtt', 'BV1ab234567.txt']);
});

test('下载：无 sourceVid → 文件名回落 subtitle.fmt', () => {
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:fake'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<SubtitlePanel body={LINES} />);
  fireEvent.click(screen.getByRole('button', { name: '下载' }));
  fireEvent.click(screen.getByRole('button', { name: '下载 TXT' }));
  const a = clickSpy.mock.instances.at(-1) as unknown as HTMLAnchorElement;
  expect(a.download).toBe('subtitle.txt');
});
