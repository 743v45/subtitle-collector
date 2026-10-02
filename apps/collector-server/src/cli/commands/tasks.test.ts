// tasks.ts 纯处理函数测试：注入 fake TasksClient，断言 query 组装（camelCase→snake_case 映射、
// 未传不进）与响应归一（去 ok 外壳）；get/retry 透传。commander 装配层见 tasks.cli.test.ts
//（子进程跑真 CLI + 本地 mock HTTP server）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | list 全参数/最小参数 query 组装 + 响应去 ok + get/retry 透传 | 通过 | 2026-10-02；pnpm qa 全绿 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tasksList, tasksGet, tasksRetry, type TasksClient } from './tasks.js';

// 记录调用的 fake client：queries 收 list 的 query，gets/retries 收 id / ids。
function fakeClient(resp: unknown = { ok: true }): {
  client: TasksClient;
  queries: Array<Record<string, string | number | boolean>>;
  gets: number[];
  retries: number[][];
} {
  const queries: Array<Record<string, string | number | boolean>> = [];
  const gets: number[] = [];
  const retries: number[][] = [];
  const client: TasksClient = {
    listCollectTasks: async (q) => { queries.push(q); return resp; },
    getCollectTask: async (id) => { gets.push(id); return resp; },
    retryCollectTasks: async (ids) => { retries.push(ids); return resp; },
  };
  return { client, queries, gets, retries };
}

test('tasks list：全参数透传进 query（camelCase→snake_case），响应去 ok 外壳', async () => {
  const f = fakeClient({ ok: true, total: 1, items: [{ id: 1 }] });
  const out = await tasksList(f.client, {
    status: 'failed,limited', source: 'bilibili', batchId: 'b1', batch: 'batch',
    creator: '某UP', creatorUid: '42', q: 'BV1', since: 100, until: 200,
    limit: 5, page: 2, pageSize: 10, sort: 'finished_at', desc: false,
  });
  // 端点参数名是 snake_case（batch_id/creator_uid/page_size），undefined 之外全量透传
  assert.deepEqual(f.queries[0], {
    status: 'failed,limited', source: 'bilibili',
    batch_id: 'b1', batch: 'batch',
    creator: '某UP', creator_uid: '42', q: 'BV1',
    since: 100, until: 200,
    limit: 5, page: 2, page_size: 10,
    sort: 'finished_at', desc: false,
  });
  // ok 外壳剥掉（对齐全局 list 规范），total/items 原样
  assert.deepEqual(out, { total: 1, items: [{ id: 1 }] });
});

test('tasks list：未传参数 → query 为空对象（不带多余参数），分页响应的 page/page_size 保留', async () => {
  const f = fakeClient({ ok: true, page: 1, page_size: 30, total: 0, items: [] });
  const out = await tasksList(f.client, {});
  assert.deepEqual(f.queries[0], {}, '最小调用 query 应为空');
  // 分页形态响应里的 page/page_size 原样透出（只剥 ok）
  assert.deepEqual(out, { page: 1, page_size: 30, total: 0, items: [] });
});

test('tasks get：id 透传，响应原样返回（{ok, task} 含失败原因 error / 回执摘要 result）', async () => {
  const body = { ok: true, task: { id: 7, status: 'failed', error: 'no_subtitle', result: null } };
  const f = fakeClient(body);
  const out = await tasksGet(f.client, 7);
  assert.deepEqual(f.gets, [7]);
  assert.deepEqual(out, body);
});

test('tasks retry：ids 数组透传（多 id 批量），响应原样返回', async () => {
  const body = { ok: true, retried: 2, tasks: [{ id: 7 }, { id: 8 }] };
  const f = fakeClient(body);
  const out = await tasksRetry(f.client, [7, 8]);
  assert.deepEqual(f.retries, [[7, 8]]);
  assert.deepEqual(out, body);
});
