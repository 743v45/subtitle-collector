// sub.ts 纯处理函数单测：matchBody / extractSnippets / searchSubtitles。
// matchBody/extractSnippets 无 IO 直接断言；searchSubtitles 注入 mock PayloadSource + 临时 DB。
// 跑法：cd apps/collector-server && node --test --import tsx src/cli/commands/sub.test.ts
//
// 测试轮次记录表（对齐全局 CLAUDE.md §8.2 + 项目 CLAUDE.md §3）：
// | 轮次 | 日期 | 范围 | 结果 | 备注 |
// |---|---|---|---|---|
// | R3 | （待填） | matchBody / extractSnippets 纯函数 | ⏳ | |
// | R4 | （待填） | searchSubtitles 编排 + mock PayloadSource | ⏳ | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { matchBody, extractSnippets, searchSubtitles, makeDbPayloadSource, type PayloadSource } from './sub.js';

// ── matchBody ──

test('matchBody: 子串默认大小写不敏感', () => {
  const body = [
    { from: 0, to: 1, content: '今天 CPI 同比上涨' },
    { from: 1, to: 2, content: '天气不错' },
  ];
  assert.deepEqual(matchBody(body, 'cpi'), [0]);   // 小写 keyword 命中大写 CPI
  assert.deepEqual(matchBody(body, 'CPI'), [0]);
  assert.deepEqual(matchBody(body, '天气'), [1]);
  assert.deepEqual(matchBody(body, '不存在'), []);
});

test('matchBody: --case-sensitive 区分大小写', () => {
  const bodyLower = [{ from: 0, to: 1, content: 'cpi' }];
  assert.deepEqual(matchBody(bodyLower, 'CPI', { caseSensitive: true }), []);  // 大写不命中纯小写
  assert.deepEqual(matchBody(bodyLower, 'CPI'), [0]);                          // 默认不敏感命中
  const bodyMixed = [{ from: 0, to: 1, content: 'CPI 与 cpi 的区别' }];
  assert.deepEqual(matchBody(bodyMixed, 'CPI', { caseSensitive: true }), [0]);
});

test('matchBody: --regex 正则匹配多段', () => {
  const body = [
    { from: 0, to: 1, content: '通胀压力' },
    { from: 1, to: 2, content: 'CPI 上涨' },
    { from: 2, to: 3, content: 'GDP 下行' },
  ];
  assert.deepEqual(matchBody(body, '通胀|CPI', { regex: true }), [0, 1]);
  assert.deepEqual(matchBody(body, 'G.P', { regex: true }), [2]);  // GDP 命中 G.P
});

test('matchBody: 非法正则抛错（供 action 层转 ARGS）', () => {
  assert.throws(() => matchBody([], '(', { regex: true }), /非法正则/);
  assert.throws(() => matchBody([], '[', { regex: true }), /非法正则/);
});

test('matchBody: 空 body → 空命中', () => {
  assert.deepEqual(matchBody([], 'x'), []);
});

// ── extractSnippets ──

test('extractSnippets: ±ctxSec 上下文窗口贪心吞并邻段', () => {
  const body = [
    { from: 0, to: 2, content: 'A' },
    { from: 3, to: 5, content: 'B' },     // 命中：与前后时间差 1s
    { from: 6, to: 8, content: 'C' },
    { from: 100, to: 101, content: 'D' }, // 远离（差 95s）不吞
  ];
  const out = extractSnippets(body, [1], 10, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'B');
  assert.equal(out[0].from, 3);
  assert.equal(out[0].to, 5);
  // 向前吞 A（3-2=1<=10）；向后吞 C（6-5=1<=10）；D 不吞（100-5=95>10）
  assert.deepEqual(out[0].context, '[0-2] A [3-5] B [6-8] C');
});

test('extractSnippets: 边界——首段命中向后吞，末段命中向前吞', () => {
  const body = [
    { from: 0, to: 1, content: 'X' },
    { from: 2, to: 3, content: 'Y' },
  ];
  const head = extractSnippets(body, [0], 10, {});
  assert.deepEqual(head[0].context, '[0-1] X [2-3] Y'); // 首段向后吞 Y
  const tail = extractSnippets(body, [1], 10, {});
  assert.deepEqual(tail[0].context, '[0-1] X [2-3] Y'); // 末段向前吞 X
});

test('extractSnippets: ctxSec=0 只留命中段本身', () => {
  const body = [
    { from: 0, to: 1, content: 'X' },
    { from: 2, to: 3, content: 'Y' },
    { from: 4, to: 5, content: 'Z' },
  ];
  const out = extractSnippets(body, [1], 0, {});
  assert.deepEqual(out[0].context, '[2-3] Y');
});

test('extractSnippets: --plain 去时间戳前缀只留纯文本', () => {
  const body = [
    { from: 0, to: 1, content: 'X' },
    { from: 2, to: 3, content: 'Y' },
  ];
  const out = extractSnippets(body, [0], 10, { plain: true });
  assert.deepEqual(out[0].context, 'XY');
});

test('extractSnippets: maxPerVideo 截断（按命中顺序取前 N）', () => {
  const body = [0, 1, 2, 3, 4].map((i) => ({ from: i * 100, to: i * 100 + 1, content: `hit${i}` }));
  const out = extractSnippets(body, [0, 1, 2, 3, 4], 0, { maxPerVideo: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.content), ['hit0', 'hit1']);
});

test('extractSnippets: 多命中点各自独立产出片段', () => {
  const body = [
    { from: 0, to: 1, content: 'A' },
    { from: 100, to: 101, content: 'B' },  // 命中（远离 A）
    { from: 200, to: 201, content: 'A' },  // 命中（远离 B）
  ];
  const out = extractSnippets(body, [1, 2], 10, {});
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'B');
  assert.equal(out[1].content, 'A');
});

// ── searchSubtitles（注入 mock PayloadSource + 临时 DB）──
const T2 = 1_700_000_000_000;
function setupSub(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-sub-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '通胀解读', creator: { source_uid: '1', name: 'UP1' }, extra: { stat: { view: 100 } }, duration: 200, published_at: T2 + 1000 },
    tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { body: [
      { from: 0, to: 2, content: '开场白' },
      { from: 3, to: 5, content: '今天聊通胀成因' },
      { from: 100, to: 101, content: '通胀的对策' },
    ] } }] }],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV2', title: '天气播报', creator: { source_uid: '2', name: 'UP2' }, extra: { stat: { view: 50 } }, duration: 60, published_at: T2 + 2000 },
    tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { body: [
      { from: 0, to: 2, content: '今天天气晴朗' },
    ] } }] }],
  });
  db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(T2 + 100, 'BV1');
  db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(T2 + 200, 'BV2');
  return { db, dir };
}

test('searchSubtitles: 子串模式命中 + 片段时间戳 + matched_videos/total_snippets', () => {
  const { db, dir } = setupSub();
  try {
    const src = makeDbPayloadSource(db);
    const out = searchSubtitles(db, src, { keyword: '通胀' });
    assert.equal(out.keyword, '通胀');
    assert.equal(out.regex, false);
    assert.equal(out.matched_videos, 1);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].video.source_vid, 'BV1');
    assert.equal(out.items[0].video.title, '通胀解读');
    assert.equal('pic' in out.items[0].video, false);  // 强制不含 pic（媒体字段剔除）
    assert.equal(out.items[0].snippets.length, 2);
    assert.ok(out.items[0].snippets[0].context.includes('通胀'));
    assert.ok(out.total_snippets >= 1);
    assert.equal(out.truncated, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: F9a 子串模式 LIKE 预筛 ⊇ JS 精确（LIKE 噪声被 JS 滤掉，不漏召回）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-sub-noise-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVn', title: '噪声视频', creator: { source_uid: '9', name: 'UP9' }, extra: {}, duration: 200, published_at: T2 },
      tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { body: [
        { from: 137, to: 138, content: '这段内容完全不含数字关键词' },
      ] } }] }],
    });
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '137' });
    assert.equal(out.matched_videos, 0);
    assert.deepEqual(out.items, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: F9b 正则模式不加 LIKE 预筛（否则元字符致漏召回）', () => {
  const { db, dir } = setupSub();
  try {
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀|对策', regex: true });
    assert.equal(out.matched_videos, 1);
    assert.equal(out.items[0].video.source_vid, 'BV1');
    assert.ok(out.items[0].snippets.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: --max-snippets 全局截断 + truncated=true', () => {
  const { db, dir } = setupSub();
  try {
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀', maxSnippets: 1 });
    assert.equal(out.total_snippets, 1);
    assert.equal(out.truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: --max-snippets-per-video 单视频截断', () => {
  const { db, dir } = setupSub();
  try {
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀', maxSnippetsPerVideo: 1 });
    assert.equal(out.items[0].snippets.length, 1);
    assert.equal(out.total_snippets, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: --plain 片段去时间戳', () => {
  const { db, dir } = setupSub();
  try {
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀', plain: true });
    assert.equal(out.items[0].snippets[0].context.includes('['), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: 视频预筛 videoFilter（view 叠加）', () => {
  const { db, dir } = setupSub();
  try {
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀', videoFilter: { min_view: 80 } });
    assert.equal(out.matched_videos, 1);
    assert.equal(out.items[0].video.source_vid, 'BV1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: F12 无字幕 / payload 结构异常 → 该视频跳过不崩（mock source）', () => {
  const { db, dir } = setupSub();
  try {
    const v1Id = (db.prepare('SELECT id FROM videos WHERE source_vid=?').get('BV1') as { id: number }).id;
    const v2Id = (db.prepare('SELECT id FROM videos WHERE source_vid=?').get('BV2') as { id: number }).id;
    // 候选池 LIKE 预筛读 DB 存储 payload：让 BV2 也含关键词以进入候选池，
    // 再由 mock 在匹配阶段注入「结构异常 / 正常」payload，验证异常跳过不崩。
    db.prepare(`UPDATE subtitle_versions SET payload = ? WHERE track_id IN (SELECT id FROM subtitle_tracks WHERE video_id = ?)`).run(
      JSON.stringify({ body: [{ from: 0, to: 1, content: '通胀 占位' }] }), v2Id,
    );
    const src: PayloadSource = {
      getPayloads: (vid: number) => {
        if (vid === v1Id) return [{ track: { id: 1, lan: 'zh', track_type: 1 }, version: { id: 1, origin: 'asr' }, payload: { body: '不是数组' } }];
        if (vid === v2Id) return [{ track: { id: 2, lan: 'zh', track_type: 1 }, version: { id: 2, origin: 'asr' }, payload: { body: [{ from: 0, to: 1, content: '通胀' }] } }];
        return [];
      },
    };
    const out = searchSubtitles(db, src, { keyword: '通胀' });
    assert.equal(out.matched_videos, 1);
    assert.equal(out.items[0].video.source_vid, 'BV2');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchSubtitles: --full 回整条字幕文本', () => {
  const { db, dir } = setupSub();
  try {
    const out = searchSubtitles(db, makeDbPayloadSource(db), { keyword: '通胀', full: true });
    assert.equal(typeof out.items[0].full, 'string');
    assert.ok((out.items[0].full ?? '').includes('通胀'));
    assert.ok((out.items[0].full ?? '').includes('开场白'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
