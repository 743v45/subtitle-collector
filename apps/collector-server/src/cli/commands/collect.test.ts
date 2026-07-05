// collect 命令组纯处理函数测试。
// 用伪造的 client（listClients/sendCommand 同签名 stub，记录调用参数 + 返回固定 Promise）
// 注入纯函数，断言下发参数 / 返回透传 / 判重逻辑正确。不真起 server（契约由 http 层覆盖）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, runMigrations } from '../../db/migrate.js';
import { collectSearch, collectSubtitle, collectDedupe, collectUpperInfo, collectUpperVideos, collectUpperVideosAll, collectNewVideos, collectDiscover, resolveClientId, collectNosub, filterByPubdate, filterByFans, parseSince, parseDateToUnix, resolveFans, collectFindSearch, collectFind, type CollectClient, type SearchItem, type FindItem, type FansSource } from './collect.js';

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

// ── collect find：条件检索纯函数（多页搜索 + 发布时间/粉丝数过滤）──
// 措辞：字幕（subtitle），非弹幕。

test('filterByPubdate since=undefined → 原样返回全部（同引用）', () => {
  const items: SearchItem[] = [
    { bvid: 'BV1', pubdate: 100 },
    { bvid: 'BV2', pubdate: 200 },
    { bvid: 'BV3' }, // pubdate 缺失
  ];
  assert.equal(filterByPubdate(items, undefined), items);
});

test('filterByPubdate since=N → 只留 pubdate>=N，pubdate==null 保留', () => {
  const items: SearchItem[] = [
    { bvid: 'BV1', pubdate: 100 },
    { bvid: 'BV2', pubdate: 200 },
    { bvid: 'BV3', pubdate: 50 },
    { bvid: 'BV4' }, // pubdate 缺失 → 保留（避免漏采刚发布的视频）
  ];
  const out = filterByPubdate(items, 100);
  assert.deepEqual(out.map((i) => i.bvid), ['BV1', 'BV2', 'BV4']);
});

test('filterByFans minFans<=0 或 undefined → 不过滤（同引用）', () => {
  const items: FindItem[] = [
    { bvid: 'BV1', fans: 5 },
    { bvid: 'BV2', fans: null },
  ];
  assert.equal(filterByFans(items, 0), items);
  assert.equal(filterByFans(items, -1), items);
  assert.equal(filterByFans(items, undefined), items);
});

test('filterByFans minFans=10000 → 只留 fans>=10000，fans==null 保留', () => {
  const items: FindItem[] = [
    { bvid: 'BV1', fans: 5000 },
    { bvid: 'BV2', fans: 20000 },
    { bvid: 'BV3', fans: 10000 },
    { bvid: 'BV4', fans: null }, // 未知 → 保留（保守，宁可多列再人工筛）
  ];
  const out = filterByFans(items, 10000);
  assert.deepEqual(out.map((i) => i.bvid), ['BV2', 'BV3', 'BV4']);
});

test('parseSince only since → 直接返回 since', () => {
  assert.equal(parseSince({ since: 123456 }), 123456);
});

test('parseSince only sinceDays → now - sinceDays*86400（注入固定 now）', () => {
  const now = 1_700_000_000;
  assert.equal(parseSince({ sinceDays: 7, now }), now - 7 * 86400);
});

test('parseSince 都没传 → undefined', () => {
  assert.equal(parseSince({}), undefined);
  assert.equal(parseSince({ since: undefined, sinceDays: undefined }), undefined);
});

test('parseDateToUnix 合法 YYYY-MM-DD → UNIX 秒（本地时区 00:00）', () => {
  const u = parseDateToUnix('2026-07-01');
  assert.equal(u, Math.floor(new Date(2026, 6, 1, 0, 0, 0).getTime() / 1000));
  assert.equal(typeof u, 'number');
});

test('parseDateToUnix 单位数月日也合法（正则允许 \\d{1,2}）', () => {
  const u = parseDateToUnix('2026-7-1');
  assert.equal(u, Math.floor(new Date(2026, 6, 1, 0, 0, 0).getTime() / 1000));
});

test('parseDateToUnix 非法格式 / 空 / undefined → undefined', () => {
  assert.equal(parseDateToUnix('2026/07/01'), undefined);
  assert.equal(parseDateToUnix('not-a-date'), undefined);
  assert.equal(parseDateToUnix(''), undefined);
  assert.equal(parseDateToUnix(undefined), undefined);
});

test('resolveFans 缓存命中部分 + miss 实时补充', async () => {
  const src: FansSource = {
    async readFansFromDb() { return { a: 5000 }; },
    async fetchFans(mid) { return mid === 'b' ? 9999 : null; },
  };
  const out = await resolveFans(['a', 'b'], src);
  assert.equal(out.fans.get('a'), 5000);
  assert.equal(out.fans.get('b'), 9999);
  assert.equal(out.cacheHit, 1);
  assert.equal(out.fetched, 1);
  assert.equal(out.unknown, 0);
});

test('resolveFans 全 miss 且实时失败 → unknown 计数', async () => {
  const src: FansSource = {
    async readFansFromDb() { return {}; },
    async fetchFans() { return null; },
  };
  const out = await resolveFans(['x', 'y'], src);
  assert.equal(out.fans.size, 0);
  assert.equal(out.cacheHit, 0);
  assert.equal(out.fetched, 0);
  assert.equal(out.unknown, 2);
});

test('resolveFans 重复 mid 去重（readFansFromDb/fetchFans 各只查一次）', async () => {
  let dbCalls = 0;
  let fetchCalls = 0;
  const src: FansSource = {
    async readFansFromDb(mids) { dbCalls++; assert.deepEqual(mids, ['a']); return {}; },
    async fetchFans(mid) { fetchCalls++; return mid === 'a' ? 100 : null; },
  };
  const out = await resolveFans(['a', 'a'], src);
  assert.equal(out.fans.get('a'), 100);
  assert.equal(out.fans.size, 1);
  assert.equal(dbCalls, 1);
  assert.equal(fetchCalls, 1); // 去重后只 fetch 一次
  assert.equal(out.fetched, 1);
});

test('collectFindSearch 多页搜索合并 + 首页 raw_total + 拿够早停', async () => {
  // page1 有 3 条（total=5），page2 有 2 条；累计达 total 后不翻 page3。
  const pageData: Record<number, { total?: number; items?: SearchItem[] }> = {
    1: { total: 5, items: [
      { bvid: 'BV1', mid: 'm1', pubdate: 100, play: 1 },
      { bvid: 'BV2', mid: 'm2', pubdate: 200, play: 2 },
      { bvid: 'BV3', mid: 'm1', pubdate: 300, play: 3 },
    ] },
    2: { total: 5, items: [
      { bvid: 'BV4', mid: 'm3', pubdate: 400, play: 4 },
      { bvid: 'BV5', mid: 'm2', pubdate: 500, play: 5 },
    ] },
  };
  const calls: number[] = [];
  const client: CollectClient = {
    listClients: async () => [{ client_id: 'c1' }],
    async sendCommand(_clientId, action, params, _timeout) {
      if (action === 'search') {
        calls.push(params.page as number);
        return { ok: true, result: { ok: true, data: pageData[params.page as number] ?? { total: 5, items: [] } } };
      }
      return { ok: true };
    },
  };
  const out = await collectFindSearch(client, 'c1', 'kw', { order: 'pubdate', pages: 3 }, 15000);
  assert.equal(out.raw_total, 5);
  assert.equal(out.items.length, 5);
  assert.deepEqual(calls, [1, 2]); // page2 后 all.length(5) >= raw_total(5) 早停，不翻 page3
  assert.deepEqual(out.items.map((i) => i.bvid), ['BV1', 'BV2', 'BV3', 'BV4', 'BV5']);
});

test('collectFind 端到端：raw_total/fetched/after_date/after_fans + fans 填回', async () => {
  // search：page1 3 条（total=5），page2 2 条。每条带 bvid/mid/pubdate/play。
  const pageData: Record<number, { total?: number; items?: SearchItem[] }> = {
    1: { total: 5, items: [
      { bvid: 'BV1', mid: 'm1', pubdate: 100, play: 1 },
      { bvid: 'BV2', mid: 'm2', pubdate: 200, play: 2 },
      { bvid: 'BV3', mid: 'm1', pubdate: 300, play: 3 },
    ] },
    2: { total: 5, items: [
      { bvid: 'BV4', mid: 'm3', pubdate: 400, play: 4 },
      { bvid: 'BV5', mid: 'm2', pubdate: 500, play: 5 },
    ] },
  };
  const client: CollectClient = {
    listClients: async () => [{ client_id: 'c1' }],
    async sendCommand(_clientId, action, params, _timeout) {
      if (action === 'search') {
        return { ok: true, result: { ok: true, data: pageData[params.page as number] ?? { total: 5, items: [] } } };
      }
      // get-upper-info 不会被 collectFind 直接调用（fans 走注入的 fansSrc）；兜底返回 ok。
      return { ok: true, result: { ok: true, data: { fans: 0 } } };
    },
  };
  // fansSrc：readFansFromDb 返回 {} → 全走 fetchFans（本地 mid→fans map，独立验证编排逻辑）。
  const fansMap: Record<string, number> = { m1: 15000, m2: 8000, m3: 500 };
  const fansSrc: FansSource = {
    async readFansFromDb() { return {}; },
    async fetchFans(mid) { return fansMap[mid] ?? null; },
  };
  // since=150 过滤掉 BV1(pubdate=100)；minFans=10000 只留 m1(=15000) 的 BV3。
  const out = await collectFind(client, 'c1', 'kw',
    { pages: 3, order: 'pubdate', minFans: 10000, since: 150 }, fansSrc, 15000);
  assert.equal(out.raw_total, 5);
  assert.equal(out.fetched, 5);
  assert.equal(out.after_date, 4);     // BV1 被 since=150 过滤
  assert.equal(out.after_fans, 1);     // 只 BV3(m1=15000>=10000) 留下
  assert.equal(out.fans_cache_hit, 0); // readFansFromDb 返回 {}
  assert.equal(out.fans_fetched, 3);   // unique mid {m1,m2,m3} 全走 fetch
  assert.equal(out.fans_unknown, 0);
  assert.deepEqual(out.items.map((i) => i.bvid), ['BV3']);
  assert.equal(out.items[0].fans, 15000); // fans 正确填回
});

test('collectFind fans 部分缓存命中 + 部分实时补充', async () => {
  const pageData: Record<number, { total?: number; items?: SearchItem[] }> = {
    1: { total: 2, items: [
      { bvid: 'BV1', mid: 'm1', pubdate: 100 },
      { bvid: 'BV2', mid: 'm2', pubdate: 200 },
    ] },
  };
  const client: CollectClient = {
    listClients: async () => [{ client_id: 'c1' }],
    async sendCommand(_clientId, action, params, _timeout) {
      if (action === 'search') {
        return { ok: true, result: { ok: true, data: pageData[params.page as number] ?? { total: 2, items: [] } } };
      }
      return { ok: true };
    },
  };
  // m1 走缓存（5000），m2 走实时（20000）；minFans=10000 只留 BV2。
  const fansSrc: FansSource = {
    async readFansFromDb() { return { m1: 5000 }; },
    async fetchFans(mid) { return mid === 'm2' ? 20000 : null; },
  };
  const out = await collectFind(client, 'c1', 'kw',
    { pages: 1, order: 'pubdate', minFans: 10000 }, fansSrc, 15000);
  assert.equal(out.fans_cache_hit, 1);
  assert.equal(out.fans_fetched, 1);
  assert.equal(out.fans_unknown, 0);
  assert.equal(out.after_fans, 1);
  assert.deepEqual(out.items.map((i) => i.bvid), ['BV2']);
  assert.equal(out.items[0].fans, 20000);
});

// ── 测试轮次记录表（对齐全局 CLAUDE.md §8.2）──
// | 轮次 | 日期       | 范围                                              | 结果 |
// |------|------------|---------------------------------------------------|------|
// | 1    | 2026-07-05 | collect find 纯函数单测首增（16 个用例）          | PASS |
