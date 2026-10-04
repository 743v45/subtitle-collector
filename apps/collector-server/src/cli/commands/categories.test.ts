// categories.ts 纯处理函数测试：注入 fake CategoriesClient，断言 list 响应归一（去 ok 外壳 + 补
// total，对齐全局 list 输出规范）与 add/update/delete 参数透传。commander 装配层见
// categories.cli.test.ts（子进程跑真 CLI + 本地 mock HTTP server，先例 creators.cli.test.ts）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | list 归一 + add/update/delete 透传 | 通过 | 2026-10-05；先行失败（模块不存在）后实现转绿，pnpm qa 全绿 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoriesList,
  categoriesAdd,
  categoriesUpdate,
  categoriesDelete,
  type CategoriesClient,
} from './categories.js';

// 记录调用的 fake client：lists/adds/updates/deletes 分别收各方法的入参。
function fakeClient(resp: unknown = { ok: true }): {
  client: CategoriesClient;
  lists: void[];
  adds: string[];
  updates: Array<{ id: number; patch: { name?: string; sort_order?: number } }>;
  deletes: number[];
} {
  const lists: void[] = [];
  const adds: string[] = [];
  const updates: Array<{ id: number; patch: { name?: string; sort_order?: number } }> = [];
  const deletes: number[] = [];
  const client: CategoriesClient = {
    listCategories: async () => { lists.push(undefined); return resp; },
    createCategory: async (name) => { adds.push(name); return resp; },
    updateCategory: async (id, patch) => { updates.push({ id, patch }); return resp; },
    deleteCategory: async (id) => { deletes.push(id); return resp; },
  };
  return { client, lists, adds, updates, deletes };
}

test('categories list：响应去 ok 外壳并补 total（对齐全局 list 输出规范 {total,items}）', async () => {
  const f = fakeClient({ ok: true, items: [{ id: 1, name: 'AI', creator_count: 3 }, { id: 2, name: '理财', creator_count: 0 }] });
  const out = await categoriesList(f.client);
  assert.equal(f.lists.length, 1);
  assert.deepEqual(out, {
    total: 2,
    items: [{ id: 1, name: 'AI', creator_count: 3 }, { id: 2, name: '理财', creator_count: 0 }],
  });
});

test('categories list：items 缺失/非数组 → 兜底空列表（不炸调用方）', async () => {
  const out = await categoriesList(fakeClient({ ok: true }).client);
  assert.deepEqual(out, { total: 0, items: [] });
  const out2 = await categoriesList(fakeClient(null).client);
  assert.deepEqual(out2, { total: 0, items: [] });
});

test('categories add：name 透传给 createCategory（trim 在装配层做，此处透传）', async () => {
  const f = fakeClient({ ok: true, category: { id: 9, name: 'AI 基础', sort_order: 0, creator_count: 0 } });
  const out = await categoriesAdd(f.client, 'AI 基础');
  assert.deepEqual(f.adds, ['AI 基础']);
  assert.deepEqual(out, { ok: true, category: { id: 9, name: 'AI 基础', sort_order: 0, creator_count: 0 } });
});

test('categories update：id + patch（name/sort_order 只含已传键）透传给 updateCategory', async () => {
  const f = fakeClient({ ok: true, category: { id: 3, name: '新名', sort_order: 2, creator_count: 1 } });
  const out = await categoriesUpdate(f.client, 3, { name: '新名', sort_order: 2 });
  assert.deepEqual(f.updates, [{ id: 3, patch: { name: '新名', sort_order: 2 } }]);
  assert.deepEqual(out, { ok: true, category: { id: 3, name: '新名', sort_order: 2, creator_count: 1 } });
});

test('categories delete：id 透传给 deleteCategory（{ok:true} 原样返回）', async () => {
  const f = fakeClient({ ok: true });
  const out = await categoriesDelete(f.client, 7);
  assert.deepEqual(f.deletes, [7]);
  assert.deepEqual(out, { ok: true });
});
