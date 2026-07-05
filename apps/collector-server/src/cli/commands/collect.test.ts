// collect 命令组纯处理函数测试。
// 用伪造的 client（listClients/sendCommand 同签名 stub，记录调用参数 + 返回固定 Promise）
// 注入纯函数，断言下发参数 / 返回透传 / 判重逻辑正确。不真起 server（契约由 http 层覆盖）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, runMigrations } from '../../db/migrate.js';
import { collectSearch, collectSubtitle, collectDedupe, collectUpperInfo, collectUpperVideos, collectUpperVideosAll, collectNewVideos, collectDiscover, resolveClientId, collectNosub, type CollectClient } from './collect.js';

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

test('collectUpperVideosAll 翻页合并直到拿满 total', async () => {
  // total=5、size=2：page1=[a,b] page2=[c,d] page3=[e]（本页 items < size 即到尾终止）
  const pages = [
    { total: 5, items: [{ bvid: 'a' }, { bvid: 'b' }] },
    { total: 5, items: [{ bvid: 'c' }, { bvid: 'd' }] },
    { total: 5, items: [{ bvid: 'e' }] },
  ];
  let call = 0;
  const c = {
    calls: [] as Array<{ page: number }>,
    async listClients() { return [{ client_id: 'c1' }]; },
    async sendCommand(clientId: string, action: string, params: Record<string, unknown>, timeout: number) {
      c.calls.push({ page: params.page as number });
      return { ok: true, result: { ok: true, data: pages[call++] } };
    },
  };
  const out = await collectUpperVideosAll(c as any, 'c1', '123', 2, 15000);
  assert.equal(c.calls.length, 3);
  assert.deepEqual(c.calls.map((x) => x.page), [1, 2, 3]);
  assert.deepEqual(out.result?.data?.items?.map((x) => x.bvid), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(out.result?.data?.total, 5);
});

test('collectUpperVideosAll 一次拿完（items < size 即停，不超翻）', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { total: 2, items: [{ bvid: 'a' }, { bvid: 'b' }] } } });
  const out = await collectUpperVideosAll(c as any, 'c1', '123', 30, 15000);
  assert.equal(c.calls.length, 1);
  assert.equal(out.result?.data?.total, 2);
});

test('collectUpperVideosAll 单页失败抛错', async () => {
  const c = mockClient({ ok: true, result: { ok: false, error: 'bili_-412' } });
  await assert.rejects(() => collectUpperVideosAll(c as any, 'c1', '123', 30, 15000), /bili_-412|list-upper-videos failed/);
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

test('collectUpperVideosAll sinceCreated 过滤（保留 null created）', async () => {
  // 时间窗起点 1700000001：BV1(1700000000) 被 filter；BV2(1750000000) 保留；BV3(null) 保留避免漏采。
  const items = [
    { bvid: 'BV1', created: 1700000000 },
    { bvid: 'BV2', created: 1750000000 },
    { bvid: 'BV3', created: null as unknown as undefined },
  ];
  const client: CollectClient = {
    listClients: async () => [{ client_id: 'c1' }],
    sendCommand: async () => ({ ok: true, result: { ok: true, data: { total: 3, items } } }),
  };
  const resp = await collectUpperVideosAll(client, 'c1', 'mid123', 30, 1000, 1700000001);
  const bv = resp.result!.data!.items!.map((i) => i.bvid);
  assert.deepEqual(bv.sort(), ['BV2', 'BV3']); // BV1 被时间窗过滤；BV3 null 保留
});

test('collectNosub 识别「有 video 无 track」', () => {
  // 完整 schema：creators + videos + subtitle_tracks（migrate 建 categories/creators，schema.sql 建其余）。
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  // creator + 3 视频：V1 有轨 / V2 无轨 / V3 无轨
  const now = Date.now();
  const ci = db.prepare('INSERT INTO creators (source, source_uid, first_seen_at, updated_at) VALUES (?,?,?,?)').run('bilibili', 'u', now, now);
  const ins = db.prepare('INSERT INTO videos (source, source_vid, creator_id, title, first_seen_at, updated_at) VALUES (?,?,?,?,?,?)');
  const v1 = ins.run('bilibili', 'BV1', ci.lastInsertRowid, 't1', now, now);
  const v2 = ins.run('bilibili', 'BV2', ci.lastInsertRowid, 't2', now, now);
  ins.run('bilibili', 'BV3', ci.lastInsertRowid, 't3', now, now);
  db.prepare('INSERT INTO subtitle_tracks (video_id, lan, lan_doc, track_type) VALUES (?,?,?,?)').run(v1.lastInsertRowid, 'zh', '', 1);
  // 故意复用 v2 变量名占位（避免 lint 未用告警，同时构造「无轨」场景）
  void v2;
  const nosub = collectNosub(db, ['BV1', 'BV2', 'BV3', 'BVx']);
  assert.deepEqual(nosub.sort(), ['BV2', 'BV3']); // BV1 有轨不算；BVx 不在库不算
});

test('collectNosub 空输入 → 空结果', () => {
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  assert.deepEqual(collectNosub(db, []), []);
});
