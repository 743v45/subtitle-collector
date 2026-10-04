// settings.ts 纯处理函数测试：注入 fake SettingsClient，断言 get 分派（key → 对应端点方法）、
// set 透传、--order CSV 解析校验（六档精确排列）。commander 装配层见 settings.cli.test.ts
//（子进程跑真 CLI + 本地 mock HTTP server，先例 creators.cli.test.ts）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | get 分派 + set 透传 + --order 解析四态 | 通过 | 2026-10-05；先行失败（模块不存在）后实现转绿，pnpm qa 全绿 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  settingsGet,
  settingsSetTagPriority,
  settingsSetCollectTimeout,
  parseTagPriorityOrder,
  type SettingsClient,
} from './settings.js';

// 记录调用的 fake client：四个方法各记一桶。
function fakeClient(resp: unknown = { ok: true }): {
  client: SettingsClient;
  getPriorities: void[];
  setPriorities: string[][];
  getTimeouts: void[];
  setTimeouts: Array<{ bilibili: number; youtube: number; douyin: number }>;
} {
  const getPriorities: void[] = [];
  const setPriorities: string[][] = [];
  const getTimeouts: void[] = [];
  const setTimeouts: Array<{ bilibili: number; youtube: number; douyin: number }> = [];
  const client: SettingsClient = {
    getTagPriority: async () => { getPriorities.push(undefined); return resp; },
    setTagPriority: async (p) => { setPriorities.push(p); return resp; },
    getCollectTimeout: async () => { getTimeouts.push(undefined); return resp; },
    setCollectTimeout: async (t) => { setTimeouts.push(t); return resp; },
  };
  return { client, getPriorities, setPriorities, getTimeouts, setTimeouts };
}

test('settings get tag-priority：分派到 GET /api/settings/tag-priority（响应透传 {ok,priority}）', async () => {
  const f = fakeClient({ ok: true, priority: ['manual', 'batch', 'bili', 'season', 'ai', 'system'] });
  const out = await settingsGet(f.client, 'tag-priority');
  assert.equal(f.getPriorities.length, 1);
  assert.equal(f.getTimeouts.length, 0);
  assert.deepEqual(out, { ok: true, priority: ['manual', 'batch', 'bili', 'season', 'ai', 'system'] });
});

test('settings get collect-timeout：分派到 GET /api/settings/collect-timeout（响应透传 {ok,...三键}）', async () => {
  const f = fakeClient({ ok: true, bilibili: 90000, youtube: 45000, douyin: 45000 });
  const out = await settingsGet(f.client, 'collect-timeout');
  assert.equal(f.getTimeouts.length, 1);
  assert.equal(f.getPriorities.length, 0);
  assert.deepEqual(out, { ok: true, bilibili: 90000, youtube: 45000, douyin: 45000 });
});

test('parseTagPriorityOrder：缺省顺序与乱序排列均合法（返回档位数组）', () => {
  assert.deepEqual(parseTagPriorityOrder('manual,batch,bili,season,ai,system'), ['manual', 'batch', 'bili', 'season', 'ai', 'system']);
  assert.deepEqual(parseTagPriorityOrder('ai,manual,system,batch,season,bili'), ['ai', 'manual', 'system', 'batch', 'season', 'bili']);
});

test('parseTagPriorityOrder：项间空白可容忍（trim）', () => {
  assert.deepEqual(parseTagPriorityOrder(' manual , batch , bili , season , ai , system '), ['manual', 'batch', 'bili', 'season', 'ai', 'system']);
});

test('parseTagPriorityOrder：缺档 / 未知档 / 重复档 / 空串 → null（六档精确排列约束）', () => {
  assert.equal(parseTagPriorityOrder('manual,batch,bili,season,ai'), null, '缺 system');
  assert.equal(parseTagPriorityOrder('manual,batch,bili,season,ai,bogus'), null, 'bogus 替掉 system');
  assert.equal(parseTagPriorityOrder('manual,manual,batch,bili,season,ai'), null, '重复 manual 缺 system');
  assert.equal(parseTagPriorityOrder(''), null, '空串');
});

test('settings set tag-priority：priority 数组透传给 setTagPriority', async () => {
  const f = fakeClient({ ok: true, priority: ['ai', 'manual', 'batch', 'bili', 'season', 'system'] });
  const out = await settingsSetTagPriority(f.client, ['ai', 'manual', 'batch', 'bili', 'season', 'system']);
  assert.deepEqual(f.setPriorities, [['ai', 'manual', 'batch', 'bili', 'season', 'system']]);
  assert.deepEqual(out, { ok: true, priority: ['ai', 'manual', 'batch', 'bili', 'season', 'system'] });
});

test('settings set collect-timeout：三键对象透传给 setCollectTimeout', async () => {
  const f = fakeClient({ ok: true, bilibili: 120000, youtube: 60000, douyin: 60000 });
  const out = await settingsSetCollectTimeout(f.client, { bilibili: 120000, youtube: 60000, douyin: 60000 });
  assert.deepEqual(f.setTimeouts, [{ bilibili: 120000, youtube: 60000, douyin: 60000 }]);
  assert.deepEqual(out, { ok: true, bilibili: 120000, youtube: 60000, douyin: 60000 });
});
