import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from './migrate.js';
import { ingestVideo } from './ingest.js';
import {
  listVideosFiltered,
  getVideoByDbId,
  getChanges,
  aggregateStats,
  countOverview,
} from './advanced.js';

function freshDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'collector-adv-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return { db, dir };
}

const T = 1_700_000_000_000; // 基准毫秒时间戳

// 构造样本库：2 个 UP（alpha/beta），4 个视频（不同分区/标签/语言/轨类型/时长/view），3 条 change_log
function setup(): { db: Database.Database; dir: string; ids: Record<string, number> } {
  const { db, dir } = freshDb();

  const ingest = (
    sourceVid: string,
    title: string,
    creatorUid: string,
    creatorName: string,
    extra: Record<string, unknown>,
    duration: number,
    publishedAt: number,
    tracks: Array<{ lan?: string; lan_doc?: string; track_type?: number; versions: Array<{ origin: string; payload: unknown; source_url?: string | null; asr_engine?: string | null }> }>,
  ) =>
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: sourceVid, title, creator: { source_uid: creatorUid, name: creatorName }, extra, duration, published_at: publishedAt },
      tracks,
    });

  // V1：alpha，单机游戏，zh-Hans CC + en AI，view 1000
  ingest('BV1', '标题A', '1', 'Alpha UP', { tid: 17, tname: '单机游戏', tags: [{ tag_id: 1, tag_name: '游戏' }, { tag_id: 2, tag_name: '实况' }], stat: { view: 1000 } }, 600, T + 1000, [
    { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://cc' }] },
    { lan: 'en', lan_doc: 'English', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://en' }] },
  ]);
  // V2：alpha，科技，zh-Hans AI，view 5000
  ingest('BV2', '标题B', '1', 'Alpha UP', { tid: 122, tname: '科技', tags: [{ tag_id: 3, tag_name: '数码' }], stat: { view: 5000 } }, 300, T + 2000, [
    { lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://ai' }] },
  ]);
  // V3：beta，单机游戏，en CC，view 200
  ingest('BV3', '标题C', '2', 'Beta UP', { tid: 17, tname: '单机游戏', tags: [{ tag_id: 1, tag_name: '游戏' }], stat: { view: 200 } }, 1200, T + 3000, [
    { lan: 'en', lan_doc: 'English CC', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://encc' }] },
  ]);
  // V4：beta，生活，无轨，view 50
  ingest('BV4', '标题D', '2', 'Beta UP', { tid: 21, tname: '生活', tags: [], stat: { view: 50 } }, 60, T + 4000, []);

  // ingest 用 Date.now() 写 first_seen_at，覆写为确定值便于断言排序/时间过滤
  const setSeen = (sv: string, ts: number) => db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(ts, sv);
  setSeen('BV1', T + 100);
  setSeen('BV2', T + 200);
  setSeen('BV3', T + 300);
  setSeen('BV4', T + 400);

  const idOf = (sv: string) => (db.prepare('SELECT id FROM videos WHERE source_vid = ?').get(sv) as { id: number }).id;
  const creatorId = (uid: string) => (db.prepare('SELECT id FROM creators WHERE source_uid = ?').get(uid) as { id: number }).id;
  const ids = { v1: idOf('BV1'), v2: idOf('BV2'), v3: idOf('BV3'), v4: idOf('BV4'), alpha: creatorId('1'), beta: creatorId('2') };

  // change_log 3 条（确定性 changed_at）
  const logIns = db.prepare('INSERT INTO change_log (entity, entity_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)');
  logIns.run('video', ids.v1, 'title', '旧标题', '标题A', T + 50);
  logIns.run('video', ids.v1, 'duration', '500', '600', T + 150);
  logIns.run('creator', ids.alpha, 'name', null, 'Alpha UP', T + 10);

  return { db, dir, ids };
}

const titles = (items: Array<{ title: string }>) => items.map((i) => i.title);

test('listVideosFiltered: 默认 sort=first_seen asc，分页正确，items 含 published_at / creator_source_uid', () => {
  const { db, dir, ids } = setup();
  try {
    const all = listVideosFiltered(db, { sort: 'first_seen' });
    assert.equal(all.total, 4);
    assert.equal(all.page, 1);
    assert.equal(all.size, 20);
    assert.deepEqual(titles(all.items), ['标题A', '标题B', '标题C', '标题D']); // first_seen 升序
    const v1 = all.items[0];
    assert.equal(v1.published_at, T + 1000);
    assert.equal(v1.creator_source_uid, '1');
    assert.equal(v1.track_count, 2);
    // 释放 ids 让 TS 不报 unused（顺带校验 id 真实）
    assert.ok(ids.v1 > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: 分页 page/size', () => {
  const { db, dir } = setup();
  try {
    const p1 = listVideosFiltered(db, { sort: 'first_seen', page: 1, size: 2 });
    assert.deepEqual(titles(p1.items), ['标题A', '标题B']);
    assert.equal(p1.total, 4);
    const p2 = listVideosFiltered(db, { sort: 'first_seen', page: 2, size: 2 });
    assert.deepEqual(titles(p2.items), ['标题C', '标题D']);
    const p3 = listVideosFiltered(db, { sort: 'first_seen', page: 3, size: 2 });
    assert.deepEqual(p3.items, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: 文本/UP/source/tid/tname/tag 过滤', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(titles(listVideosFiltered(db, { q: '标题A' }).items), ['标题A']);
    assert.deepEqual(titles(listVideosFiltered(db, { q: 'Alpha' }).items), ['标题A', '标题B']); // 命中 creator 名
    assert.deepEqual(titles(listVideosFiltered(db, { creator: 'Beta' }).items), ['标题C', '标题D']);
    assert.deepEqual(titles(listVideosFiltered(db, { source: 'bilibili' }).items).sort(), ['标题A', '标题B', '标题C', '标题D']);
    assert.equal(listVideosFiltered(db, { source: 'other' }).total, 0);
    assert.deepEqual(titles(listVideosFiltered(db, { tid: 17 }).items.sort()), ['标题A', '标题C']);
    assert.deepEqual(titles(listVideosFiltered(db, { tname: '单机' }).items.sort()), ['标题A', '标题C']);
    assert.deepEqual(titles(listVideosFiltered(db, { tag: '游戏' }).items.sort()), ['标题A', '标题C']);
    assert.deepEqual(titles(listVideosFiltered(db, { tag: '数码' }).items), ['标题B']);
    assert.deepEqual(titles(listVideosFiltered(db, { tag: '实况' }).items), ['标题A']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: lang / track_type / has_subtitle 过滤', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(titles(listVideosFiltered(db, { lang: 'zh' }).items.sort()), ['标题A', '标题B']);
    assert.deepEqual(titles(listVideosFiltered(db, { lang: 'en' }).items.sort()), ['标题A', '标题C']);
    assert.deepEqual(titles(listVideosFiltered(db, { track_type: 2 }).items.sort()), ['标题A', '标题C']); // CC 轨
    assert.deepEqual(titles(listVideosFiltered(db, { track_type: 1 }).items.sort()), ['标题A', '标题B']); // AI 轨
    assert.deepEqual(titles(listVideosFiltered(db, { has_subtitle: true }).items.sort()), ['标题A', '标题B', '标题C']); // V4 无轨/版本被排除
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: since/until 比对 first_seen_at（毫秒）', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(titles(listVideosFiltered(db, { since: T + 250 }).items.sort()), ['标题C', '标题D']);
    assert.deepEqual(titles(listVideosFiltered(db, { until: T + 150 }).items.sort()), ['标题A']);
    assert.deepEqual(titles(listVideosFiltered(db, { since: T + 150, until: T + 300 }).items.sort()), ['标题B', '标题C']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: min/max duration', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(titles(listVideosFiltered(db, { min_duration: 500 }).items.sort()), ['标题A', '标题C']);
    assert.deepEqual(titles(listVideosFiltered(db, { max_duration: 300 }).items.sort()), ['标题B', '标题D']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: sort 各键 + desc', () => {
  const { db, dir } = setup();
  try {
    // view desc：V2(5000) > V1(1000) > V3(200) > V4(50)
    assert.deepEqual(titles(listVideosFiltered(db, { sort: 'view', desc: true }).items), ['标题B', '标题A', '标题C', '标题D']);
    // duration asc：V4(60) < V2(300) < V1(600) < V3(1200)
    assert.deepEqual(titles(listVideosFiltered(db, { sort: 'duration' }).items), ['标题D', '标题B', '标题A', '标题C']);
    // duration desc
    assert.deepEqual(titles(listVideosFiltered(db, { sort: 'duration', desc: true }).items), ['标题C', '标题A', '标题B', '标题D']);
    // published_at asc：V1 < V2 < V3 < V4
    assert.deepEqual(titles(listVideosFiltered(db, { sort: 'published_at' }).items), ['标题A', '标题B', '标题C', '标题D']);
    // title asc
    assert.deepEqual(titles(listVideosFiltered(db, { sort: 'title' }).items), ['标题A', '标题B', '标题C', '标题D']);
    // first_seen desc
    assert.deepEqual(titles(listVideosFiltered(db, { sort: 'first_seen', desc: true }).items), ['标题D', '标题C', '标题B', '标题A']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: 组合过滤（tname + tag + lang）', () => {
  const { db, dir } = setup();
  try {
    // alpha + 单机游戏：V1（V3 是 beta）
    assert.deepEqual(titles(listVideosFiltered(db, { creator: 'Alpha', tname: '单机' }).items), ['标题A']);
    // zh 轨 + CC 轨：仅 V1（zh-Hans CC）
    assert.deepEqual(titles(listVideosFiltered(db, { lang: 'zh', track_type: 2 }).items), ['标题A']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideoByDbId: 轨优先级 CC中文>AI中文>en，is_default 标记，每个 track 各自 default version', () => {
  const { db, dir, ids } = setup();
  try {
    const d = getVideoByDbId(db, ids.v1);
    if (!d) throw new Error('no detail');
    assert.equal(d.tracks.length, 2);
    assert.equal(d.tracks[0].lan_doc, 'CC中文'); // track_type=2 zh-Hans 优先级 0
    assert.equal((d.tracks[0] as { is_default?: boolean }).is_default, true);
    assert.equal((d.tracks[1] as { is_default?: boolean }).is_default, false);
    // 每个 track 内 external 优先级最高 → default
    for (const t of d.tracks) {
      const defs = t.versions.filter((v) => (v as { is_default?: boolean }).is_default);
      assert.equal(defs.length, 1);
      assert.equal(defs[0].origin, 'external');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideoByDbId: 不存在返回 null', () => {
  const { db, dir } = setup();
  try {
    assert.equal(getVideoByDbId(db, 99999), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getChanges: entity / entity_id / field 过滤 + 分页', () => {
  const { db, dir, ids } = setup();
  try {
    const all = getChanges(db, {}, 1, 20);
    assert.equal(all.total, 3);
    assert.deepEqual(all.items.map((c) => c.field).sort(), ['duration', 'name', 'title']);
    // entity 过滤
    assert.equal(getChanges(db, { entity: 'video' }, 1, 20).total, 2);
    assert.equal(getChanges(db, { entity: 'creator' }, 1, 20).total, 1);
    // entity + entity_id 组合（注意：creators 与 videos 各自 AUTOINCREMENT，id 可能撞号，必须 entity 同带）
    assert.equal(getChanges(db, { entity: 'video', entity_id: ids.v1 }, 1, 20).total, 2);
    // field 过滤
    assert.equal(getChanges(db, { field: 'title' }, 1, 20).total, 1);
    // 分页：changed_at desc 顺序 → T+150(duration), T+50(title), T+10(name)
    const p1 = getChanges(db, {}, 1, 2);
    assert.equal(p1.items.length, 2);
    assert.equal(p1.items[0].field, 'duration');
    assert.equal(p1.items[1].field, 'title');
    const p2 = getChanges(db, {}, 2, 2);
    assert.equal(p2.items.length, 1);
    assert.equal(p2.items[0].field, 'name');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getChanges: since/until 比对 changed_at', () => {
  const { db, dir } = setup();
  try {
    assert.equal(getChanges(db, { since: T + 100 }, 1, 20).total, 1); // 仅 T+150 duration
    assert.equal(getChanges(db, { until: T + 20 }, 1, 20).total, 1); // 仅 T+10 name
    assert.equal(getChanges(db, { since: T + 40, until: T + 100 }, 1, 20).total, 1); // T+50 title
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('aggregateStats: by creator / tname / lang / track-type + topN', () => {
  const { db, dir } = setup();
  try {
    const byCreator = aggregateStats(db, 'creator');
    assert.equal(byCreator.length, 2);
    assert.deepEqual(byCreator, [{ key: 'Alpha UP', count: 2 }, { key: 'Beta UP', count: 2 }]); // count 同则 key asc

    const byTname = aggregateStats(db, 'tname');
    assert.equal(byTname[0].key, '单机游戏');
    assert.equal(byTname[0].count, 2);
    assert.equal(byTname.length, 3); // 单机游戏/科技/生活

    const byLang = aggregateStats(db, 'lang');
    assert.equal(byLang.length, 2);
    assert.deepEqual(byLang, [{ key: 'en', count: 2 }, { key: 'zh-Hans', count: 2 }]); // count 同 → key asc: en < zh-Hans

    const byType = aggregateStats(db, 'track-type');
    assert.deepEqual(byType, [{ key: '1', count: 2 }, { key: '2', count: 2 }]); // V1 两类型各计一次（DISTINCT video_id）

    // topN 截断
    const top1 = aggregateStats(db, 'tname', {}, 1);
    assert.equal(top1.length, 1);
    assert.equal(top1[0].key, '单机游戏');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('aggregateStats: 带过滤（creator 维度 + has_subtitle）', () => {
  const { db, dir } = setup();
  try {
    // has_subtitle 过滤后 V4 排除：Alpha=2, Beta=1
    const r = aggregateStats(db, 'creator', { has_subtitle: true });
    assert.deepEqual(r, [{ key: 'Alpha UP', count: 2 }, { key: 'Beta UP', count: 1 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('countOverview: 总览计数 + 时间范围', () => {
  const { db, dir } = setup();
  try {
    const o = countOverview(db);
    assert.equal(o.videos, 4);
    assert.equal(o.tracks, 4); // V1:2 + V2:1 + V3:1 + V4:0
    assert.equal(o.versions, 4);
    assert.equal(o.creators, 2);
    assert.equal(o.languages, 2); // zh-Hans / en
    assert.equal(o.categories, 3); // 单机游戏 / 科技 / 生活
    assert.equal(o.first_seen_min, T + 100);
    assert.equal(o.first_seen_max, T + 400);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('countOverview: 空库返回 0 与 null', () => {
  const { db, dir } = freshDb();
  try {
    const o = countOverview(db);
    assert.equal(o.videos, 0);
    assert.equal(o.tracks, 0);
    assert.equal(o.versions, 0);
    assert.equal(o.creators, 0);
    assert.equal(o.languages, 0);
    assert.equal(o.categories, 0);
    assert.equal(o.first_seen_min, null);
    assert.equal(o.first_seen_max, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WAL 已启用：migrate 后 journal_mode = wal', () => {
  const { db, dir } = freshDb();
  try {
    const mode = db.pragma('journal_mode', { simple: true });
    assert.equal(mode, 'wal');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
