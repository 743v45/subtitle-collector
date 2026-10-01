// stats 命令组纯处理函数测试：临时 DB 种子 → statsOverview / statsCount。
// 聚合语义本身由 db/advanced.test.ts 覆盖，此处验 CLI 包装层委托与默认值（topN ?? 20 / filter ?? {}）。
// parseNum 等 commander 装配层私有函数不在单测范围（需整 CLI 上下文）；--by 白名单例外——
// 经 buildStatsCommand 进程内装配直测（R3 起，先例 output.test.ts 的 captureExit 哨兵）。
//
// ⚠️ 已知工具链怪象（2026-08-22 排查记录）：本测试真实调用并断言了 statsOverview/statsCount，
// 但 node:test + tsx 对 stats.ts 的**行级覆盖**系统性丢失（funcs% 计入正常；videos.ts 单跑同症状）。
// 覆盖报告里 stats.ts 的 line% 因此低估，不代表测试无效。复现：单独跑本文件，17-21 仍报未覆盖。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | statsOverview 计数 + statsCount 维度/topN/filter | 通过 | 覆盖率低估见上 ⚠️ |
// | R2 | statsCount filter.tags 双标签精确 AND | 通过 | --tags CLI 暴露（2026-09-22），VideoFilter.tags 直透 |
// | R3 | --by tag 白名单：纯函数共现分布 + buildStatsCommand 装配放行/拒绝（失败→通过） | 通过 | CLI 白名单补 'tag'（2026-10-02 消费闭环第 6 项） |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { statsOverview, statsCount, buildStatsCommand } from './stats.js';
import { setCliContext } from '../context.js';

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

test('statsOverview：全库总 + 分平台 by_source（轨/版本/语言经视频溯源平台）', () => {
  const { db, dir } = setup();
  try {
    // 追加一条 YouTube 视频（1 轨英文 CC），补双平台种子；first_seen 覆写为确定值（ingest 用 Date.now()）
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'ytvid00001', title: 'yt', creator: { source_uid: 'UCyt', name: 'YT频道' }, extra: {}, duration: 100, published_at: T },
      tracks: [{ lan: 'en', lan_doc: 'English', track_type: 2, versions: [{ origin: 'external', payload: { body: [] } }] }],
    });
    db.prepare("UPDATE videos SET first_seen_at = ? WHERE source = 'youtube' AND source_vid = 'ytvid00001'").run(T + 400);
    const o = statsOverview(db);
    // 全库总：原 3 视频 3 轨 + YT 1 视频 1 轨
    assert.equal(o.total.videos, 4);
    assert.equal(o.total.tracks, 4);
    assert.equal(o.total.versions, 4);
    assert.equal(o.total.creators, 3);   // UP甲/UP乙/YT频道
    assert.equal(o.total.languages, 2);  // zh-Hans + en
    assert.equal(o.total.categories, 2); // 单机游戏 + 科技（YT 无 tname）
    assert.equal(o.total.today_videos, 0);
    assert.equal(o.total.first_seen_min, T + 100);
    assert.equal(o.total.first_seen_max, T + 400);
    // 分平台：by_source 键 = 库内 DISTINCT source
    assert.deepEqual(Object.keys(o.by_source).sort(), ['bilibili', 'youtube']);
    const bili = o.by_source.bilibili!;
    assert.equal(bili.videos, 3);
    assert.equal(bili.tracks, 3);
    assert.equal(bili.versions, 3);
    assert.equal(bili.creators, 2);
    assert.equal(bili.languages, 2);   // zh-Hans + en 都在 B 站视频上
    assert.equal(bili.categories, 2);
    assert.deepEqual([bili.first_seen_min, bili.first_seen_max], [T + 100, T + 300]); // 平台内范围独立
    const yt = o.by_source.youtube!;
    assert.equal(yt.videos, 1);
    assert.equal(yt.tracks, 1);
    assert.equal(yt.versions, 1);
    assert.equal(yt.creators, 1);
    assert.equal(yt.languages, 1);     // 只有 en
    assert.equal(yt.categories, 0);    // YouTube 无 tname
    assert.deepEqual([yt.first_seen_min, yt.first_seen_max], [T + 400, T + 400]);
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

// by=source（2026-08-24）：按平台分组计数，可与 source 过滤组合
test('statsCount：by=source 按平台分组（含 --source 过滤收窄）', () => {
  const { db, dir } = setup();
  try {
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'ytvid00001', title: 'yt', creator: { source_uid: 'UCyt', name: 'YT频道' }, extra: {}, duration: 100, published_at: T },
      tracks: [],
    });
    assert.deepEqual(statsCount(db, { by: 'source' }), [
      { key: 'bilibili', count: 3 },
      { key: 'youtube', count: 1 },
    ]);
    // source 过滤 + source 分组组合（收窄后只含该平台）
    assert.deepEqual(statsCount(db, { by: 'source', filter: { source: 'youtube' } }), [
      { key: 'youtube', count: 1 },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// filter.tags 复数精确 AND（2026-09-22 stats count --tags 暴露；setup 种子无标签，测试内补带标签样本）
test('statsCount：filter.tags 双标签精确 AND（含不存在标签归零）', () => {
  const { db, dir } = setup();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: 'BV9', title: 'BV9', creator: { source_uid: '1', name: 'UP甲' },
        extra: { tags: [{ tag_id: 1, tag_name: '游戏' }, { tag_id: 2, tag_name: '实况' }] }, duration: 100, published_at: T,
      },
      tracks: [],
    });
    // 双标齐备仅 BV9（UP甲 其余视频无标签被 AND 排除）
    assert.deepEqual(statsCount(db, { by: 'creator', filter: { tags: ['游戏', '实况'] } }), [
      { key: 'UP甲', count: 1 },
    ]);
    // 任一标签不存在 → AND 落空 → 空结果
    assert.deepEqual(statsCount(db, { by: 'creator', filter: { tags: ['游戏', '不存在XYZ'] } }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// by=tag（2026-10-02 CLI 白名单补 'tag'，消费闭环第 6 项）：六档并聚的标签共现分布（带标视频数计，
// db 层语义见 aggregate-tag.ts）。纯函数层此前即透传支持，真正缺口在装配白名单（见下方 buildStatsCommand 用例）。
test('statsCount：by=tag 标签共现分布（六档并聚按视频去重）+ filter.tags AND 组合收窄', () => {
  const { db, dir } = setup();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: 'BV9', title: 'BV9', creator: { source_uid: '1', name: 'UP甲' },
        extra: { tags: [{ tag_id: 1, tag_name: '游戏' }, { tag_id: 2, tag_name: '实况' }] }, duration: 100, published_at: T,
      },
      tracks: [],
    });
    ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: 'BV8', title: 'BV8', creator: { source_uid: '2', name: 'UP乙' },
        extra: { tags: [{ tag_id: 3, tag_name: '游戏' }] }, duration: 100, published_at: T,
      },
      tracks: [],
    });
    // 游戏 2 视频（BV9+BV8）、实况 1（BV9）；count desc 无并列
    assert.deepEqual(statsCount(db, { by: 'tag' }), [
      { key: '游戏', count: 2 },
      { key: '实况', count: 1 },
    ]);
    // AND 圈定子集（仅 BV9）后按标签再聚 → 子集内共现分布；同数并列，两侧同用默认序免排序口径
    const narrowed = statsCount(db, { by: 'tag', filter: { tags: ['实况'] } });
    assert.deepEqual(
      narrowed.map((r) => [r.key, r.count]).sort(),
      [['游戏', 1], ['实况', 1]].sort(),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── buildStatsCommand 装配层（--by 白名单 STATS_GROUP_BY 的回归落点）──

// 异步 capture：parseAsync 的 action 链内 emitResult/emitError 落 stdout/stderr；emitError 的
// process.exit 换成哨兵抛出（同步版见 main.test.ts captureExit，此处 await 异步版）。
async function captureParse(args: string[]): Promise<{ out: string; err: string; codes: number[] }> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exit;
  let out = '';
  let err = '';
  const codes: number[] = [];
  const EXIT_SENTINEL = Symbol('cli-exit');
  process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err += String(chunk); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { codes.push(code ?? 0); throw EXIT_SENTINEL; }) as typeof process.exit;
  try {
    await buildStatsCommand().parseAsync(['node', 'collector-cli', ...args]);
  } catch (e) {
    if (e !== EXIT_SENTINEL) throw e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return { out, err, codes };
}

// --by tag 失败→通过（2026-10-02 白名单补 'tag'）：补前 parseGroupBy 拒绝 → ARGS 退 2；补后放行出共现分布。
// 种子（setup 无标签，装配用例自带）：BV9 双标（游戏+实况，bili extra 档）+ BV8 单标（游戏）。
function setupTagged(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-stats-tag-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  for (const [sv, uid, name, tags] of [
    ['BV9', '1', 'UP甲', [{ tag_id: 1, tag_name: '游戏' }, { tag_id: 2, tag_name: '实况' }]],
    ['BV8', '2', 'UP乙', [{ tag_id: 3, tag_name: '游戏' }]],
  ] as const) {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: sv, title: sv, creator: { source_uid: uid, name }, extra: { tags }, duration: 100, published_at: T },
      tracks: [],
    });
  }
  return { db, dir };
}

test('buildStatsCommand：stats count --by tag 白名单放行出标签共现分布（补前 非法 --by 退 2 的回归）', async () => {
  const { db, dir } = setupTagged();
  try {
    db.close(); // action 走 openReadonlyDb 另开只读连接，先放掉写连接
    setCliContext({ format: 'json', dbPath: join(dir, 'test.db'), serverUrl: 'http://127.0.0.1:1', token: 't', quiet: true, serverExplicit: false });
    const { out, codes } = await captureParse(['count', '--by', 'tag']);
    assert.deepEqual(codes, []); // 成功路径不 process.exit
    assert.deepEqual(JSON.parse(out), [
      { key: '游戏', count: 2 },
      { key: '实况', count: 1 },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --tags AND 圈定子集后再按标签聚合（消费闭环验收式：stats count --by tag --tags <csv> 出子集共现分布）
test('buildStatsCommand：--by tag --tags AND 圈定子集的共现分布（仅含命中视频上的标签）', async () => {
  const { db, dir } = setupTagged();
  try {
    db.close();
    setCliContext({ format: 'json', dbPath: join(dir, 'test.db'), serverUrl: 'http://127.0.0.1:1', token: 't', quiet: true, serverExplicit: false });
    const { out, codes } = await captureParse(['count', '--by', 'tag', '--tags', '实况']);
    assert.deepEqual(codes, []);
    // 子集 = 仅 BV9（BV8 无实况被 AND 排除）→ 其双标各 1；同数并列，两侧同用默认序免排序口径
    const rows = JSON.parse(out) as Array<{ key: string; count: number }>;
    assert.deepEqual(
      rows.map((r) => [r.key, r.count]).sort(),
      [['游戏', 1], ['实况', 1]].sort(),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 白名单拒绝路径仍在：--by 非法值 → ARGS 退 2（对齐 HTTP 400 口径）
test('buildStatsCommand：stats count --by 非法值 → ARGS 退 2（白名单拒绝路径）', async () => {
  const { db, dir } = setupTagged();
  try {
    db.close();
    setCliContext({ format: 'json', dbPath: join(dir, 'test.db'), serverUrl: 'http://127.0.0.1:1', token: 't', quiet: true, serverExplicit: false });
    const { out, err, codes } = await captureParse(['count', '--by', 'bogus']);
    assert.deepEqual(codes, [2]);
    assert.equal(JSON.parse(out).code, 'ARGS');
    assert.match(err, /非法 --by/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
