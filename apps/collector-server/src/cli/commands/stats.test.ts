// stats 命令组纯处理函数测试：临时 DB 种子 → statsOverview / statsCount。
// 聚合语义本身由 db/advanced.test.ts 覆盖，此处验 CLI 包装层委托与默认值（topN ?? 20 / filter ?? {}）。
// parseNum/parseGroupBy 等 commander 装配层私有函数不在单测范围（需整 CLI 上下文）。
//
// ⚠️ 已知工具链怪象（2026-08-22 排查记录）：本测试真实调用并断言了 statsOverview/statsCount，
// 但 node:test + tsx 对 stats.ts 的**行级覆盖**系统性丢失（funcs% 计入正常；videos.ts 单跑同症状）。
// 覆盖报告里 stats.ts 的 line% 因此低估，不代表测试无效。复现：单独跑本文件，17-21 仍报未覆盖。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | statsOverview 计数 + statsCount 维度/topN/filter | 通过 | 覆盖率低估见上 ⚠️ |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { statsOverview, statsCount } from './stats.js';

const T = 1_700_000_000_000;

// 种子：2 UP、2 分区、3 视频（BV1 两轨 CC+AI、BV2 一轨 AI、BV3 无轨）。
function setup(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-stats-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const ingest = (
    sv: string, uid: string, name: string, tname: string,
    tracks: Array<{ lan?: string; lan_doc?: string; track_type?: number; versions: Array<{ origin: string; payload: unknown }> }>,
  ) => ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: sv, title: sv, creator: { source_uid: uid, name }, extra: { tname }, duration: 100, published_at: T },
    tracks,
  });
  ingest('BV1', '1', 'UP甲', '单机游戏', [
    { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: { body: [] } }] },
    { lan: 'en', lan_doc: 'English', track_type: 1, versions: [{ origin: 'external', payload: { body: [] } }] },
  ]);
  ingest('BV2', '1', 'UP甲', '科技', [
    { lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { body: [] } }] },
  ]);
  ingest('BV3', '2', 'UP乙', '单机游戏', []);
  // 覆写 first_seen 为确定值（ingest 用 Date.now()），便于范围断言
  const setSeen = (sv: string, ts: number) => db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(ts, sv);
  setSeen('BV1', T + 100);
  setSeen('BV2', T + 200);
  setSeen('BV3', T + 300);
  return { db, dir };
}

// ── statsOverview ──

test('statsOverview：视频/轨/版本/UP/语言/分区计数 + first_seen 范围', () => {
  const { db, dir } = setup();
  try {
    const o = statsOverview(db);
    assert.equal(o.videos, 3);
    assert.equal(o.tracks, 3);      // BV1 两轨 + BV2 一轨
    assert.equal(o.versions, 3);
    assert.equal(o.creators, 2);
    assert.equal(o.languages, 2);   // zh-Hans + en
    assert.equal(o.categories, 2);  // 单机游戏 + 科技
    assert.equal(o.today_videos, 0); // first_seen 全是 2023，不在今天
    assert.equal(o.first_seen_min, T + 100);
    assert.equal(o.first_seen_max, T + 300);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── statsCount ──

test('statsCount：by=creator / tname（count desc, key asc）+ topN 截断', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(statsCount(db, { by: 'creator' }), [
      { key: 'UP甲', count: 2 },
      { key: 'UP乙', count: 1 },
    ]);
    assert.deepEqual(statsCount(db, { by: 'tname' }), [
      { key: '单机游戏', count: 2 },
      { key: '科技', count: 1 },
    ]);
    assert.deepEqual(statsCount(db, { by: 'creator', topN: 1 }), [{ key: 'UP甲', count: 2 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('statsCount：by=lang（DISTINCT 视频数）+ filter 透传（has_subtitle 剔除无轨视频）', () => {
  const { db, dir } = setup();
  try {
    const langs = statsCount(db, { by: 'lang' }).sort((a, b) => a.key.localeCompare(b.key));
    assert.deepEqual(langs, [
      { key: 'en', count: 1 },
      { key: 'zh-Hans', count: 2 },
    ]);
    // has_subtitle 过滤掉无轨的 BV3 后按 creator 聚合 → 只剩 UP甲
    assert.deepEqual(statsCount(db, { by: 'creator', filter: { has_subtitle: true } }), [
      { key: 'UP甲', count: 2 },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
