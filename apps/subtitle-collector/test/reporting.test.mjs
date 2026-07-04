import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReport, genClientId, CLIENT_ID_KEY, REPORTING_KEY } from '../reporting.mjs';

test('shouldReport：true/未设→上报，false→不上报（fail-open）', () => {
  assert.equal(shouldReport(true), true);
  assert.equal(shouldReport(false), false);
  assert.equal(shouldReport(undefined), true); // 未设置默认开
});

test('genClientId：非空字符串，多次不撞', () => {
  const a = genClientId(); const b = genClientId();
  assert.ok(typeof a === 'string' && a.length > 0);
  assert.notEqual(a, b);
});

test('storage key 常量稳定（对齐协议）', () => {
  assert.equal(CLIENT_ID_KEY, 'clientId');
  assert.equal(REPORTING_KEY, 'reportingEnabled');
});
