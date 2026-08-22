// useAsync 通用异步 hook 单测：三态（loading/error/data）、reload、setData、deps 重跑、防竞态（过期响应丢弃）。
// 跑法：npx vitest run src/lib/useAsync.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 三态 + error 两条路径（Error / 非 Error reject） | 通过 | renderHook + waitFor |
// | R2 | reload / setData / deps 变化重跑 | 通过 | act 包裹触发 |
// | R3 | 防竞态：deps 变化后过期响应被丢弃 | 通过 | 手动 resolve 双 deferred |
import { test, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAsync } from './useAsync';

test('loading → data：初始 loading=true，resolve 后 data 就位、error=null', async () => {
  const h = renderHook(() => useAsync(() => Promise.resolve(42), []));
  expect(h.result.current.loading).toBe(true);
  expect(h.result.current.data).toBe(null);
  expect(h.result.current.error).toBe(null);
  await waitFor(() => expect(h.result.current.loading).toBe(false));
  expect(h.result.current.data).toBe(42);
});

test('error：reject Error → error=message；reject 非 Error → String(e)', async () => {
  const h1 = renderHook(() => useAsync(() => Promise.reject(new Error('boom')), []));
  await waitFor(() => expect(h1.result.current.loading).toBe(false));
  expect(h1.result.current.error).toBe('boom');
  expect(h1.result.current.data).toBe(null);

  const h2 = renderHook(() => useAsync(() => Promise.reject('plain string'), []));
  await waitFor(() => expect(h2.result.current.loading).toBe(false));
  expect(h2.result.current.error).toBe('plain string');
});

test('reload()：强制重取（同 deps 重新执行 fn）', async () => {
  let n = 0;
  const fn = vi.fn(() => Promise.resolve(++n));
  const h = renderHook(() => useAsync(fn, []));
  await waitFor(() => expect(h.result.current.data).toBe(1));
  act(() => h.result.current.reload());
  // reload 触发新一轮 effect：fn 重跑
  await waitFor(() => expect(h.result.current.data).toBe(2));
  expect(fn).toHaveBeenCalledTimes(2);
});

test('setData()：调用方本地更新 data（乐观更新入口）', async () => {
  const h = renderHook(() => useAsync(() => Promise.resolve('initial'), []));
  await waitFor(() => expect(h.result.current.data).toBe('initial'));
  act(() => h.result.current.setData('optimistic'));
  expect(h.result.current.data).toBe('optimistic');
});

test('deps 变化 → fn 重跑取新值', async () => {
  const fn = vi.fn((d: number) => Promise.resolve(`v${d}`));
  const h = renderHook(({ dep }) => useAsync(() => fn(dep), [dep]), { initialProps: { dep: 1 } });
  await waitFor(() => expect(h.result.current.data).toBe('v1'));
  h.rerender({ dep: 2 });
  await waitFor(() => expect(h.result.current.data).toBe('v2'));
  expect(fn).toHaveBeenCalledTimes(2);
});

test('防竞态：deps 变化后，前一轮（慢）响应被 seq 标记丢弃，不覆盖新数据', async () => {
  let resolveA!: (v: string) => void;
  let resolveB!: (v: string) => void;
  const fn = vi
    .fn()
    .mockImplementationOnce(() => new Promise<string>((r) => { resolveA = r; }))
    .mockImplementationOnce(() => new Promise<string>((r) => { resolveB = r; }));
  const h = renderHook(({ dep }) => useAsync(fn, [dep]), { initialProps: { dep: 1 } });

  // deps 变化 → seq 递增，第一轮成为过期请求
  h.rerender({ dep: 2 });
  await act(async () => { resolveB('fresh'); });
  expect(h.result.current.data).toBe('fresh');

  // 过期响应后到：seq 不匹配 → 丢弃
  await act(async () => { resolveA('stale'); });
  expect(h.result.current.data).toBe('fresh');
  expect(h.result.current.loading).toBe(false);
});
