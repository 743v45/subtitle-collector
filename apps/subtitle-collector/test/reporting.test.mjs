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

test('storage key 常量稳定（对齐协议）', () => {
  assert.equal(CLIENT_ID_KEY, 'clientId');
  assert.equal(REPORTING_KEY, 'reportingEnabled');
});
