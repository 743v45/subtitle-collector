// stats.ts 纯处理函数单测：statsOverview + statsCount。
// 跑法（不在 pnpm test glob 内）：cd apps/collector-server && node --test --import tsx src/cli/commands/stats.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | statsOverview + statsCount（各维度/topN/过滤） | 通过 | 样本对齐 db/advanced.test.ts |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { statsOverview, statsCount } from './stats.js';

const T = 1_700_000_000_000; // 基准毫秒时间戳

// 样本库对齐 db/advanced.test.ts：2 UP（alpha/beta），4 视频（不同分区/语言/轨类型），V4 无轨。
function setup(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-stats-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);

  const ingest = (
    sv: string, title: string, uid: string, name: string,
    extra: Record<string, unknown>, dur: number,
    tracks: Array<{ lan?: string; lan_doc?: string; track_type?: number; versions: Array<{ origin: string; payload: unknown }> }>,
  ) =>
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: sv, title, creator: { source_uid: uid, name }, extra, duration: dur, published_at: T + 1000 },
      tracks,
    });

  ingest('BV1', '标题A', '1', 'Alpha UP', { tid: 17, tname: '单机游戏', tags: [{ tag_id: 1, tag_name: '游戏' }], stat: { view: 1000 } }, 600, [
    { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: { body: [] } }] },
    { lan: 'en', lan_doc: 'English', track_type: 1, versions: [{ origin: 'external', payload: { body: [] } }] },
  ]);
  ingest('BV2', '标题B', '1', 'Alpha UP', { tid: 122, tname: '科技', stat: { view: 5000 } }, 300, [
    { lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'external', payload: { body: [] } }] },
  ]);
  ingest('BV3', '标题C', '2', 'Beta UP', { tid: 17, tname: '单机游戏', stat: { view: 200 } }, 1200, [
    { lan: 'en', lan_doc: 'English CC', track_type: 2, versions: [{ origin: 'external', payload: { body: [] } }] },
  ]);
  ingest('BV4', '标题D', '2', 'Beta UP', { tid: 21, tname: '生活', stat: { view: 50 } }, 60, []);

  return { db, dir };
}

// ── statsOverview ──

test('statsOverview: 总览计数（视频/轨/版本/UP/语言/分区）', () => {
  const { db, dir } = setup();
  try {
    const o = statsOverview(db);
    assert.equal(o.videos, 4);
    assert.equal(o.tracks, 4);   // V1:2 + V2:1 + V3:1 + V4:0
    assert.equal(o.versions, 4);
    assert.equal(o.creators, 2);
    assert.equal(o.languages, 2);  // zh-Hans / en
    assert.equal(o.categories, 3); // 单机游戏 / 科技 / 生活
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('statsOverview: 空库返回 0 与 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-stats-empty-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  try {
    const o = statsOverview(db);
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

// ── statsCount ──

test('statsCount: by creator / tname / lang / track-type', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(statsCount(db, { by: 'creator' }), [{ key: 'Alpha UP', count: 2 }, { key: 'Beta UP', count: 2 }]);
    const byTname = statsCount(db, { by: 'tname' });
    assert.equal(byTname[0].key, '单机游戏');
    assert.equal(byTname[0].count, 2);
    assert.equal(byTname.length, 3); // 单机游戏 / 科技 / 生活
    assert.deepEqual(statsCount(db, { by: 'lang' }), [{ key: 'en', count: 2 }, { key: 'zh-Hans', count: 2 }]);
    assert.deepEqual(statsCount(db, { by: 'track-type' }), [{ key: '1', count: 2 }, { key: '2', count: 2 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('statsCount: topN 截断', () => {
  const { db, dir } = setup();
  try {
    const top1 = statsCount(db, { by: 'tname', topN: 1 });
    assert.equal(top1.length, 1);
    assert.equal(top1[0].key, '单机游戏');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('statsCount: 带过滤（has_subtitle 排除 V4）', () => {
  const { db, dir } = setup();
  try {
    // has_subtitle 过滤后 V4 排除：Alpha=2, Beta=1
    assert.deepEqual(
      statsCount(db, { by: 'creator', filter: { has_subtitle: true } }),
      [{ key: 'Alpha UP', count: 2 }, { key: 'Beta UP', count: 1 }],
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('statsCount: 默认 topN=20（不传 topN）', () => {
  const { db, dir } = setup();
  try {
    // 不传 topN → 默认 20，4 个视频不会触发截断
    const r = statsCount(db, { by: 'creator' });
    assert.equal(r.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
