// videos.ts 纯处理函数单测：临时文件 DB + ingestVideo 样本，断言结构化输出。
// 跑法（不在 pnpm test glob 内）：cd apps/collector-server && node --test --import tsx src/cli/commands/videos.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | normalizeTimestamp + videosList/get/getById 纯函数 | 通过 | 全部用临时 DB，无副作用 |
// | R2 | videosList paid 过滤（v.paid=1） | 通过 | 4 默认非付费 + 1 付费 ingest，--paid 仅命中付费 |
// | R3 | videosList tags 精确 AND + parseTagsCsv 空值归一 | 通过 | --tags 复数过滤 CLI 暴露（2026-09-22），样本标签 BV1=游戏+实况 |
// | R4 | videosList creator_id/creator_uid/tag_source/date_field 四参透传 + parseTagSource/parseDateField | 通过 | P1-6（cli-completeness #5 余量），HTTP filter.ts 已暴露同名参数对齐语义 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { videosList, videosGet, videosGetById, normalizeTimestamp, parseDesc, parseTagsCsv, parseTagSource, parseDateField } from './videos.js';

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

// ── videosList: tags 复数精确 AND 过滤（--tags CLI 暴露，DB 层 buildTagConds 既有能力）──
// 样本标签（extra.tags）：BV1=游戏+实况 / BV2=数码 / BV3=游戏 / BV4=无

test('videosList: tags 双标签精确 AND 命中，且可与 tag 模糊并存叠加', () => {
  const { db, dir } = setup();
  try {
    // 双标齐备的仅 BV1（BV3 只有游戏，缺实况被 AND 排除）
    assert.deepEqual(titles(videosList(db, { tags: ['游戏', '实况'] }).items), ['标题A']);
    assert.deepEqual(titles(videosList(db, { tags: ['实况'] }).items), ['标题A']);
    // --tag 模糊 + --tags 精确并存：DB 层叠加 AND（tag='游' 模糊圈 BV1/BV3，tags 精确收窄到 BV1）
    assert.deepEqual(titles(videosList(db, { tag: '游', tags: ['实况'] }).items), ['标题A']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosList: tags 含不存在的标签时结果为空（AND 无一满足）', () => {
  const { db, dir } = setup();
  try {
    assert.equal(videosList(db, { tags: ['游戏', '不存在的标签XYZ'] }).total, 0);
    assert.equal(videosList(db, { tags: ['不存在XYZ'] }).total, 0);
    // 精确语义对照：tags=['游'] 不命中「游戏」（--tag 模糊才命中，见上组）
    assert.equal(videosList(db, { tags: ['游'] }).total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseTagsCsv：undefined 透传；空串/全逗号/纯空白归一为 undefined（按未传处理）', () => {
  assert.equal(parseTagsCsv(undefined), undefined);
  assert.equal(parseTagsCsv(''), undefined);
  assert.equal(parseTagsCsv(',,,,'), undefined);
  assert.equal(parseTagsCsv(' , , '), undefined);
  assert.deepEqual(parseTagsCsv('游戏, 实况 ,'), ['游戏', '实况']); // 逐项 trim + 滤空
  // 空数组语义与 parseTagsCsv 归一一致：videosList 传空 tags 同未传（全量 4 条）
  const { db, dir } = setup();
  try {
    assert.equal(videosList(db, { tags: [] }).total, 4);
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
    // 分页走升序断言（CLI 缺省已改降序对齐 HTTP，这里显式 desc:false 锁定分页语义）
    const p1 = videosList(db, { sort: 'first_seen', desc: false, page: 1, size: 2 });
    assert.deepEqual(titles(p1.items), ['标题A', '标题B']);
    assert.equal(p1.total, 4);
    const p2 = videosList(db, { sort: 'first_seen', desc: false, page: 2, size: 2 });
    assert.deepEqual(titles(p2.items), ['标题C', '标题D']);
    const p3 = videosList(db, { sort: 'first_seen', desc: false, page: 3, size: 2 });
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

// ── videosList: subtitleQ 透传（字幕正文检索，对齐 HTTP subtitle_q）──

test('videosList: subtitleQ 透传，命中字幕正文 content 的视频', () => {
  const { db, dir } = setup();
  try {
    // 额外 ingest 一个带正文字幕的视频（setup 样本的 payload body 都是 []）
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV9', title: '通胀专题', creator: { source_uid: '9', name: '经济UP' }, extra: { stat: { view: 0 } }, duration: 100, published_at: T + 5000 },
      tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { body: [{ from: 0, to: 2, content: '今天聊通胀和CPI' }] } }] }],
    });
    // subtitleQ='通胀' 只命中 BV9（其余样本 payload 为空）
    assert.deepEqual(titles(videosList(db, { subtitleQ: '通胀' }).items), ['通胀专题']);
    // 不存在的词 → 0
    assert.equal(videosList(db, { subtitleQ: '不存在的词XYZ' }).total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── videosList: minView/maxView 播放量过滤（跨层一致：对齐 DB advanced / HTTP / sub search CLI）──
// setup 样本 view：BV1=1000 / BV2=5000 / BV3=200 / BV4=50

test('videosList: minView 下界过滤', () => {
  const { db, dir } = setup();
  try {
    // minView=1000 → BV1(1000) + BV2(5000)
    assert.deepEqual(titles(videosList(db, { minView: 1000 }).items).sort(), ['标题A', '标题B']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosList: maxView 上界过滤', () => {
  const { db, dir } = setup();
  try {
    // maxView=200 → BV3(200) + BV4(50)
    assert.deepEqual(titles(videosList(db, { maxView: 200 }).items).sort(), ['标题C', '标题D']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosList: minView+maxView 区间过滤', () => {
  const { db, dir } = setup();
  try {
    // minView=200, maxView=1000 → BV1(1000) + BV3(200)
    assert.deepEqual(titles(videosList(db, { minView: 200, maxView: 1000 }).items).sort(), ['标题A', '标题C']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── videosList: paid 过滤（独立列 v.paid = 1，对齐 DB advanced）──

test('videosList: paid 过滤仅返回付费视频', () => {
  const { db, dir } = setup();
  try {
    // setup 4 视频均无 paid 标志（列=0）；额外 ingest 一个付费视频
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV9', title: '付费专题', creator: { source_uid: '9', name: '经济UP' }, extra: { paid: true, stat: { view: 0 } }, duration: 100, published_at: T + 5000 },
      tracks: [],
    });
    assert.deepEqual(titles(videosList(db, { paid: true }).items), ['付费专题']);
    // 不过滤 paid → 全部 5 个
    assert.equal(videosList(db, {}).total, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 2026-08-25 全端点排序：parseDesc 纯函数（--desc [value] 解析；非法值分支见 cli 子进程测试）──
test('parseDesc：缺省 true（CLI 缺省降序）；裸 true / true/false/1/0/yes/no 字符串映射', () => {
  assert.equal(parseDesc(undefined), true, '缺省 → 降序（2026-08-25 起 CLI 缺省对齐 HTTP）');
  assert.equal(parseDesc(true), true, '裸 --desc → true');
  assert.equal(parseDesc('true'), true);
  assert.equal(parseDesc('1'), true);
  assert.equal(parseDesc('yes'), true);
  assert.equal(parseDesc('false'), false);
  assert.equal(parseDesc('0'), false);
  assert.equal(parseDesc('no'), false);
  assert.equal(parseDesc('TRUE'), true, '大小写不敏感');
});

// ── videosList: creator_id / creator_uid / tag_source / date_field 四参透传（P1-6，cli-completeness #5 余量）──
// db 层 advanced.ts VideoFilter 既有能力，CLI 纯包装；HTTP filter.ts 已暴露同名参数（creator_id/creator_uid/
// tag_source/date_field），此处对齐其语义。证据形态 = 结果集差异（参数生效于 SQL 的直接观察）。

test('videosList: creatorId 按 creators.id 精确过滤（结果集差异为证）', () => {
  const { db, dir } = setup();
  try {
    const creatorId = (db.prepare("SELECT creator_id FROM videos WHERE source_vid = 'BV1'").get() as { creator_id: number }).creator_id;
    // Alpha UP 名下 BV1/BV2 同一 creator_id，其余排除
    assert.deepEqual(titles(videosList(db, { creatorId }).items).sort(), ['标题A', '标题B']);
    // 不存在的 creator_id → 空集（参数确实进了 WHERE）
    assert.equal(videosList(db, { creatorId: 999999 }).total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosList: creatorUid 按 source_uid 精确命中，不误匹配其他 uid', () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(titles(videosList(db, { creatorUid: '1' }).items).sort(), ['标题A', '标题B']);
    assert.deepEqual(titles(videosList(db, { creatorUid: '2' }).items).sort(), ['标题C', '标题D']);
    // 不存在的 uid → 空集
    assert.equal(videosList(db, { creatorUid: 'no-such-uid' }).total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosList: tagSource 档位过滤（tag 匹配收窄 + 单独存在性）', () => {
  const { db, dir } = setup();
  try {
    // manual 档给 BV2 打「游戏」（样本 extra.tags 全是 bili 档，关系表原本为空）
    const tagId = (db.prepare("INSERT INTO tags (name, created_at) VALUES ('游戏', 1) RETURNING id").get() as { id: number }).id;
    const vid2 = (db.prepare("SELECT id FROM videos WHERE source_vid = 'BV2'").get() as { id: number }).id;
    db.prepare("INSERT INTO video_tags (video_id, tag_id, source, created_at) VALUES (?, ?, 'manual', 1)").run(vid2, tagId);
    // 缺省六档并查：bili 档 BV1/BV3 + manual 档 BV2
    assert.deepEqual(titles(videosList(db, { tag: '游戏' }).items).sort(), ['标题A', '标题B', '标题C']);
    // tagSource 收窄到 manual → 只 BV2；收窄到 bili → 只 BV1/BV3（同一 tag 名，档位切换结果集翻转）
    assert.deepEqual(titles(videosList(db, { tag: '游戏', tagSource: ['manual'] }).items), ['标题B']);
    assert.deepEqual(titles(videosList(db, { tag: '游戏', tagSource: ['bili'] }).items).sort(), ['标题A', '标题C']);
    // tagSource 单独存在性（不带 tag/tags）：manual 档只有 BV2 有标，system 档无人打标 → 0
    assert.deepEqual(titles(videosList(db, { tagSource: ['manual'] }).items), ['标题B']);
    assert.equal(videosList(db, { tagSource: ['system'] }).total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('videosList: dateField 切换 since/until 比对列（first_seen 缺省 vs published_at）', () => {
  const { db, dir } = setup();
  try {
    // 同一 since=T+1500：比对 first_seen（样本 T+100~T+400）→ 0 条；比对 published_at（T+1000~T+4000）→ 3 条
    assert.equal(videosList(db, { since: T + 1500 }).total, 0);
    assert.deepEqual(titles(videosList(db, { since: T + 1500, dateField: 'published_at' }).items).sort(), ['标题B', '标题C', '标题D']);
    // until 同理：T+2500 比 published_at → BV1/BV2
    assert.deepEqual(titles(videosList(db, { until: T + 2500, dateField: 'published_at' }).items).sort(), ['标题A', '标题B']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseTagSource：CSV 解析 trim 滤空；空串/全逗号归一 undefined；undefined 透传', () => {
  assert.equal(parseTagSource(undefined), undefined);
  assert.equal(parseTagSource(''), undefined);
  assert.equal(parseTagSource(' , , '), undefined);
  assert.deepEqual(parseTagSource('manual, bili ,'), ['manual', 'bili']);
  // 非法档位分支走 emitError（process.exit），在 CLI 子进程测试覆盖（对齐 parseSort 先例）
});

test('parseDateField：first_seen/published_at 放行；undefined 透传', () => {
  assert.equal(parseDateField(undefined), undefined);
  assert.equal(parseDateField('first_seen'), 'first_seen');
  assert.equal(parseDateField('published_at'), 'published_at');
  // 非法值分支走 emitError（process.exit），在 CLI 子进程测试覆盖
});
