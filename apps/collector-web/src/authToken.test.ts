// authToken / apiFetch 注入单测：访问 token 存取 + api 层统一注入 Authorization 的行为锁定。
// 背景（2026-10-07 生产 401）：暴露部署下老 WebView 不发 Sec-Fetch-Site，同源豁免不生效——
// 前端带 token 是唯一对一切客户端形态免疫的通道。本组测试防该行为回退（fetch 裸调用绕过注入）。
// 跑法：npx vitest run src/authToken.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | getToken/setToken 存取 + apiFetch 注入/无 token 不加头/覆盖不重复 7 例 | 通过 | 2026-10-07 账本 U-1 |
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { getToken, setToken, notifyAuthRequired, AUTH_REQUIRED_EVENT } from './authToken';
import { apiFetch } from './apiCore';

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ── localStorage 存取 ──

test('setToken/getToken：写入与读取回环；空串 = 移除键；纯空白同样移除', () => {
  expect(getToken()).toBe('');
  setToken('  tok-123  ');
  expect(getToken()).toBe('tok-123'); // trim 落库
  expect(window.localStorage.getItem('collector-token')).toBe('tok-123');
  setToken('');
  expect(window.localStorage.getItem('collector-token')).toBe(null);
  expect(getToken()).toBe('');
});

// ── apiFetch 注入 ──

test('apiFetch：有 token → 同源 /api/ 请求带 Authorization: Bearer；init.headers 原有头保留', async () => {
  setToken('tok-abc');
  const calls: Array<{ input: any; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  await apiFetch('/api/videos', { headers: { 'Content-Type': 'application/json' } });
  const h = new Headers(calls[0].init?.headers);
  expect(h.get('Authorization')).toBe('Bearer tok-abc');
  expect(h.get('Content-Type')).toBe('application/json'); // 原头不被吃掉
  expect(calls[0].input).toBe('/api/videos'); // URL 原样
});

test('apiFetch：无 token → 不加 Authorization 头（行为与注入前一致，loopback/同源豁免形态）', async () => {
  const calls: Array<{ init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_: any, init?: RequestInit) => {
    calls.push({ init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  await apiFetch('/api/videos');
  expect(calls[0].init?.headers).toBeUndefined(); // 未构造空 Headers，完全透传
});

// ── 401 全局信号 ──

test('notifyAuthRequired：派发 AUTH_REQUIRED_EVENT，App 横幅监听该事件名', () => {
  const seen: string[] = [];
  window.addEventListener(AUTH_REQUIRED_EVENT, (e) => seen.push((e as CustomEvent).type));
  notifyAuthRequired();
  expect(seen).toEqual(['collector-auth-required']);
});
