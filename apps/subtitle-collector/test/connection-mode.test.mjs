import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_MODE_KEY,
  MODE_SERVER,
  MODE_STANDALONE,
  resolveConnectionMode,
  isStandalone,
  resolveConnDisplay,
} from '../connection-mode.mjs';

test('resolveConnectionMode：standalone→standalone，其余→server（fail-回 server）', () => {
  assert.equal(resolveConnectionMode(MODE_STANDALONE), MODE_STANDALONE);
  assert.equal(resolveConnectionMode(MODE_SERVER), MODE_SERVER);
  assert.equal(resolveConnectionMode(undefined), MODE_SERVER); // 未设置默认连 server
  assert.equal(resolveConnectionMode(null), MODE_SERVER);
  assert.equal(resolveConnectionMode(''), MODE_SERVER);
  assert.equal(resolveConnectionMode('other'), MODE_SERVER); // 误写回落
  assert.equal(resolveConnectionMode(123), MODE_SERVER); // 非字符串回落
});

test('isStandalone：仅 standalone 为真（归一后判定，容忍脏读）', () => {
  assert.equal(isStandalone(MODE_STANDALONE), true);
  assert.equal(isStandalone(MODE_SERVER), false);
  assert.equal(isStandalone(undefined), false);
  assert.equal(isStandalone('garbage'), false);
});

test('storage key / 模式常量稳定（对齐协议）', () => {
  assert.equal(CONNECTION_MODE_KEY, 'connectionMode');
  assert.equal(MODE_SERVER, 'server');
  assert.equal(MODE_STANDALONE, 'standalone');
  assert.notEqual(MODE_SERVER, MODE_STANDALONE);
});

test('resolveConnDisplay：loading 优先，屏蔽 mode/connected（防首帧翻转闪烁）', () => {
  // loading=true 时无论 mode/connected 真假，一律返回 loading 占位 —— UI 不暴露结论态
  assert.deepEqual(resolveConnDisplay({ loading: true, mode: MODE_SERVER, connected: true }), { phase: 'loading' });
  assert.deepEqual(resolveConnDisplay({ loading: true, mode: MODE_STANDALONE, connected: false }), { phase: 'loading' });
  assert.deepEqual(resolveConnDisplay({ loading: true, mode: undefined, connected: false }), { phase: 'loading' });
});

test('resolveConnDisplay：非 loading 按 mode/connected 决策', () => {
  assert.deepEqual(resolveConnDisplay({ loading: false, mode: MODE_STANDALONE, connected: false }), { phase: 'standalone' });
  assert.deepEqual(resolveConnDisplay({ loading: false, mode: MODE_SERVER, connected: true }), { phase: 'server', connected: true });
  assert.deepEqual(resolveConnDisplay({ loading: false, mode: MODE_SERVER, connected: false }), { phase: 'server', connected: false });
  // mode 脏读（undefined）归一为 server
  assert.deepEqual(resolveConnDisplay({ loading: false, mode: undefined, connected: true }), { phase: 'server', connected: true });
});
