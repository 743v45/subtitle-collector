// collect-yt-search.ts 纯函数层测试：YouTube 关键词搜索的 action 下发与 --since-days 过滤。
// CLI commander 装配层的子进程集成测试见 collect-yt-search.cli.test.ts；扩展侧解析/编排见
// apps/subtitle-collector/test/yt-search.test.mjs（本文件只测 server CLI 的胶水）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | collectYtSearch / filterYtBySince | 通过 | mock client 注入，无网络 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectYtSearch, filterYtBySince, type YtSearchItem } from './collect-yt-search.js';
import type { CollectClient } from './collect.js';

/** mock client：记录 sendCommand 调用，按预设返回。 */
function mockClient(resp: unknown): { client: CollectClient; calls: Array<{ id: string; action: string; params: Record<string, unknown> }> } {
  const calls: Array<{ id: string; action: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      listClients: async () => [{ client_id: 'c1' }],
      sendCommand: async (id, action, params) => {
        calls.push({ id, action, params });
        return resp;
      },
    },
  };
}

// —— collectYtSearch：yt-search action 下发 ——
test('collectYtSearch：透传 keyword/order/pages（默认 relevance/1）', async () => {
  const resp = { ok: true, result: { items: [] } };
  const { client, calls } = mockClient(resp);
  const out = await collectYtSearch(client, 'c1', 'ts tutorial', {}, 180000);
  assert.deepEqual(calls[0], { id: 'c1', action: 'yt-search', params: { keyword: 'ts tutorial', order: 'relevance', pages: 1 } });
  assert.equal(out, resp); // 成功响应体原样透传（CLI 不挖内层）
});

test('collectYtSearch：显式 order/pages 透传', async () => {
  const { client, calls } = mockClient({ ok: true, result: { items: [] } });
  await collectYtSearch(client, 'c1', 'kw', { order: 'newest', pages: 3 }, 60000);
  assert.deepEqual(calls[0].params, { keyword: 'kw', order: 'newest', pages: 3 });
});

// —— filterYtBySince：--since-days 过滤 ——
test('filterYtBySince：null created 保留（相对时间解析失败防漏采，对齐 yt-videos）', () => {
  const items: YtSearchItem[] = [
    { vid: 'AAAAAAAAAAA', created: 1000 },
    { vid: 'BBBBBBBBBBB', created: null },
  ];
  // 下限 5000：created=1000 被滤；null 保留
  assert.deepEqual(filterYtBySince(items, 5000).map((i) => i.vid), ['BBBBBBBBBBB']);
});

test('filterYtBySince：sinceUnix 为 null 不过滤（未传 --since-days）', () => {
  const items: YtSearchItem[] = [{ vid: 'AAAAAAAAAAA', created: 1 }, { vid: 'BBBBBBBBBBB', created: null }];
  assert.equal(filterYtBySince(items, null).length, 2);
  // 边界：恰好等于下限保留（>=）
  assert.equal(filterYtBySince([{ vid: 'x', created: 5000 }], 5000).length, 1);
});
