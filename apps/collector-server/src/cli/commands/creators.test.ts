// creators.ts 纯处理函数测试：注入 fake CreatorsClient，断言 query 组装（camelCase→端点参数名映射、
// 未传不进）与响应归一（list 去 ok 外壳）；get 透传。commander 装配层见 creators.cli.test.ts
//（子进程跑真 CLI + 本地 mock HTTP server，先例 tasks.cli.test.ts）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | list 全参数/最小参数 query 组装 + 响应去 ok + get 透传 | 通过 | 2026-10-05；先行失败（模块不存在）后实现转绿，pnpm qa 全绿 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creatorsList, creatorsGet, type CreatorsClient } from './creators.js';

// 记录调用的 fake client：queries 收 list 的 query，gets 收 id。
function fakeClient(resp: unknown = { ok: true }): {
  client: CreatorsClient;
  queries: Array<Record<string, string | number | boolean>>;
  gets: number[];
} {
  const queries: Array<Record<string, string | number | boolean>> = [];
  const gets: number[] = [];
  const client: CreatorsClient = {
    listCreators: async (q) => { queries.push(q); return resp; },
    getCreator: async (id) => { gets.push(id); return resp; },
  };
  return { client, queries, gets };
}

test('creators list：全参数透传进 query（筛选+七键排序+分页），响应去 ok 外壳', async () => {
  const f = fakeClient({ ok: true, total: 2, items: [{ id: 1 }, { id: 2 }] });
  const out = await creatorsList(f.client, {
    q: '科技', category: 'AI', scope: 'agent', source: 'bilibili',
    page: 2, size: 30, sort: 'fans', desc: false,
  });
  // 端点参数名与 CLI 选项同名（q/category/source/scope/page/size），undefined 之外全量透传
  assert.deepEqual(f.queries[0], {
    q: '科技', category: 'AI', scope: 'agent', source: 'bilibili',
    page: 2, size: 30, sort: 'fans', desc: false,
  });
  // ok 外壳剥掉（对齐全局 list 规范），total/items 原样
  assert.deepEqual(out, { total: 2, items: [{ id: 1 }, { id: 2 }] });
});

test('creators list：未传参数 → query 为空对象（不带多余参数，端点走默认 page=1/size=20/first_seen 降序）', async () => {
  const f = fakeClient({ ok: true, total: 0, items: [] });
  const out = await creatorsList(f.client, {});
  assert.deepEqual(f.queries[0], {}, '最小调用 query 应为空');
  assert.deepEqual(out, { total: 0, items: [] });
});

test('creators list：部分参数只透传已传项（scope 单独使用=该槽位已打标，语义由端点解释）', async () => {
  const f = fakeClient({ ok: true, total: 0, items: [] });
  await creatorsList(f.client, { scope: 'human', sort: 'video_count' });
  assert.deepEqual(f.queries[0], { scope: 'human', sort: 'video_count' });
});

test('creators get：id 透传，响应原样返回（{ok, creator} 含 P2 字段与分类 join）', async () => {
  const body = { ok: true, creator: { id: 7, source: 'bilibili', source_uid: '42', fans: 1000, sign: null } };
  const f = fakeClient(body);
  const out = await creatorsGet(f.client, 7);
  assert.deepEqual(f.gets, [7]);
  assert.deepEqual(out, body);
});
