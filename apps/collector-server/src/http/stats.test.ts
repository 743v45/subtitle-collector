import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { handleQueryHttp } from './queries.js';
import { handleStatsHttp } from './stats.js';
import { handleCreatorsHttp } from './creators.js';

const T = 1_700_000_000_000; // 基准毫秒时间戳

// 构造样本库（同 advanced.test.ts 结构）：2 UP / 4 视频（不同分区/标签/语言/轨类型/时长）。
// V1 alpha 单机游戏 zh-Hans CC+en（tags 游戏/实况，tid 17，view 1000）
// V2 alpha 科技 zh-Hans AI（tags 数码，tid 122，view 5000）
// V3 beta 单机游戏 en CC（tags 游戏，tid 17，view 200）
// V4 beta 生活 无轨（tags []，tid 21，view 50）
function setup(opts: { withTodayVideo?: boolean } = {}): Promise<{ port: number; cleanup: () => void; alphaId: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-stats-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);

  const ingest = (
    sourceVid: string, title: string, creatorUid: string, creatorName: string,
    extra: Record<string, unknown>, duration: number, publishedAt: number,
    tracks: Array<{ lan?: string; lan_doc?: string; track_type?: number; versions: Array<{ origin: string; payload: unknown; source_url?: string | null }> }>,
  ) => ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: sourceVid, title, creator: { source_uid: creatorUid, name: creatorName }, extra, duration, published_at: publishedAt },
    tracks,
  });

  ingest('BV1', '标题A', '1', 'Alpha UP', { tid: 17, tname: '单机游戏', tags: [{ tag_id: 1, tag_name: '游戏' }, { tag_id: 2, tag_name: '实况' }], stat: { view: 1000 } }, 600, T + 1000, [
    { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://cc' }] },
    { lan: 'en', lan_doc: 'English', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://en' }] },
  ]);
  ingest('BV2', '标题B', '1', 'Alpha UP', { tid: 122, tname: '科技', tags: [{ tag_id: 3, tag_name: '数码' }], stat: { view: 5000 } }, 300, T + 2000, [
    { lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://ai' }] },
  ]);
  ingest('BV3', '标题C', '2', 'Beta UP', { tid: 17, tname: '单机游戏', tags: [{ tag_id: 1, tag_name: '游戏' }], stat: { view: 200 } }, 1200, T + 3000, [
    { lan: 'en', lan_doc: 'English CC', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://encc' }] },
  ]);
  ingest('BV4', '标题D', '2', 'Beta UP', { tid: 21, tname: '生活', tags: [], stat: { view: 50 } }, 60, T + 4000, []);

  // 覆写 first_seen_at 为确定值（ingest 用 Date.now()）
  const setSeen = (sv: string, ts: number) => db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(ts, sv);
  setSeen('BV1', T + 100);
  setSeen('BV2', T + 200);
  setSeen('BV3', T + 300);
  setSeen('BV4', T + 400);

  // 可选：插一条「今日」视频（today_videos 用例用；本地 00:00 后 1 分钟，确保 ≥ 当日零点）
  if (opts.withTodayVideo) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    ingest('BV5', '今日视频', '1', 'Alpha UP', { tid: 17, tname: '单机游戏', tags: [], stat: { view: 1 } }, 100, T + 5000, [
      { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: { body: [] } }] },
    ]);
    setSeen('BV5', midnight.getTime() + 60_000);
  }

  // 给 alpha 补富字段，验证 creator 详情（task #3）
  const alphaRow = db.prepare("SELECT id FROM creators WHERE source_uid = '1'").get() as { id: number };
  db.prepare('UPDATE creators SET sign = ?, level = ?, fans = ?, official_type = ?, official_title = ? WHERE id = ?')
    .run('alpha 的签名', 6, 12345, 0, '官方认证', alphaRow.id);

  const httpServer = createServer((req, res) => {
    // 分发顺序与 main.ts 一致：creators/stats 优先于 /api/ 兜底
    if (req.url?.startsWith('/api/creators')) { handleCreatorsHttp(req, res, db); return; }
    if (req.url?.startsWith('/api/stats')) { handleStatsHttp(req, res, db); return; }
    if (req.url?.startsWith('/api/')) { handleQueryHttp(req, res, db); return; }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port;
      resolve({ port, alphaId: alphaRow.id, cleanup: () => { httpServer.close(); rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}

function httpGet(port: number, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (res: IncomingMessage) => {
      let buf = ''; res.on('data', (c: Buffer) => (buf += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(buf || '{}') }));
    });
    req.end();
  });
}
const titles = (items: Array<{ title: string }>) => items.map((i) => i.title);

test('GET /api/videos：tag 过滤返回正确子集，items 含 tags/tname/tid 富字段', async () => {
  const ctx = await setup();
  try {
    const r = await httpGet(ctx.port, `/api/videos?tag=${encodeURIComponent('游戏')}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(titles(r.json.items).sort(), ['标题A', '标题C']);
    // 富字段：V1 的 tags 降维成 tag_name 数组（tag_details 语义后按名字序）、tname/tid 取自 extra
    const v1 = r.json.items.find((i: any) => i.title === '标题A');
    assert.equal(v1.tid, 17);
    assert.equal(v1.tname, '单机游戏');
    assert.deepEqual([...v1.tags].sort(), ['实况', '游戏'].sort());
    // 全部列都在：creator_name/creator_source_uid/duration/published_at/first_seen_at/track_count
    assert.equal(v1.creator_name, 'Alpha UP');
    assert.equal(v1.creator_source_uid, '1');
    assert.equal(v1.duration, 600);
    assert.equal(v1.published_at, T + 1000);
    assert.equal(v1.track_count, 2);
  } finally { ctx.cleanup(); }
});

test('GET /api/videos：tid 过滤返回正确子集（V1+V3 tid=17）', async () => {
  const ctx = await setup();
  try {
    const r = await httpGet(ctx.port, '/api/videos?tid=17');
    assert.equal(r.status, 200);
    assert.deepEqual(titles(r.json.items).sort(), ['标题A', '标题C']);
    // V4 无 tags → tags 空数组、tid 来自 extra
    const r2 = await httpGet(ctx.port, '/api/videos?tid=21');
    assert.deepEqual(titles(r2.json.items), ['标题D']);
    assert.deepEqual(r2.json.items[0].tags, []);
    assert.equal(r2.json.items[0].tid, 21);
  } finally { ctx.cleanup(); }
});

test('GET /api/videos：向后兼容——只传 q 仍工作，返回 {total,page,size,items}', async () => {
  const ctx = await setup();
  try {
    const r = await httpGet(ctx.port, `/api/videos?q=${encodeURIComponent('标题A')}`);
    assert.equal(r.status, 200);
    assert.deepEqual(titles(r.json.items), ['标题A']);
    assert.equal(r.json.total, 1);
    assert.equal(r.json.page, 1);
    assert.equal(r.json.size, 20);
    // 默认排序兼容旧 /api/videos：first_seen DESC（最新在前）→ V4,V3,V2,V1
    const all = await httpGet(ctx.port, '/api/videos');
    assert.deepEqual(titles(all.json.items), ['标题D', '标题C', '标题B', '标题A']);
  } finally { ctx.cleanup(); }
});

test('GET /api/videos：非法参数不崩（tid/sort/has_subtitle 非法一律忽略，不 500）', async () => {
  const ctx = await setup();
  try {
    const r = await httpGet(ctx.port, '/api/videos?tid=abc&sort=bogus&has_subtitle=maybe&track_type=zzz&since=NaN&page=oops&size=huge');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.total, 4); // 全部非法过滤被忽略 → 4 条
    assert.equal(r.json.page, 1);  // page 非法 → 默认 1
    assert.equal(r.json.size, 20); // size 非法 → 默认 20
    // 显式升序可用：sort=duration desc=0 → 升序 V4(60)<V2(300)<V1(600)<V3(1200)
    const asc = await httpGet(ctx.port, '/api/videos?sort=duration&desc=0');
    assert.deepEqual(titles(asc.json.items), ['标题D', '标题B', '标题A', '标题C']);
  } finally { ctx.cleanup(); }
});

test('GET /api/stats?type=overview：总览数字正确（total + 分平台 by_source）', async () => {
  const ctx = await setup();
  try {
    const r = await httpGet(ctx.port, '/api/stats?type=overview');
    assert.equal(r.status, 200);
    assert.equal(r.json.total.videos, 4);
    assert.equal(r.json.total.tracks, 4);
    assert.equal(r.json.total.versions, 4);
    assert.equal(r.json.total.creators, 2);
    assert.equal(r.json.total.languages, 2);
    assert.equal(r.json.total.categories, 3);
    assert.equal(r.json.total.first_seen_min, T + 100);
    assert.equal(r.json.total.first_seen_max, T + 400);
    // 单平台种子：by_source 只含 bilibili 且与 total 一致
    assert.deepEqual(Object.keys(r.json.by_source), ['bilibili']);
    assert.equal(r.json.by_source.bilibili.videos, 4);
    assert.equal(r.json.by_source.bilibili.tracks, 4);
  } finally { ctx.cleanup(); }
});

test('GET /api/stats?type=overview：today_videos 只计当日本地 00:00 后入库的视频', async () => {
  const ctx = await setup({ withTodayVideo: true });
  try {
    const r = await httpGet(ctx.port, '/api/stats?type=overview');
    assert.equal(r.status, 200);
    // 仅 BV5（今日）；BV1-4 的 first_seen 在 2023 年 → 不计
    assert.equal(r.json.total.today_videos, 1);
  } finally { ctx.cleanup(); }
});

test('GET /api/stats?type=overview：无当日入库时 today_videos = 0', async () => {
  const ctx = await setup();
  try {
    const r = await httpGet(ctx.port, '/api/stats?type=overview');
    assert.equal(r.status, 200);
    assert.equal(r.json.total.today_videos, 0);
  } finally { ctx.cleanup(); }
});

test('GET /api/stats?type=aggregate&groupBy=tname：分组聚合正确（单机游戏 2 条）', async () => {
  const ctx = await setup();
  try {
    const r = await httpGet(ctx.port, '/api/stats?type=aggregate&groupBy=tname');
    assert.equal(r.status, 200);
    const top = r.json.items[0];
    assert.equal(top.key, '单机游戏');
    assert.equal(top.count, 2);
    assert.equal(r.json.items.length, 3); // 单机游戏 / 科技 / 生活
  } finally { ctx.cleanup(); }
});

// groupBy=source（2026-08-24）：按平台分组；与 ?source= 过滤组合
test('GET /api/stats?type=aggregate&groupBy=source：按平台分组计数', async () => {
  const ctx = await setup();
  try {
    const r = await httpGet(ctx.port, '/api/stats?type=aggregate&groupBy=source');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.items, [{ key: 'bilibili', count: 4 }]);
    // 与 source 过滤组合（YouTube 空库 → 空数组）
    const yt = await httpGet(ctx.port, '/api/stats?type=aggregate&groupBy=source&source=youtube');
    assert.equal(yt.status, 200);
    assert.deepEqual(yt.json.items, []);
  } finally { ctx.cleanup(); }
});

test('GET /api/stats aggregate：VideoFilter 透传（has_subtitle=true → V4 排除，Beta 计 1）', async () => {
  const ctx = await setup();
  try {
    const r = await httpGet(ctx.port, '/api/stats?type=aggregate&groupBy=creator&has_subtitle=true');
    assert.equal(r.status, 200);
    const beta = r.json.items.find((i: any) => i.key === 'Beta UP');
    assert.equal(beta.count, 1); // V4 无轨被排除
    const alpha = r.json.items.find((i: any) => i.key === 'Alpha UP');
    assert.equal(alpha.count, 2);
  } finally { ctx.cleanup(); }
});

test('GET /api/stats：非法 type / 缺 groupBy / 非法 groupBy → 400', async () => {
  const ctx = await setup();
  try {
    const r1 = await httpGet(ctx.port, '/api/stats?type=bogus');
    assert.equal(r1.status, 400);
    assert.equal(r1.json.ok, false);
    const r2 = await httpGet(ctx.port, '/api/stats?type=aggregate');
    assert.equal(r2.status, 400);
    assert.equal(r2.json.ok, false);
    const r3 = await httpGet(ctx.port, '/api/stats?type=aggregate&groupBy=bogus');
    assert.equal(r3.status, 400);
    assert.equal(r3.json.error, 'groupBy must be one of creator|tname|lang|track-type|tag|source');
  } finally { ctx.cleanup(); }
});

// ── 分支洼地：type 缺省回落 overview、topN 非法回落 20 / 越界夹取 ──
test('GET /api/stats：缺 type → 默认 overview；topN 非法回落 20、越大夹 500', async () => {
  const ctx = await setup();
  try {
    // 缺 type 参数 → 'overview'（?? 'overview' 分支）
    const r = await httpGet(ctx.port, '/api/stats');
    assert.equal(r.status, 200);
    assert.equal(r.json.total.videos, 4);
    // topN=abc（NaN）→ || 20 回落；topN=1 截 1 条
    const agg = await httpGet(ctx.port, '/api/stats?type=aggregate&groupBy=tname&topN=abc');
    assert.equal(agg.status, 200);
    assert.equal(agg.json.items.length, 3, '非法 topN 回落 20 不截断（只有 3 个分区）');
    const one = await httpGet(ctx.port, '/api/stats?type=aggregate&groupBy=tname&topN=1');
    assert.equal(one.json.items.length, 1);
    const big = await httpGet(ctx.port, '/api/stats?type=aggregate&groupBy=tname&topN=99999');
    assert.equal(big.status, 200, '超大 topN 夹到 500，不报错');
    assert.equal(big.json.items.length, 3);
  } finally { ctx.cleanup(); }
});

test('GET /api/creators/:id：返回富字段（sign/level/fans/official_*）——task #3', async () => {
  const ctx = await setup();
  try {
    const r = await httpGet(ctx.port, `/api/creators/${ctx.alphaId}`);
    assert.equal(r.status, 200);
    const c = r.json.creator;
    assert.equal(c.sign, 'alpha 的签名');
    assert.equal(c.level, 6);
    assert.equal(c.fans, 12345);
    assert.equal(c.official_title, '官方认证');
    assert.equal(c.name, 'Alpha UP');
  } finally { ctx.cleanup(); }
});
