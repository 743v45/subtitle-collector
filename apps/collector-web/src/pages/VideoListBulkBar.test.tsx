// VideoListBulkBar 单测：视频列表批量打标/摘标操作条（CLI tags apply/remove 的多选 web 形态）。
// 覆盖：标签名解析（parseTagNames）、打标请求形状与结果提示、摘标指定档位直删、
// 全部档位强确认对话框（不可撤销文案 + 确认后才请求且 body 省略 scope 键）、空输入禁用。
// 勾选列/全选/跨页清空等与列表的集成行为在 VideoList.test.tsx（R9）。
// 跑法：npx vitest run src/pages/VideoListBulkBar.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | parseTagNames + 打标/摘标（指定档位、全部档位确认框）/空输入禁用 六例 | 通过 | 2026-10 Phase 3 批量打标 |
// | R2 | 失败分支（打标/摘标 500 → 红字保留选择）+ BulkCheckHead 半选/全选/全清 + BulkCheckCell 双向 toggle | 通过 | 覆盖率门 branches 92.9→93 偿还（主会话 R2） |
import { test, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { VideoBulkBar, BulkCheckHead, BulkCheckCell, parseTagNames } from './VideoListBulkBar';
import { ToastProvider } from '@/components/ui/toast';
import type { VideoListItem } from '../types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── fetch stub：按 URL 路由，记录 JSON body ──

interface Call { url: string; body?: unknown }

function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    let parsed: unknown;
    try { parsed = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { parsed = undefined; }
    calls.push({ url, body: parsed });
    const okBody = url.includes('/api/tags/apply') ? { inserted: 2, missing: 0 } : { removed: 1, missing: 0 };
    return new Response(JSON.stringify(okBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

const item = (id: number, source: string, vid: string): VideoListItem =>
  ({ id, source, source_vid: vid, title: `视频${id}`, track_count: 0 }) as VideoListItem;

const items = [item(1, 'bilibili', 'BV1full'), item(2, 'youtube', 'yt999')];

// 挂载 harness：预勾选第一条（勾选交互在 VideoList.test.tsx 集成覆盖，这里聚焦操作条本身）
function setup(preselect = ['bilibili:BV1full']) {
  const calls = stubFetch();

  function Harness() {
    const [sel, setSel] = useState<Set<string>>(new Set(preselect));
    return (
      <ToastProvider>
        <VideoBulkBar items={items} sel={sel} setSel={setSel} />
      </ToastProvider>
    );
  }
  render(<Harness />);
  return calls;
}

function posted(calls: Call[], urlPart: string): unknown {
  const c = calls.find((x) => x.url.includes(urlPart));
  if (!c) throw new Error(`no call to ${urlPart}`);
  return c.body;
}

// ── parseTagNames ──

test('parseTagNames：中英文逗号分隔、去首尾空白、去重、滤空段', () => {
  expect(parseTagNames(' a，b , a，,c ')).toEqual(['a', 'b', 'c']);
  expect(parseTagNames('')).toEqual([]);
});

// ── 打标 ──

test('打标：POST /api/tags/apply 带 items/names/scope，提示新增/缺失并清空选择（已选归 0）', async () => {
  const calls = setup();
  fireEvent.change(screen.getByLabelText('批量打标标签名'), { target: { value: '加息, 美债' } });
  fireEvent.click(screen.getByRole('button', { name: '打标' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已为 1 个视频打标 2 个标签'));
  expect(posted(calls, '/api/tags/apply')).toEqual({
    items: [{ source: 'bilibili', source_vid: 'BV1full' }],
    names: ['加息', '美债'],
    scope: 'manual',
  });
  // 清空选择：操作条只剩结果提示，已选归 0
  expect(screen.getByText('0', { selector: 'span.tabular-nums' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '打标' })).toBe(null);
});

// 两个档位下拉的触发器都有 aria-label（Radix SelectTrigger 透传），aria-label 定位避免
// 「手动档」双触发的文本歧义；jsdom 开面板需 scrollIntoView/pointerCapture stub。
function stubRadix() {
  window.HTMLElement.prototype.scrollIntoView = () => {};
  (window.HTMLElement.prototype as any).hasPointerCapture = () => false;
  (window.HTMLElement.prototype as any).releasePointerCapture = () => {};
  (window.HTMLElement.prototype as any).setPointerCapture = () => {};
}

test('打标：档位下拉切到批量档 → scope=batch 进请求体', async () => {
  stubRadix();
  const calls = setup();
  fireEvent.change(screen.getByLabelText('批量打标标签名'), { target: { value: 'AI标的' } });
  fireEvent.click(screen.getByLabelText('打标档位'));
  fireEvent.click(await screen.findByRole('option', { name: '批量档' }));
  fireEvent.click(screen.getByRole('button', { name: '打标' }));
  await waitFor(() => expect((posted(calls, '/api/tags/apply') as { scope: string }).scope).toBe('batch'));
});

// ── 摘标 ──

test('摘标指定档位：直接 POST /api/tags/remove 带 scope，不弹确认框', async () => {
  stubRadix();
  const calls = setup(['bilibili:BV1full', 'youtube:yt999']);
  fireEvent.change(screen.getByLabelText('批量摘标标签名'), { target: { value: '旧标' } });
  fireEvent.click(screen.getByLabelText('摘标档位'));
  fireEvent.click(await screen.findByRole('option', { name: 'AI 档' }));
  fireEvent.click(screen.getByRole('button', { name: '摘标' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已为 2 个视频摘除 1 个标签'));
  expect(posted(calls, '/api/tags/remove')).toEqual({
    items: [{ source: 'bilibili', source_vid: 'BV1full' }, { source: 'youtube', source_vid: 'yt999' }],
    names: ['旧标'],
    scope: 'ai',
  });
  expect(screen.queryByText('确认删除全部档位关联')).toBe(null);
});

test('摘标全部档位：先弹确认框（不可撤销文案），确认后才请求且 body 省略 scope 键', async () => {
  stubRadix();
  const calls = setup();
  fireEvent.change(screen.getByLabelText('批量摘标标签名'), { target: { value: '误标' } });
  fireEvent.click(screen.getByLabelText('摘标档位'));
  fireEvent.click(await screen.findByRole('option', { name: '全部档位' }));
  fireEvent.click(screen.getByRole('button', { name: '摘标' }));
  // 确认框出现，且尚未发请求
  expect(screen.getByText('确认删除全部档位关联')).toBeInTheDocument();
  expect(screen.getByText(/将删除 1 个视频的这些标签的【全部档位】关联，不可撤销/)).toBeInTheDocument();
  expect(calls.filter((c) => c.url.includes('/api/tags/remove'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('删除 1 条关联'));
  const body = posted(calls, '/api/tags/remove') as Record<string, unknown>;
  expect(body.items).toEqual([{ source: 'bilibili', source_vid: 'BV1full' }]);
  expect(body.names).toEqual(['误标']);
  // removeTags 契约：全部档位 = scope 键整个省略（不能传 undefined/null）
  expect('scope' in body).toBe(false);
});

// ── 空输入禁用 ──

test('空标签名：打标/摘标按钮禁用；取消选择清空勾选后操作组隐藏', async () => {
  setup();
  expect(screen.getByRole('button', { name: '打标' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '摘标' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '取消选择' }));
  await waitFor(() => expect(screen.queryByTestId('video-bulk-bar')).toBe(null));
});

// ── 失败分支（R2：覆盖 doApply/runRemove 的 catch——错误进操作条红字 + toast，选择保留）──

test('打标失败：apply 500 → 操作条红字带原因，勾选保留可改后重试', async () => {
  // 直接 stub 失败响应（setup() 内部会重新 stubGlobal 覆盖，故不走它）
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: '标签库炸了' }), { status: 500, headers: { 'content-type': 'application/json' } })));
  function Harness() {
    const [sel, setSel] = useState<Set<string>>(new Set(['bilibili:BV1full']));
    return (
      <ToastProvider>
        <VideoBulkBar items={items} sel={sel} setSel={setSel} />
      </ToastProvider>
    );
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('批量打标标签名'), { target: { value: '加息' } });
  fireEvent.click(screen.getByRole('button', { name: '打标' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('打标失败'));
  expect(screen.getByRole('status')).toHaveTextContent('标签库炸了');
  // 失败不清选择：按钮仍在可重试
  expect(screen.getByRole('button', { name: '打标' })).toBeInTheDocument();
});

test('摘标失败：remove 500 → 操作条红字带原因', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: '删除被拒' }), { status: 500, headers: { 'content-type': 'application/json' } })));
  function Harness() {
    const [sel, setSel] = useState<Set<string>>(new Set(['bilibili:BV1full']));
    return (
      <ToastProvider>
        <VideoBulkBar items={items} sel={sel} setSel={setSel} />
      </ToastProvider>
    );
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('批量摘标标签名'), { target: { value: '旧标' } });
  fireEvent.click(screen.getByRole('button', { name: '摘标' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('摘标失败'));
  expect(screen.getByRole('status')).toHaveTextContent('删除被拒');
});

// ── 勾选组件（R2：BulkCheckHead 全选/半选/全清 + BulkCheckCell 行勾选 toggle 双向）──

test('全选头：部分选中显半选，点击全选，再点击清空；行勾选 toggle 可勾可退', async () => {
  const harnessItems = [item(1, 'bilibili', 'BVa'), item(2, 'youtube', 'ytb')];
  function Harness() {
    const [sel, setSel] = useState<Set<string>>(new Set(['bilibili:BVa']));
    return (
      <table>
        <thead>
          <tr>
            <BulkCheckHead sel={sel} setSel={setSel} items={harnessItems} />
          </tr>
        </thead>
        <tbody>
          {harnessItems.map((v) => (
            <tr key={v.id}>
              <BulkCheckCell v={v} sel={sel} setSel={setSel} />
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  render(<Harness />);
  const head = screen.getByLabelText('全选当前页') as HTMLInputElement;
  // 1/2 选中 → 半选态（indeterminate，checked 跟随 some 视实现而为 false）
  expect(head.indeterminate).toBe(true);
  // 行 checkbox：已选中的 BVa 再点 → 退选；未选的 ytb 点 → 勾上
  const cellA = screen.getByLabelText('选择 视频1') as HTMLInputElement;
  const cellB = screen.getByLabelText('选择 视频2') as HTMLInputElement;
  expect(cellA.checked).toBe(true);
  fireEvent.click(cellA);
  expect(cellA.checked).toBe(false);
  fireEvent.click(cellB);
  expect(cellB.checked).toBe(true);
  // 此刻 1/2 → 仍半选；点头部 → 全选（两行都 checked）；再点头部 → 全清
  expect((screen.getByLabelText('全选当前页') as HTMLInputElement).indeterminate).toBe(true);
  fireEvent.click(screen.getByLabelText('全选当前页'));
  expect((screen.getByLabelText('选择 视频1') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('选择 视频2') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('全选当前页') as HTMLInputElement).indeterminate).toBe(false);
  fireEvent.click(screen.getByLabelText('全选当前页'));
  expect((screen.getByLabelText('选择 视频1') as HTMLInputElement).checked).toBe(false);
});
