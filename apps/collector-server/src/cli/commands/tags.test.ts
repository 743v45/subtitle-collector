// tags 命令组纯处理函数测试：tagsList 直读临时 DB（真实迁移+种子数据），
// tagsApply/tagsRemove 用 fake ServerClient（同 clients.test.ts 范式）断言委托参数。
// commander 装配层（parseNames/isTagSource 校验）不在单测范围（需整 CLI 上下文）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | tagsList 计数/source 过滤/q/topN + DB 缺失抛错 + apply/remove 委托 | 通过 | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { applyVideoTags } from '../../db/tags.js';
import { tagsList, tagsApply, tagsRemove } from './tags.js';
import type { ServerClient } from '../http.js';

// 种子库：BV1/BV2 两视频；manual 档 ai+面试题 打 BV1，batch 档 ai 打 BV2；另插一个 0 使用标签。
function setup(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-tags-'));
  const dbPath = join(dir, 'test.db');
  const db = openDb(dbPath);
  migrate(db);
  const ingest = (sv: string) => ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: sv, title: `t-${sv}`, creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 10, published_at: 1700000000000 },
    tracks: [],
  });
  ingest('BV1');
  ingest('BV2');
  applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV1' }], ['ai', '面试题'], 'manual');
  applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV2' }], ['ai'], 'batch');
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?, ?)').run('未用标签', 0);
  db.close();
  return { dbPath, dir };
}

// ── tagsList ──

test('tagsList：默认全档计数（含 0 使用标签），返回 {items, total}', () => {
  const { dbPath, dir } = setup();
  try {
    const r = tagsList(dbPath, {});
    assert.equal(r.total, 3);
    const ai = r.items.find((t) => t.name === 'ai');
    assert.ok(ai, 'ai 标签应在列');
    assert.deepEqual(ai.counts, { manual: 1, batch: 1, ai: 0, system: 0, total: 2 });
    const unused = r.items.find((t) => t.name === '未用标签');
    assert.ok(unused, '0 使用标签默认在列（标签库可复用）');
    assert.deepEqual(unused.counts, { manual: 0, batch: 0, ai: 0, system: 0, total: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tagsList：source 只列该档 >0；q 模糊；topN 截断', () => {
  const { dbPath, dir } = setup();
  try {
    // 追加 ai 档（重开写连接打标后再关，tagsList 才走只读连接）
    const db = openDb(dbPath);
    applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV1' }], ['面试题'], 'ai');
    db.close();

    // 种子 ai 档全 0 → source=ai 过滤后为空；打上后仅「面试题」出现
    const r = tagsList(dbPath, { source: 'ai' });
    assert.deepEqual(r.items.map((t) => t.name), ['面试题']);

    const q = tagsList(dbPath, { q: '面试' });
    assert.deepEqual(q.items.map((t) => t.name), ['面试题']);

    const top = tagsList(dbPath, { topN: 1 });
    assert.equal(top.items.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tagsList：DB 文件不存在 → 抛错（commander 层转 DB_UNREADABLE）', () => {
  assert.throws(() => tagsList('/nonexistent/path/x.db', {}));
});

// ── tagsApply / tagsRemove（委托 ServerClient）──

// fake ServerClient（同 clients.test.ts 范式）：记录调用参数，返回固定体。
function fakeClient(): { client: ServerClient; calls: { apply: unknown[][]; remove: unknown[][] } } {
  const calls = { apply: [] as unknown[][], remove: [] as unknown[][] };
  const stub = {
    applyTags: async (...args: unknown[]) => { calls.apply.push(args); return { ok: true, inserted: 3 }; },
    removeTags: async (...args: unknown[]) => { calls.remove.push(args); return { ok: true, removed: 1 }; },
  };
  return { client: stub as unknown as ServerClient, calls };
}

test('tagsApply：委托 client.applyTags(bvids, names, source) 并透传返回', async () => {
  const { client, calls } = fakeClient();
  const out = await tagsApply(client, ['BV1', 'BV2'], ['ai'], 'ai');
  assert.deepEqual(calls.apply, [[['BV1', 'BV2'], ['ai'], 'ai']]);
  assert.deepEqual(out, { ok: true, inserted: 3 });
});

test('tagsRemove：source 可选透传（省略 = 删全档）', async () => {
  const { client, calls } = fakeClient();
  await tagsRemove(client, ['BV1'], ['ai']);
  await tagsRemove(client, ['BV1'], ['ai'], 'manual');
  assert.deepEqual(calls.remove, [
    [['BV1'], ['ai'], undefined],
    [['BV1'], ['ai'], 'manual'],
  ]);
});
