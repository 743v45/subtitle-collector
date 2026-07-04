// collect 命令组纯处理函数测试。
// 用伪造的 client（listClients/sendCommand 同签名 stub，记录调用参数 + 返回固定 Promise）
// 注入纯函数，断言下发参数 / 返回透传 / 判重逻辑正确。不真起 server（契约由 http 层覆盖）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { collectSearch, collectSubtitle, collectDedupe, collectUpperInfo, collectUpperVideos, collectNewVideos, collectDiscover, resolveClientId } from './collect.js';

function mockClient(sendCommandResult: unknown, listClientsResult: unknown[] = [{ client_id: 'c1' }]) {
  const calls: Array<{ clientId: string; action: string; params: unknown; timeout: number }> = [];
  return {
    calls,
    async listClients() { return listClientsResult; },
    async sendCommand(clientId: string, action: string, params: Record<string, unknown>, timeout: number) {
      calls.push({ clientId, action, params, timeout });
      return sendCommandResult;
    },
  };
}

test('collectSearch 下发 search action 并透传回执', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { total: 5, items: [{ bvid: 'BV1' }] } } });
  const out = await collectSearch(c as any, 'c1', 'RAG', { page: 2, order: 'pubdate' }, 15000);
  assert.deepEqual(c.calls[0], { clientId: 'c1', action: 'search', params: { keyword: 'RAG', page: 2, order: 'pubdate' }, timeout: 15000 });
  assert.deepEqual(out, { ok: true, result: { ok: true, data: { total: 5, items: [{ bvid: 'BV1' }] } } });
});

test('resolveClientId 显式传入则透传', async () => {
  const c = mockClient([], [{ client_id: 'c1' }, { client_id: 'c2' }]);
  assert.equal(await resolveClientId(c as any, 'c2'), 'c2');
});

test('resolveClientId 未传入取第一个在线', async () => {
  const c = mockClient([], [{ client_id: 'c9' }]);
  assert.equal(await resolveClientId(c as any, undefined), 'c9');
});

test('resolveClientId 无在线 client → 抛错', async () => {
  const c = mockClient([], []);
  await assert.rejects(() => resolveClientId(c as any, undefined), /no online client/);
});

test('collectSubtitle 下发 fetch-subtitle action', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { bvid: 'BV1', tracks: 2, ingested: true } } });
  const out = await collectSubtitle(c as any, 'c1', 'BV1', 15000);
  assert.deepEqual(c.calls[0], { clientId: 'c1', action: 'fetch-subtitle', params: { bvid: 'BV1' }, timeout: 15000 });
  assert.deepEqual(out, { ok: true, result: { ok: true, data: { bvid: 'BV1', tracks: 2, ingested: true } } });
});

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE videos (id INTEGER PRIMARY KEY, source TEXT, source_vid TEXT, title TEXT, first_seen_at INTEGER, UNIQUE(source, source_vid));`);
  return db;
}

test('collectDedupe 按视频是否在库分 collected/missing', () => {
  const db = makeDb();
  db.prepare("INSERT INTO videos (source, source_vid, title, first_seen_at) VALUES ('bilibili','BV1','t',1)").run();
  const out = collectDedupe(db, ['BV1', 'BV2', 'BV3']);
  assert.deepEqual(out.collected.sort(), ['BV1']);
  assert.deepEqual(out.missing.sort(), ['BV2', 'BV3']);
});

test('collectDedupe 空输入 → 空结果', () => {
  const db = makeDb();
  assert.deepEqual(collectDedupe(db, []), { collected: [], missing: [] });
});

test('collectUpperInfo 下发 get-upper-info', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { mid: '123', name: 'up1', fans: 1000 } } });
  const out = await collectUpperInfo(c as any, 'c1', '123', 15000);
  assert.deepEqual(c.calls[0], { clientId: 'c1', action: 'get-upper-info', params: { mid: '123' }, timeout: 15000 });
  assert.deepEqual(out, { ok: true, result: { ok: true, data: { mid: '123', name: 'up1', fans: 1000 } } });
});

test('collectUpperVideos 下发 list-upper-videos', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { total: 2, items: [{ bvid: 'BV1' }] } } });
  const out = await collectUpperVideos(c as any, 'c1', '123', { page: 1, size: 30 }, 15000);
  assert.deepEqual(c.calls[0], { clientId: 'c1', action: 'list-upper-videos', params: { mid: '123', page: 1, page_size: 30 }, timeout: 15000 });
  assert.deepEqual(out, { ok: true, result: { ok: true, data: { total: 2, items: [{ bvid: 'BV1' }] } } });
});

test('collectNewVideos 拉列表 + 对比库 → 返回 new/collected', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { total: 3, items: [
    { bvid: 'BV1' }, { bvid: 'BV2' }, { bvid: 'BV3' },
  ] } } });
  const db = makeDb();
  db.prepare("INSERT INTO videos (source, source_vid, title, first_seen_at) VALUES ('bilibili','BV2','t',1)").run();
  const out = await collectNewVideos(c as any, 'c1', '123', db, { page: 1, size: 30 }, 15000);
  assert.deepEqual(out.new.sort(), ['BV1', 'BV3']);
  assert.deepEqual(out.collected, ['BV2']);
});

test('collectDiscover 批量多 UP，汇总 per_mid + all_new', async () => {
  let call = 0;
  const c = {
    calls: [] as Array<{ action: string; mid: string }>,
    async listClients() { return [{ client_id: 'c1' }]; },
    async sendCommand(clientId: string, action: string, params: Record<string, unknown>, timeout: number) {
      c.calls.push({ action, mid: params.mid as string });
      call++;
      if (action === 'list-upper-videos') {
        const items = call === 1
          ? [{ bvid: 'BV1' }, { bvid: 'BV2' }, { bvid: 'BV3' }]
          : [{ bvid: 'BV2' }, { bvid: 'BV4' }];
        return { ok: true, result: { ok: true, data: { total: items.length, items } } };
      }
      return { ok: true };
    },
  };
  const db = makeDb();
  db.prepare("INSERT INTO videos (source, source_vid, title, first_seen_at) VALUES ('bilibili','BV2','t',1)").run();
  const out = await collectDiscover(c as any, 'c1', db, ['m1', 'm2'], { page: 1, size: 30 }, 15000);
  assert.equal(out.per_mid.length, 2);
  assert.deepEqual(out.per_mid[0].new.sort(), ['BV1', 'BV3']);
  assert.deepEqual(out.per_mid[0].collected, ['BV2']);
  assert.deepEqual(out.per_mid[1].new, ['BV4']);
  assert.deepEqual(out.per_mid[1].collected, ['BV2']);
  assert.deepEqual(out.all_new.sort(), ['BV1', 'BV3', 'BV4']);
});

test('collectDiscover 单 mid 失败记 error，不影响其他', async () => {
  let call = 0;
  const c = {
    async listClients() { return [{ client_id: 'c1' }]; },
    async sendCommand(clientId: string, action: string, params: Record<string, unknown>, timeout: number) {
      call++;
      if (action === 'list-upper-videos') {
        // m1 正常，m2（第二次）失败
        if (call === 1) return { ok: true, result: { ok: true, data: { total: 1, items: [{ bvid: 'BV1' }] } } };
        return { ok: true, result: { ok: false, error: 'bili_-400' } };
      }
      return { ok: true };
    },
  };
  const db = makeDb();
  const out = await collectDiscover(c as any, 'c1', db, ['m1', 'm2'], { page: 1, size: 30 }, 15000);
  assert.equal(out.per_mid.length, 2);
  assert.deepEqual(out.per_mid[0].new, ['BV1']);       // m1 正常
  assert.equal(out.per_mid[0].error, undefined);
  assert.equal(out.per_mid[1].total, 0);               // m2 失败
  assert.match(out.per_mid[1].error ?? '', /bili_-400|list-upper-videos failed/);
  assert.deepEqual(out.all_new, ['BV1']);              // m1 的 new 仍在汇总
});
