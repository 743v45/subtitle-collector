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

  // setup 走 ingestVideo 会留 field='created' 的 change_log（creator/video 首次入库，changed_at=Date.now()），
  // 其 ~2026 真实时间戳会污染下方 change_log 查询测试（since/until/排序/分页）。清掉，只留下方手工插的确定性 3 条。
  db.prepare("DELETE FROM change_log WHERE field='created'").run();

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

test('getVideoByDbId: 翻译轨(type=3) 排在原文 CC/ASR 之后（与 queries.getVideo 镜像一致）', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'yt1', title: '英文视频', creator: { source_uid: 'UC1', name: 'ch' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [
        { lan: 'zh-Hans', lan_doc: '中文(机翻)', track_type: 3, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://tt?tlang=zh-Hans' }] },
        { lan: 'en', lan_doc: 'English ASR', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://tt?lang=en' }] },
        { lan: 'en', lan_doc: 'English CC', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://tt?lang=en&cc' }] },
      ],
    });
    const vid = (db.prepare("SELECT id FROM videos WHERE source_vid = 'yt1'").get() as { id: number }).id;
    const d = getVideoByDbId(db, vid);
    if (!d) throw new Error('no detail');
    assert.deepEqual(d.tracks.map((t) => t.lan_doc), ['English CC', 'English ASR', '中文(机翻)'],
      '默认轨优先级：原文人工 CC > 原文 ASR > 翻译轨(type=3)');
    assert.equal((d.tracks[0] as { is_default?: boolean }).is_default, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideoByDbId: zh-manual 补翻轨排在原文 CC/ASR 之前、AI中文之后（与 queries.getVideo 镜像一致）', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'yt2', title: '补翻目标视频', creator: { source_uid: 'UC1', name: 'ch' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [
        { lan: 'en', lan_doc: 'English CC', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://cc' }] },
        { lan: 'zh', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://ai' }] },
        { lan: 'zh-manual', lan_doc: '中文（补翻）', track_type: undefined, versions: [{ origin: 'manual', payload: { body: [] }, source_url: 'translate://en' }] },
      ],
    });
    const vid = (db.prepare("SELECT id FROM videos WHERE source_vid = 'yt2'").get() as { id: number }).id;
    const d = getVideoByDbId(db, vid);
    if (!d) throw new Error('no detail');
    assert.deepEqual(d.tracks.map((t) => t.lan_doc), ['AI中文', '中文（补翻）', 'English CC'],
      'zh-manual 档位：AI中文(1) 之后、英文 CC(2) 之前——补翻后默认轨变中文');
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

// ── 平台维度（2026-08-24）：source 过滤经实体行判定 + items 带派生 source 列 ──
test('getChanges: source 平台过滤（经实体行 JOIN）+ items 派生 source 列', () => {
  const { db, dir } = setup();
  try {
    // 追加 YouTube 视频与 UP（ingest 产生 video/creator created 两条 change_log）
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'yt1', title: 'yt 视频', creator: { source_uid: 'UC9', name: 'yt频道' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [],
    });
    const base = getChanges(db, {}, 1, 20).total;
    // 平台过滤：youtube 只命中新 ingest 的两条 created；bilibili 不含它们
    const yt = getChanges(db, { source: 'youtube' }, 1, 20);
    assert.equal(yt.total, 2);
    assert.ok(yt.items.every((c) => c.source === 'youtube'), '派生 source 列随实体行带出');
    assert.deepEqual(yt.items.map((c) => c.entity).sort(), ['creator', 'video']);
    assert.equal(getChanges(db, { source: 'bilibili' }, 1, 20).total, base - 2);
    // 派生列在无平台过滤时同样带出（供展示层标平台）
    const all = getChanges(db, {}, 1, 50);
    assert.ok(all.items.some((c) => c.source === 'bilibili'));
    assert.ok(all.items.some((c) => c.source === 'youtube'));
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

// ---- 视频标签（四档）筛选与聚合 ----
// setup 样本的 bili tags：BV1=游戏/实况、BV2=数码、BV3=游戏、BV4=空。
// 下面再补关系档标签后验证 tags=/tag_source=/groupBy=tag。
import { applyVideoTags } from './tags.js';

test('tags 精确筛选：四档并查 + tag_source 分支 + AND 语义', () => {
  const { db, dir } = setup();
  try {
    // 给 BV1 打 manual 档「游戏」（与 bili 自带同名，多档并存）、BV2 打 ai 档「游戏」
    applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV1' }], ['游戏'], 'manual');
    applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV2' }], ['游戏'], 'ai');

    // tags=游戏 精确（四档并查）：BV1（bili+manual）+ BV2（ai）+ BV3（bili）→ 3 个
    let r = listVideosFiltered(db, { tags: ['游戏'] });
    assert.equal(r.total, 3);

    // tag_source=bili 只查 extra：BV1 + BV3 → 2 个
    r = listVideosFiltered(db, { tags: ['游戏'], tag_source: ['bili'] });
    assert.equal(r.total, 2);

    // tag_source=manual：只 BV1
    r = listVideosFiltered(db, { tags: ['游戏'], tag_source: ['manual'] });
    assert.equal(r.total, 1);
    assert.equal(r.items[0].source_vid, 'BV1');

    // tag_source=manual,ai（关系档两档）：BV1 + BV2
    r = listVideosFiltered(db, { tags: ['游戏'], tag_source: ['manual', 'ai'] });
    assert.equal(r.total, 2);

    // AND：tags=游戏,实况 → 只有 BV1 同时有两个
    r = listVideosFiltered(db, { tags: ['游戏', '实况'] });
    assert.equal(r.total, 1);
    assert.equal(r.items[0].source_vid, 'BV1');

    // 旧 tag= 模糊扩展为四档并查（超集兼容）：tag=游 命中 游戏（含 manual/bili 各视频）
    r = listVideosFiltered(db, { tag: '游' });
    assert.equal(r.total, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('aggregateStats groupBy=tag：四档并聚 + DISTINCT 去重 + tag_source 过滤 + 其他 filter 生效', () => {
  const { db, dir } = setup();
  try {
    applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV1' }], ['游戏'], 'manual');
    applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV2' }], ['游戏'], 'ai');

    // 全档聚合：游戏（BV1 bili + BV1 manual + BV2 ai + BV3 bili → DISTINCT 3 视频）、实况 1、数码 1
    let agg = aggregateStats(db, 'tag', {}, 20);
    const gameRow = agg.find((r) => r.key === '游戏')!;
    assert.equal(gameRow.count, 3); // 同名多档 DISTINCT 按 1 计
    assert.equal(agg.find((r) => r.key === '实况')!.count, 1);
    assert.equal(agg.find((r) => r.key === '数码')!.count, 1);

    // tag_source=bili 只聚 extra：游戏 = BV1+BV3 = 2
    agg = aggregateStats(db, 'tag', { tag_source: ['bili'] }, 20);
    assert.equal(agg.find((r) => r.key === '游戏')!.count, 2);

    // tag_source=manual 只聚关系档：游戏 = BV1 = 1
    agg = aggregateStats(db, 'tag', { tag_source: ['manual'] }, 20);
    assert.equal(agg.find((r) => r.key === '游戏')!.count, 1);

    // 其他 filter 生效（两分支都受 where 约束）：q=标题B → 只剩 BV2 的 ai 游戏
    agg = aggregateStats(db, 'tag', { q: '标题B' }, 20);
    assert.deepEqual(agg, [{ key: '数码', count: 1 }, { key: '游戏', count: 1 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- season 档（合集标签，只读实时读 extra.ugc_season.title）筛选与聚合 ----
function setupSeason(): { db: Database.Database; dir: string } {
  const { db, dir } = freshDb();
  const ingest = (sv: string, title: string, extra: Record<string, unknown>) =>
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: sv, title, creator: { source_uid: '9', name: 'Gamma UP' }, extra, duration: 100, published_at: T },
      tracks: [],
    });
  // SV1/SV2 同合集「AI前沿」；SV3 无合集；SV4 合集「AI前沿-2026」（前缀重叠防误匹配）
  ingest('SV1', '合集视频一', { ugc_season: { id: 1, title: 'AI前沿' } });
  ingest('SV2', '合集视频二', { ugc_season: { id: 1, title: 'AI前沿' } });
  ingest('SV3', '普通视频', {});
  ingest('SV4', '另一合集', { ugc_season: { id: 2, title: 'AI前沿-2026' } });
  return { db, dir };
}

test('season 档筛选：tags 精确 + tag=模糊 + tag_source=season 分支', () => {
  const { db, dir } = setupSeason();
  try {
    // tags=AI前沿 精确（五档并查，season 路命中）：SV1 + SV2
    let r = listVideosFiltered(db, { tags: ['AI前沿'] });
    assert.equal(r.total, 2);

    // tag_source=season：SV1 + SV2；精确名不含「AI前沿-2026」（SV4 不命中 = 精确匹配）
    r = listVideosFiltered(db, { tags: ['AI前沿'], tag_source: ['season'] });
    assert.equal(r.total, 2);

    // tag=AI前沿 模糊：命中 SV1/SV2/SV4（LIKE 前缀）
    r = listVideosFiltered(db, { tag: 'AI前沿' });
    assert.equal(r.total, 3);

    // tag_source=bili（不含 season）：合集名不命中（无 bili tags）→ 0
    r = listVideosFiltered(db, { tags: ['AI前沿'], tag_source: ['bili'] });
    assert.equal(r.total, 0);

    // AND：tags=AI前沿,不存在 → 0（season 命中一个但另一个全档无）
    r = listVideosFiltered(db, { tags: ['AI前沿', '不存在'] });
    assert.equal(r.total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('aggregateStats groupBy=tag：season 档并聚 + tag_source 过滤', () => {
  const { db, dir } = setupSeason();
  try {
    // 全档聚合：AI前沿=2、AI前沿-2026=1
    let agg = aggregateStats(db, 'tag', {}, 20);
    assert.equal(agg.find((r) => r.key === 'AI前沿')!.count, 2);
    assert.equal(agg.find((r) => r.key === 'AI前沿-2026')!.count, 1);

    // tag_source=season 只聚 season 分支
    agg = aggregateStats(db, 'tag', { tag_source: ['season'] }, 20);
    assert.deepEqual(agg, [{ key: 'AI前沿', count: 2 }, { key: 'AI前沿-2026', count: 1 }]);

    // tag_source=manual（关系档）：无 → 空聚合
    agg = aggregateStats(db, 'tag', { tag_source: ['manual'] }, 20);
    assert.deepEqual(agg, []);

    // 其他 filter 生效：q=合集视频一 → 只剩 SV1 的 season 标签
    agg = aggregateStats(db, 'tag', { q: '合集视频一' }, 20);
    assert.deepEqual(agg, [{ key: 'AI前沿', count: 1 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 表达式索引：tid 等值 / stat.view 范围过滤走索引而非全表扫 ──
// 索引表达式必须与 buildVideoWhere 里的查询表达式逐字一致（SQLite 表达式索引按表达式文本匹配；
// view 查询带 CAST 包裹，索引也得带 CAST，裸 json_extract 索引服务不了该查询）。
test('EXPLAIN QUERY PLAN：tid 等值过滤走 idx_videos_extra_tid（SEARCH 非 SCAN）', () => {
  const { db, dir } = freshDb();
  try {
    // 镜像 listVideosFiltered 的 FROM/WHERE 形状（buildVideoWhere 的 tid 分支）
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT v.id FROM videos v LEFT JOIN creators c ON c.id = v.creator_id
      WHERE json_extract(v.extra, '$.tid') = ?
    `).all(17) as Array<{ detail: string }>;
    assert.ok(plan.some((p) => /SEARCH v USING (COVERING )?INDEX idx_videos_extra_tid/.test(p.detail)),
      `tid 过滤应走表达式索引，实际计划：${plan.map((p) => p.detail).join(' | ')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('EXPLAIN QUERY PLAN：stat.view 范围过滤走 idx_videos_extra_view（SEARCH 非 SCAN）', () => {
  const { db, dir } = freshDb();
  try {
    // 镜像 buildVideoWhere 的 min_view 分支（CAST 包裹，与索引表达式一致）
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT v.id FROM videos v LEFT JOIN creators c ON c.id = v.creator_id
      WHERE CAST(json_extract(v.extra, '$.stat.view') AS INTEGER) >= ?
    `).all(1000) as Array<{ detail: string }>;
    assert.ok(plan.some((p) => /SEARCH v USING (COVERING )?INDEX idx_videos_extra_view/.test(p.detail)),
      `view 过滤应走表达式索引，实际计划：${plan.map((p) => p.detail).join(' | ')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 过滤洼地补齐：creator_id / creator_uid / subtitle_q / paid / min_view / max_view / 显式 false ──

test('listVideosFiltered: creator_id 精确（UP 详情页拉该 UP 视频）+ creator_uid 精确（子查询防 LIKE 误匹配）', () => {
  const { db, dir, ids } = setup();
  try {
    assert.deepEqual(titles(listVideosFiltered(db, { creator_id: ids.alpha }).items.sort()), ['标题A', '标题B']);
    assert.equal(listVideosFiltered(db, { creator_id: ids.beta }).total, 2);
    assert.equal(listVideosFiltered(db, { creator_id: 99999 }).total, 0);
    // creator_uid '1' 不误命中 '21' 式前缀（子查询 = 精确）
    assert.deepEqual(titles(listVideosFiltered(db, { creator_uid: '1' }).items.sort()), ['标题A', '标题B']);
    assert.deepEqual(titles(listVideosFiltered(db, { creator_uid: '2' }).items.sort()), ['标题C', '标题D']);
    assert.equal(listVideosFiltered(db, { creator_uid: '21' }).total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: subtitle_q 命中字幕正文（payload LIKE）', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'S1', title: '有正文的视频', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 10, published_at: 1 },
      tracks: [{ lan: 'zh-Hans', track_type: 2, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 1, content: '独特的正文关键词' }] }, source_url: 'https://a' }] }],
    });
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'S2', title: '别的视频', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 10, published_at: 1 },
      tracks: [{ lan: 'zh-Hans', track_type: 2, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 1, content: '别的话' }] }, source_url: 'https://b' }] }],
    });
    assert.deepEqual(listVideosFiltered(db, { subtitle_q: '正文关键词' }).items.map((i) => i.source_vid), ['S1']);
    assert.equal(listVideosFiltered(db, { subtitle_q: '不存在词' }).total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: paid=true 只命中付费视频；has_subtitle/paid 显式 false 等同未传', () => {
  const { db, dir } = setup();
  try {
    assert.equal(listVideosFiltered(db, { paid: true }).total, 0, 'setup 均未写 paid（列 0）→ 无命中');
    // 给 V1 置 paid=1（直接 UPDATE，绕开 ingest 的只升不降）
    db.prepare("UPDATE videos SET paid = 1 WHERE source_vid = 'BV1'").run();
    assert.deepEqual(listVideosFiltered(db, { paid: true }).items.map((i) => i.source_vid), ['BV1']);
    // 显式 false：与未传同效（不过滤）
    assert.equal(listVideosFiltered(db, { has_subtitle: false }).total, 4);
    assert.equal(listVideosFiltered(db, { paid: false }).total, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: min_view / max_view（extra.stat.view 范围，CAST INTEGER）', () => {
  const { db, dir } = setup();
  try {
    // view：V2=5000 > V1=1000 > V3=200 > V4=50
    assert.deepEqual(titles(listVideosFiltered(db, { min_view: 1000 }).items.sort()), ['标题A', '标题B']);
    assert.deepEqual(titles(listVideosFiltered(db, { max_view: 200 }).items.sort()), ['标题C', '标题D']);
    assert.deepEqual(titles(listVideosFiltered(db, { min_view: 200, max_view: 1000 }).items.sort()), ['标题A', '标题C']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: page/size 非正数回落默认（page=1, size=20）', () => {
  const { db, dir } = setup();
  try {
    const r = listVideosFiltered(db, { page: -1, size: 0 });
    assert.equal(r.page, 1);
    assert.equal(r.size, 20);
    assert.equal(r.total, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getChanges: page/size 非正数回落默认（p=1, s=20）', () => {
  const { db, dir } = setup();
  try {
    const r = getChanges(db, {}, 0, -5);
    assert.equal(r.page, 1);
    assert.equal(r.size, 20);
    assert.equal(r.total, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── tagMatchCond / aggregateStats 的 tag_source 边界 ──

test('tag_source 全非法（过滤后空）→ 视同五档全查（sources.length===0 兜底）', () => {
  const { db, dir } = setup();
  try {
    // ['xxx'] 非法 → filter 后空 → 兜底 push 全档 → 与省略 tag_source 同效（命中 BV1/BV3 的 bili 游戏）
    const r = listVideosFiltered(db, { tags: ['游戏'], tag_source: ['xxx'] });
    assert.equal(r.total, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('aggregateStats groupBy=tag：tag_source 全非法 → 三路分支全不拼 → 空结果', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(aggregateStats(db, 'tag', { tag_source: ['xxx'] }, 20), []);
    // 空数组同样走兜底全查（?.length 为 0 → falsy）
    const r = aggregateStats(db, 'tag', { tag_source: [] }, 20);
    assert.ok(r.some((row) => row.key === '游戏'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('aggregateStats groupBy=lang：lan 为 NULL 的轨归入 (unknown) 桶', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'N1', title: '无语言轨', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 10, published_at: 1 },
      tracks: [{ versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://n' }] }], // 无 lan/track_type
    });
    const r = aggregateStats(db, 'lang');
    assert.deepEqual(r, [{ key: '(unknown)', count: 1 }]);
    const byType = aggregateStats(db, 'track-type');
    assert.deepEqual(byType, [{ key: '(unknown)', count: 1 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── getVideoByDbId 排序镜像的剩余分支：en 无 type 轨优先级 2、manual origin 优先级 1 ──

test('getVideoByDbId: en 无 type 轨排最后（优先级 2 vs 其他 5）；同轨 manual 版本排在 asr 前', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'P1', title: '优先级分支', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 10, published_at: 1 },
      tracks: [
        { lan: 'fr', lan_doc: '法语', versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://fr' }] },
        { lan: 'en', lan_doc: '英文无type', versions: [
          { origin: 'asr', payload: { body: [] }, source_url: null, asr_engine: 'whisper' },
          { origin: 'manual', payload: { body: [] }, source_url: null },
        ] },
      ],
    });
    const vid = (db.prepare("SELECT id FROM videos WHERE source_vid = 'P1'").get() as { id: number }).id;
    const d = getVideoByDbId(db, vid);
    if (!d) throw new Error('no detail');
    // en 无 type（优先级 2）在 fr（其他 5）之前
    assert.deepEqual(d.tracks.map((t) => t.lan_doc), ['英文无type', '法语']);
    // 同轨版本序：external(0) < manual(1) < asr(2)
    assert.deepEqual(d.tracks[0].versions.map((v) => v.origin), ['manual', 'asr']);
    assert.equal((d.tracks[0].versions[0] as { is_default?: boolean }).is_default, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideoByDbId: zh AI(type=1) 优先级 1；同轨 external 版本最优先（镜像的 268/276 分支）', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'P2', title: '优先级分支二', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 10, published_at: 1 },
      tracks: [
        { lan: 'fr', lan_doc: '法语', versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://fr' }] },
        { lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [
          { origin: 'asr', payload: { body: [] }, source_url: null, asr_engine: 'whisper' },
          { origin: 'manual', payload: { body: [] }, source_url: null },
          { origin: 'external', payload: { body: [] }, source_url: 'https://zh' },
        ] },
      ],
    });
    const vid = (db.prepare("SELECT id FROM videos WHERE source_vid = 'P2'").get() as { id: number }).id;
    const d = getVideoByDbId(db, vid);
    if (!d) throw new Error('no detail');
    // zh AI（优先级 1）在 en/fr（2/5）之前
    assert.deepEqual(d.tracks.map((t) => t.lan_doc), ['AI中文', '法语']);
    // 同轨三版本齐：external(0) < manual(1) < asr(2)
    assert.deepEqual(d.tracks[0].versions.map((v) => v.origin), ['external', 'manual', 'asr']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideosFiltered: date_field=published_at → since/until 比对发布时间列', () => {
  const { db, dir } = setup();
  try {
    // published_at：V1(T+1000) V2(T+2000) V3(T+3000) V4(T+4000)
    assert.deepEqual(titles(listVideosFiltered(db, { since: T + 2500, date_field: 'published_at' }).items.sort()), ['标题C', '标题D']);
    assert.deepEqual(titles(listVideosFiltered(db, { until: T + 1500, date_field: 'published_at' }).items.sort()), ['标题A']);
    // 对照：默认 first_seen（V1=T+100..V4=T+400）下同阈值命中完全不同
    assert.deepEqual(listVideosFiltered(db, { since: T + 2500 }).items, [], 'first_seen 均小于阈值 → 空');
    assert.equal(listVideosFiltered(db, { until: T + 1500 }).total, 4, 'first_seen 均小于阈值 → 全量');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
