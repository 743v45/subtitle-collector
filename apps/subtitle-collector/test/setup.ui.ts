// vitest UI 测试全局 setup（2026-10-07 popup 形态锁定测试引入）。四件事：
// 1) jest-dom matchers（toHaveClass / toHaveTextContent / toBeEmptyDOMElement 等）；
// 2) chrome.* stub——被测链路 useDanmaku（hooks-danmaku.ts）只消费 chrome.runtime.onMessage
//    add/removeListener；authInit（hooks.ts）的 Bearer token 是模块级变量、仅 useServerConfig
//    读 storage 时写入，本测试不渲染该 hook → token 恒 null，fetch 不带鉴权头（形态测试不依赖）。
//    storage / tabs 系列为防御性 stub：hooks 家族其余 hook 若被后续 UI 测试复用时报缺不炸。
//    直接赋值 globalThis.chrome 而非 vi.stubGlobal——afterEach 的 vi.unstubAllGlobals 只清
//    各用例的 fetch stub，不应连带清掉 chrome 基座。
// 3) Radix 在 jsdom 的已知缺口：Pointer Capture API / scrollIntoView / ResizeObserver
//    （Collapsible 当前不消费，预置无害，报什么补什么的兜底层）。
// 4) afterEach 显式 cleanup：globals=false 时 @testing-library/react 不注册 auto-cleanup，
//    不显式清会跨用例漏 DOM（多渲染残留导致 getByText 撞重名）。
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// —— chrome.* 基座（见头注 2）——
(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    sendMessage: vi.fn(),
    lastError: null,
  },
  storage: {
    local: { get: vi.fn((_keys: unknown, cb?: (items: Record<string, unknown>) => void) => cb?.({})), set: vi.fn() },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  tabs: {
    query: vi.fn((_q: unknown, cb?: (tabs: unknown[]) => void) => cb?.([])),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

// —— Radix / jsdom 缺口兜底（见头注 3）——
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

// —— 每用例收尾（见头注 4）：清 DOM + 还原 stubGlobal 的 fetch mock ——
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
