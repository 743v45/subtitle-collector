import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_MODE_KEY,
  MODE_SERVER,
  MODE_STANDALONE,
  resolveConnectionMode,
  isStandalone,
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
