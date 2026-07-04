// clients 命令组纯处理函数测试。
// 用伪造的 ServerClient（实现 listClients/setReporting/sendCommand 同签名 stub，
// 返回固定 Promise + 记录调用参数）注入纯函数，断言输出 + params 构造正确。
// 不真起 server（server 端契约由 http/clients.test.ts 覆盖）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientsList,
  clientsReporting,
  clientsCommand,
  type CommandParams,
} from './clients.js';
import type { ServerClient } from '../http.js';

// 记录 stub 上各方法的调用情况，用于断言"传给了 sendCommand 什么 params"。
interface FakeCalls {
  listClients: number;
  setReporting: Array<{ clientId: string; enabled: boolean }>;
  sendCommand: Array<{
    clientId: string;
    action: string;
    params: Record<string, unknown>;
    timeout?: number;
  }>;
}

interface FakeOverrides {
  listClients?: () => Promise<unknown[]>;
  setReporting?: (clientId: string, enabled: boolean) => Promise<unknown>;
  sendCommand?: (
    clientId: string,
    action: string,
    params: Record<string, unknown>,
    timeout?: number,
  ) => Promise<unknown>;
}

/**
 * 造一个 ServerClient-like 的 stub 对象，cast 成 ServerClient 喂给纯函数。
 * 默认返回固定值；可传 overrides 替换个别方法（如抛错误）。
 */
function makeFakeClient(overrides: FakeOverrides = {}): {
  client: ServerClient;
  calls: FakeCalls;
} {
  const calls: FakeCalls = { listClients: 0, setReporting: [], sendCommand: [] };
  const stub = {
    listClients:
      overrides.listClients ??
      (async () => {
        calls.listClients++;
        return [
          { client_id: 'ext-A', ext_version: '0.1.0', reporting_enabled: true, connected: true },
          { client_id: 'ext-B', ext_version: '0.2.0', reporting_enabled: false, connected: true },
        ];
      }),
    setReporting:
      overrides.setReporting ??
      (async (clientId: string, enabled: boolean) => {
        calls.setReporting.push({ clientId, enabled });
        return { ok: true, client_id: clientId, reporting_enabled: enabled };
      }),
    sendCommand:
      overrides.sendCommand ??
      (async (
        clientId: string,
        action: string,
        params: Record<string, unknown>,
        timeout?: number,
      ) => {
        calls.sendCommand.push({ clientId, action, params, timeout });
        return {
          ok: true,
          client_id: clientId,
          action,
          result: { ok: true, data: { opened: true } },
        };
      }),
  };
  return { client: stub as unknown as ServerClient, calls };
}

// ── clientsList ──

test('clientsList: 包裹成 {items, total}，调一次 listClients', async () => {
  const { client, calls } = makeFakeClient();
  const out = await clientsList(client);
  assert.equal(calls.listClients, 1, 'listClients 应被调一次');
  assert.equal(out.total, 2, 'total = items 长度');
  assert.ok(Array.isArray(out.items), 'items 应为数组');
  assert.equal(
    (out.items[0] as { client_id: string }).client_id,
    'ext-A',
    'items[0] 透传 server 返回',
  );
});

test('clientsList: server 返回空数组 → {items: [], total: 0}', async () => {
  const { client } = makeFakeClient({ listClients: async () => [] });
  const out = await clientsList(client);
  assert.deepEqual(out, { items: [], total: 0 });
});

// ── clientsReporting ──

test('clientsReporting: 透传 clientId/enabled，返回 server 体', async () => {
  const { client, calls } = makeFakeClient();
  const out = await clientsReporting(client, 'ext-A', false);
  assert.deepEqual(calls.setReporting, [{ clientId: 'ext-A', enabled: false }]);
  assert.deepEqual(out, { ok: true, client_id: 'ext-A', reporting_enabled: false });
});

test('clientsReporting: enabled=true 也能正确透传', async () => {
  const { client, calls } = makeFakeClient();
  await clientsReporting(client, 'ext-B', true);
  assert.deepEqual(calls.setReporting, [{ clientId: 'ext-B', enabled: true }]);
});

// ── clientsCommand（核心：params 过滤） ──

test('clientsCommand: 只把用户传入字段下发给 sendCommand（undefined 不传）', async () => {
  const { client, calls } = makeFakeClient();
  // op 未传（undefined），url/vid 传入
  const params: CommandParams = { op: undefined, url: 'https://b23.tv/x', vid: 'BV1xx' };
  await clientsCommand(client, 'ext-A', 'navigate', params, 5000);

  assert.equal(calls.sendCommand.length, 1);
  const call = calls.sendCommand[0]!;
  assert.equal(call.clientId, 'ext-A');
  assert.equal(call.action, 'navigate');
  assert.equal(call.timeout, 5000);
  // 关键断言：params 只含 url/vid，不含 undefined 的 op 键
  assert.deepEqual(call.params, { url: 'https://b23.tv/x', vid: 'BV1xx' });
  assert.ok(!('op' in call.params), 'undefined 的 op 不应出现在 params 键里');
});

test('clientsCommand: 全部字段传入 → 全部下发（含 timeout 透传）', async () => {
  const { client, calls } = makeFakeClient();
  await clientsCommand(client, 'ext-A', 'operate', { op: 'play', url: 'u', vid: 'v' }, 3000);
  assert.deepEqual(calls.sendCommand[0]!.params, { op: 'play', url: 'u', vid: 'v' });
  assert.equal(calls.sendCommand[0]!.timeout, 3000);
});

test('clientsCommand: 全部 undefined / 空对象 → params 为空对象（仍下发 action）', async () => {
  const { client, calls } = makeFakeClient();
  await clientsCommand(client, 'ext-A', 'fetch-subtitle', {}, 8000);
  assert.deepEqual(calls.sendCommand[0]!.params, {});
  assert.equal(calls.sendCommand[0]!.action, 'fetch-subtitle');
  assert.equal(calls.sendCommand[0]!.timeout, 8000);
});

test('clientsCommand: 仅传 op → params 只含 op', async () => {
  const { client, calls } = makeFakeClient();
  await clientsCommand(client, 'ext-A', 'operate', { op: 'pause' }, 5000);
  assert.deepEqual(calls.sendCommand[0]!.params, { op: 'pause' });
});

test('clientsCommand: 返回 server 透传体（含 result 回执）', async () => {
  const { client } = makeFakeClient();
  const out = await clientsCommand(client, 'ext-A', 'navigate', { url: 'u' }, 5000);
  assert.deepEqual(out, {
    ok: true,
    client_id: 'ext-A',
    action: 'navigate',
    result: { ok: true, data: { opened: true } },
  });
});

// ── 错误透传（纯函数层不吞异常，交给 commander 层 handleHttpError） ──

test('纯函数不吞 server 抛出的错误（透传给调用方处理）', async () => {
  const boom = new Error('boom');
  const { client } = makeFakeClient({
    listClients: async () => {
      throw boom;
    },
    setReporting: async () => {
      throw boom;
    },
    sendCommand: async () => {
      throw boom;
    },
  });
  await assert.rejects(() => clientsList(client), boom);
  await assert.rejects(() => clientsReporting(client, 'x', true), boom);
  await assert.rejects(() => clientsCommand(client, 'x', 'a', {}, 1), boom);
});

test('ServerResponseError / ServerUnreachableError 透传（保持 instanceof）', async () => {
  const unreachable = new (class TestUnreachable extends Error {})();
  unreachable.name = 'ServerUnreachableError';
  const { client } = makeFakeClient({
    listClients: async () => {
      throw unreachable;
    },
  });
  // 纯函数只负责透传；类型识别在 commander 装配层的 handleHttpError 做（不在测试范围）。
  await assert.rejects(() => clientsList(client), unreachable);
});
