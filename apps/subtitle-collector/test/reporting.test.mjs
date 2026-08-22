import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReport, genClientId, CLIENT_ID_KEY, REPORTING_KEY } from '../reporting.mjs';

test('shouldReport：true/未设→上报，false→不上报（fail-open）', () => {
  assert.equal(shouldReport(true), true);
  assert.equal(shouldReport(false), false);
  assert.equal(shouldReport(undefined), true); // 未设置默认开
});

test('genClientId：8 位、去歧义字符集、多次不撞', () => {
  const a = genClientId(); const b = genClientId();
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  assert.equal(a.length, 8, '长度=8');
  assert.equal(b.length, 8, '长度=8');
  for (const ch of a + b) assert.ok(alphabet.includes(ch), `非法字符 ${ch}`);
  assert.notEqual(a, b, '两次生成不应相同');
});

test('genClientId 兜底路径：crypto 缺失时走 Math.random（确定性桩验证取值逻辑）', () => {
  // 覆盖 reporting.mjs L30-33 的 Math.random 分支：node 环境恒有 crypto.getRandomValues，
  // 需临时把 globalThis.crypto 置 undefined 才能进入兜底；Math.random 桩为恒 0 →
  // 每一位都取字母表第 0 位 'a'，可确定性地断言取值逻辑（n % 31 的拾取路径）。
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const origRandom = Math.random;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  Math.random = () => 0;
  try {
    assert.equal(genClientId(), 'aaaaaaaa', 'Math.random()=0 → 全取字母表首位');
  } finally {
    Math.random = origRandom;
    Object.defineProperty(globalThis, 'crypto', desc); // 原样还原 getter descriptor
  }
  // 还原后 getRandomValues 主路径恢复可用
  assert.match(genClientId(), /^[abcdefghijkmnpqrstuvwxyz23456789]{8}$/);
});

test('storage key 常量稳定（对齐协议）', () => {
  assert.equal(CLIENT_ID_KEY, 'clientId');
  assert.equal(REPORTING_KEY, 'reportingEnabled');
});
