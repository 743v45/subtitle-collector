// CLI→server HTTP 客户端（ServerClient）单测：mock globalThis.fetch，断言 URL 构造 / Authorization / body 形状 / 错误归一化。
// 不真起 server（server 端契约由 src/http/*.test.ts 覆盖；扩展↔server 连通性联调归 scripts/verify-collector.mjs）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | ping/listClients + URL/headers/body 形状 + 错误归一化（不可达/非2xx/空体/非JSON） | 通过 | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerClient, ServerUnreachableError, ServerResponseError } from './http.js';

interface Recorded {
  url: string;
  init: RequestInit;
}

// 装 mock fetch：记录 (url, init) 并按 responder 返回真 Response；返回卸载函数（finally 恢复真 fetch）。
function mockFetch(responder: (rec: Recorded) => Response): { recs: Recorded[]; restore: () => void } {
  const recs: Recorded[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    const rec: Recorded = { url: String(_input), init: _init ?? {} };
    recs.push(rec);
    return Promise.resolve(responder(rec));
  }) as typeof fetch;
  return { recs, restore: () => { globalThis.fetch = orig; } };
}

const client = () => new ServerClient('http://srv.test:8080', 'tok-1');

// ── ping ──

test('ping：2xx → true；非 2xx / 连不上 → false（不抛）', async () => {
  const ok = mockFetch(() => new Response('{"ok":true}', { status: 200 }));
  try {
    assert.equal(await client().ping(), true);
    assert.equal(ok.recs.length, 1);
  } finally { ok.restore(); }

  const bad = mockFetch(() => new Response('x', { status: 503 }));
  try { assert.equal(await client().ping(), false); } finally { bad.restore(); }

  const dead = mockFetch(() => { throw new TypeError('fetch failed'); });
  try { assert.equal(await client().ping(), false); } finally { dead.restore(); }
});

// ── 构造与请求形状 ──

test('构造：baseUrl 尾斜杠剥离 + Authorization Bearer + JSON Content-Type', async () => {
  const m = mockFetch(() => new Response('{"clients":[]}', { status: 200 }));
  try {
    const c = new ServerClient('http://srv.test:8080///', 'tok-1');
    await c.listClients();
    assert.equal(m.recs[0]!.url, 'http://srv.test:8080/api/clients');
    const headers = m.recs[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer tok-1');
    assert.equal(headers['Content-Type'], 'application/json');
    // GET 无 body
    assert.equal(m.recs[0]!.init.body, undefined);
  } finally { m.restore(); }
});

test('listClients：取 .clients 数组；缺失/非数组 → []', async () => {
  const m = mockFetch(() => new Response('{"clients":[{"client_id":"ext-A"}]}', { status: 200 }));
  try {
    assert.deepEqual(await client().listClients(), [{ client_id: 'ext-A' }]);
  } finally { m.restore(); }

  const missing = mockFetch(() => new Response('{}', { status: 200 }));
  try { assert.deepEqual(await client().listClients(), []); } finally { missing.restore(); }

  const notArr = mockFetch(() => new Response('{"clients":"x"}', { status: 200 }));
  try { assert.deepEqual(await client().listClients(), []); } finally { notArr.restore(); }
});

// ── 错误归一化 ──

test('非 2xx → ServerResponseError（status/body 透传，message 带 path）', async () => {
  const m = mockFetch(() => new Response('{"ok":false,"error":"nope"}', { status: 404 }));
  try {
    await assert.rejects(() => client().setReporting('ext-A', true), (err: unknown) => {
      assert.ok(err instanceof ServerResponseError);
      assert.equal(err.status, 404);
      assert.equal(err.body, '{"ok":false,"error":"nope"}');
      assert.ok(err.message.includes('/api/clients/ext-A/reporting'));
      return true;
    });
  } finally { m.restore(); }
});

test('连不上 → ServerUnreachableError（message 带 baseUrl 便于提示 COLLECTOR_SERVER）', async () => {
  const m = mockFetch(() => { throw new TypeError('fetch failed'); });
  try {
    await assert.rejects(() => client().listClients(), (err: unknown) => {
      assert.ok(err instanceof ServerUnreachableError);
      assert.ok(err.message.includes('http://srv.test:8080'));
      return true;
    });
  } finally { m.restore(); }
});

test('2xx 空 body → null；非 JSON 成功体 → 原样字符串返回', async () => {
  const empty = mockFetch(() => new Response(null, { status: 204 })); // 204 不允许带 body，须 null
  try { assert.equal(await client().setReporting('x', false), null); } finally { empty.restore(); }

  const text = mockFetch(() => new Response('plain-ok', { status: 200 }));
  try { assert.equal(await client().setReporting('x', false), 'plain-ok'); } finally { text.restore(); }
});

// ── 各端点 body 形状 ──

test('sendCommand：action+params 展开、clientId URL 编码、timeout 有无两态', async () => {
  const m = mockFetch(() => new Response('{"ok":true}', { status: 200 }));
  try {
    const c = new ServerClient('http://srv.test:8080', 't');
    await c.sendCommand('ext A/x', 'navigate', { url: 'https://b23.tv/x', vid: 'BV1' }, 5000);
    await c.sendCommand('ext-B', 'fetch-subtitle', {});
    assert.equal(m.recs[0]!.url, 'http://srv.test:8080/api/clients/ext%20A%2Fx/command');
    assert.deepEqual(JSON.parse(String(m.recs[0]!.init.body)), {
      action: 'navigate', url: 'https://b23.tv/x', vid: 'BV1', timeout: 5000,
    });
    const b2 = JSON.parse(String(m.recs[1]!.init.body)) as Record<string, unknown>;
    assert.deepEqual(b2, { action: 'fetch-subtitle' });
    assert.ok(!('timeout' in b2), '未传 timeout 时 body 不含 timeout 键');
  } finally { m.restore(); }
});

test('applyTags / removeTags：items source=平台（默认 bilibili）、body scope=档位；remove 省略 scope = 删全档（无 scope 键）', async () => {
  const m = mockFetch(() => new Response('{"ok":true}', { status: 200 }));
  try {
    const c = client();
    await c.applyTags(['BV1', 'BV2'], ['ai', '面试题'], 'batch');
    await c.removeTags(['BV1'], ['ai']);
    await c.removeTags(['BV1'], ['ai'], 'manual');
    await c.applyTags(['ytvid00001'], ['ai'], 'ai', 'youtube');
    assert.deepEqual(JSON.parse(String(m.recs[0]!.init.body)), {
      items: [{ source: 'bilibili', source_vid: 'BV1' }, { source: 'bilibili', source_vid: 'BV2' }],
      names: ['ai', '面试题'],
      scope: 'batch',
    });
    const rm = JSON.parse(String(m.recs[1]!.init.body)) as Record<string, unknown>;
    assert.deepEqual(rm, { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['ai'] });
    assert.ok(!('scope' in rm), 'remove 省略 scope 时 body 不含 scope 键');
    assert.deepEqual(JSON.parse(String(m.recs[2]!.init.body)), {
      items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['ai'], scope: 'manual',
    });
    // platform=youtube：items source 跟随，不再硬编码 bilibili
    assert.deepEqual(JSON.parse(String(m.recs[3]!.init.body)), {
      items: [{ source: 'youtube', source_vid: 'ytvid00001' }], names: ['ai'], scope: 'ai',
    });
  } finally { m.restore(); }
});

test('createCollectTasksBatch：body 原样透传（含 creator_uid）', async () => {
  const m = mockFetch(() => new Response('{"ok":true}', { status: 200 }));
  try {
    await client().createCollectTasksBatch({ vids: ['BV1'], source: 'bilibili', creator_uid: '42' });
    assert.equal(m.recs[0]!.url, 'http://srv.test:8080/api/collect-tasks/batch');
    assert.deepEqual(JSON.parse(String(m.recs[0]!.init.body)), { vids: ['BV1'], source: 'bilibili', creator_uid: '42' });
  } finally { m.restore(); }
});
