// videos.ts 纯处理函数单测：临时文件 DB + ingestVideo 样本，断言结构化输出。
// 跑法（不在 pnpm test glob 内）：cd apps/collector-server && node --test --import tsx src/cli/commands/videos.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | normalizeTimestamp + videosList/get/getById 纯函数 | 通过 | 全部用临时 DB，无副作用 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { videosList, videosGet, videosGetById, normalizeTimestamp } from './videos.js';

const T = 1_700_000_000_000; // 基准毫秒时间戳（2023-11-14T22:13:20.000Z）

// 构造样本库：2 UP（alpha/beta），4 视频（不同分区/标签/语言/轨类型/时长/view）。
// 数据形状对齐 db/advanced.test.ts，便于断言。
function setup(): { db: Database.Database; dir: string; ids: Record<string, number> } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-videos-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);

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

  // ingest 用 Date.now() 写 first_seen_at，覆写为确定值便于断言排序/时间过滤
  const setSeen = (sv: string, ts: number) => db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(ts, sv);
  setSeen('BV1', T + 100);
  setSeen('BV2', T + 200);
  setSeen('BV3', T + 300);
  setSeen('BV4', T + 400);

  const idOf = (sv: string) => (db.prepare('SELECT id FROM videos WHERE source_vid = ?').get(sv) as { id: number }).id;
  const ids = { v1: idOf('BV1'), v2: idOf('BV2'), v3: idOf('BV3'), v4: idOf('BV4') };
  return { db, dir, ids };
}

const titles = (items: Array<{ title: string }>) => items.map((i) => i.title);

// ── normalizeTimestamp ──

test('normalizeTimestamp: 数字秒/毫秒启发式', () => {
  assert.equal(normalizeTimestamp(1_700_000_000), 1_700_000_000_000);     // 秒 → ×1000
  assert.equal(normalizeTimestamp(1_700_000_000_000), 1_700_000_000_000); // 毫秒不变
  assert.equal(normalizeTimestamp(999_999_999_999), 999_999_999_999_000); // < 1e12 视为秒
  assert.equal(normalizeTimestamp(1e12), 1e12);                           // = 1e12 视为毫秒（不 < 1e12）
});

test('normalizeTimestamp: 字符串纯数字同启发式 + 容忍空白', () => {
  assert.equal(normalizeTimestamp('1700000000'), 1_700_000_000_000);
  assert.equal(normalizeTimestamp('1700000000000'), 1_700_000_000_000);
  assert.equal(normalizeTimestamp('  1700000000  '), 1_700_000_000_000);
});

test('normalizeTimestamp: ISO8601 走 Date.parse', () => {
  assert.equal(normalizeTimestamp('2023-11-14T22:13:20.000Z'), T);
  assert.equal(normalizeTimestamp('2023-11-14T22:13:20.250Z'), T + 250);
});

test('normalizeTimestamp: 非法输入抛错', () => {
  assert.throws(() => normalizeTimestamp('not-a-date'));
  assert.throws(() => normalizeTimestamp(''));
});

// ── videosList ──

test('videosList: 默认返回 {total,page,size,items}，page=1 size=20', () => {
  const { db, dir } = setup();
  try {
    const r = videosList(db, {});
    assert.equal(r.total, 4);
    assert.equal(r.page, 1);
    assert.equal(r.size, 20);
    assert.equal(r.items.length, 4);
    assert.deepEqual(titles(r.items).sort(), ['标题A', '标题B', '标题C', '标题D']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosList: camelCase opts 映射 snake_case filter（trackType/hasSubtitle/minDuration/maxDuration）', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(titles(videosList(db, { trackType: 2 }).items).sort(), ['标题A', '标题C']); // CC
    assert.deepEqual(titles(videosList(db, { trackType: 1 }).items).sort(), ['标题A', '标题B']); // AI
    assert.deepEqual(titles(videosList(db, { hasSubtitle: true }).items).sort(), ['标题A', '标题B', '标题C']); // V4 无轨排除
    assert.deepEqual(titles(videosList(db, { minDuration: 500 }).items).sort(), ['标题A', '标题C']);
    assert.deepEqual(titles(videosList(db, { maxDuration: 300 }).items).sort(), ['标题B', '标题D']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosList: 文本/UP/source/tid/tname/tag/lang 过滤透传', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(titles(videosList(db, { q: 'Alpha' }).items).sort(), ['标题A', '标题B']); // 命中 creator 名
    assert.deepEqual(titles(videosList(db, { creator: 'Beta' }).items).sort(), ['标题C', '标题D']);
    assert.equal(videosList(db, { source: 'other' }).total, 0);
    assert.deepEqual(titles(videosList(db, { tid: 17 }).items).sort(), ['标题A', '标题C']);
    assert.deepEqual(titles(videosList(db, { tag: '游戏' }).items).sort(), ['标题A', '标题C']);
    assert.deepEqual(titles(videosList(db, { lang: 'zh' }).items).sort(), ['标题A', '标题B']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosList: since/until 比对 first_seen_at（毫秒）', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(titles(videosList(db, { since: T + 250 }).items).sort(), ['标题C', '标题D']);
    assert.deepEqual(titles(videosList(db, { until: T + 150 }).items).sort(), ['标题A']);
    assert.deepEqual(titles(videosList(db, { since: T + 150, until: T + 300 }).items).sort(), ['标题B', '标题C']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosList: sort + desc + 分页', () => {
  const { db, dir } = setup();
  try {
    // view desc：V2(5000) > V1(1000) > V3(200) > V4(50)
    assert.deepEqual(titles(videosList(db, { sort: 'view', desc: true }).items), ['标题B', '标题A', '标题C', '标题D']);
    const p1 = videosList(db, { sort: 'first_seen', page: 1, size: 2 });
    assert.deepEqual(titles(p1.items), ['标题A', '标题B']);
    assert.equal(p1.total, 4);
    const p2 = videosList(db, { sort: 'first_seen', page: 2, size: 2 });
    assert.deepEqual(titles(p2.items), ['标题C', '标题D']);
    const p3 = videosList(db, { sort: 'first_seen', page: 3, size: 2 });
    assert.deepEqual(p3.items, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── videosGet / videosGetById ──

test('videosGet: 按 source + source_vid 取详情；不存在返回 null', () => {
  const { db, dir, ids } = setup();
  try {
    const d = videosGet(db, 'bilibili', 'BV1');
    if (!d) throw new Error('expected detail');
    assert.equal(d.video.source_vid, 'BV1');
    assert.equal(d.tracks.length, 2);
    assert.equal((d.tracks[0] as { is_default?: boolean }).is_default, true);
    assert.equal(videosGet(db, 'bilibili', 'NOPE'), null);
    assert.ok(ids.v1 > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosGetById: 按 db id 取详情；不存在返回 null', () => {
  const { db, dir, ids } = setup();
  try {
    const d = videosGetById(db, ids.v1);
    if (!d) throw new Error('expected detail');
    assert.equal(d.video.source_vid, 'BV1');
    assert.equal(videosGetById(db, 99999), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
