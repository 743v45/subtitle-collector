// bundle.ts 纯函数单测：stampedTxt 行格式 + ANALYZE.md 模板锚点。
// 跑法：cd apps/collector-server && node --test --import tsx src/cli/bundle.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | stampedTxt / secsToClock / ANALYZE_MD | 通过 | 行格式含轻量时间戳 |
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secsToClock, stampedTxt, ANALYZE_MD } from './bundle.js';

const PAYLOAD = {
  body: [
    { from: 5.2, to: 8, content: ' 观点一 ' },
    { from: 65, to: 70, content: '观点二' },
    { from: 3661, to: 3665, content: '一小时后' },
    { from: 71, to: 72, content: '   ' }, // 纯空白，应跳过
  ],
};

test('secsToClock: 秒→分:秒 / 时:分:秒', () => {
  assert.equal(secsToClock(0), '00:00');
  assert.equal(secsToClock(5.2), '00:05');
  assert.equal(secsToClock(65), '01:05');
  assert.equal(secsToClock(3661), '1:01:01');
});

test('stampedTxt: 行格式 [分:秒] 字幕，跳过空白行，末尾换行', () => {
  const out = stampedTxt(PAYLOAD);
  assert.equal(out, '[00:05] 观点一\n[01:05] 观点二\n[1:01:01] 一小时后\n');
});

test('stampedTxt: payload 结构不符时抛错', () => {
  assert.throws(() => stampedTxt({ noBody: true }), /结构不符/);
});

test('ANALYZE_MD: 含三类产物模板锚点 + analysis/<主题>/ 落盘路径 + 盲区两栏', () => {
  for (const anchor of ['观点汇总.md', '面试题库.md', '理念整理.md', 'manifest.json', 'videos/', '来源:',
    'analysis/<主题>/', 'pot_limited', '真无字幕', '受限待重采']) {
    assert.ok(ANALYZE_MD.includes(anchor), `ANALYZE_MD 缺锚点: ${anchor}`);
  }
  assert.ok(!ANALYZE_MD.includes('写回本目录'), '产物落盘位置应统一定稿为 analysis/<主题>/，不得再出现「写回本目录」');
});

// ── buildBundle（内存库 fixture，参照 export.test.ts setup() 的 ingestVideo 模式）──

import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { buildBundle } from './bundle.js';
import type { VideosListOpts } from './commands/videos.js';

const ZH = { body: [{ from: 0.36, to: 2.56, content: 'AI 编程工程化' }] };
const EN = { body: [{ from: 0, to: 1, content: 'hello' }] };

function setupDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: {
      source_vid: 'BV1', title: '标题A',
      creator: { source_uid: '1', name: 'Alpha UP' },
      extra: { tid: 23, tname: '科技', stat: { view: 1000 } }, duration: 600, published_at: 1724000000000,
    },
    tracks: [
      { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: ZH, source_url: 'https://cc' }] },
      { lan: 'en', lan_doc: 'English', track_type: 1, versions: [{ origin: 'asr', payload: EN, source_url: 'https://en' }] },
    ],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: {
      source_vid: 'BV2', title: '标题B（无字幕）',
      creator: { source_uid: '1', name: 'Alpha UP' },
      extra: { tid: 23, tname: '科技', stat: { view: 2000 } }, duration: 300,
    },
    tracks: [],
  });
  return { db, dir };
}

test('buildBundle: 有字幕视频出正文文件，无字幕视频 subtitle:null 不出文件', () => {
  const { db, dir } = setupDb();
  try {
    const r = buildBundle(db, { filters: {}, limit: 100, now: 1724059200000 });
    assert.equal(r.manifest.total_matched, 2);
    assert.equal(r.manifest.exported, 2);
    assert.equal(r.manifest.generated_at, 1724059200000);
    const bv1 = r.manifest.videos.find((v) => v.source_vid === 'BV1')!;
    assert.equal(bv1.subtitle?.file, 'videos/BV1.txt');
    assert.equal(bv1.subtitle?.lan, 'zh-Hans');
    assert.equal(bv1.subtitle?.track_type, 2);
    assert.equal(bv1.subtitle?.origin, 'external');
    const bv2 = r.manifest.videos.find((v) => v.source_vid === 'BV2')!;
    assert.equal(bv2.subtitle, null);
    // 文件：manifest.json + ANALYZE.md + 仅 BV1 正文
    assert.deepEqual(r.files.map((f) => f.path).sort(), ['ANALYZE.md', 'manifest.json', 'videos/BV1.txt']);
    // BV1 正文：头部元信息 + 行格式正文
    const txt = r.files.find((f) => f.path === 'videos/BV1.txt')!.content;
    assert.ok(txt.includes('# 标题A'));
    assert.ok(txt.includes('UP: Alpha UP'));
    assert.ok(txt.includes('BV: BV1'));
    assert.ok(txt.includes('轨: CC中文(zh-Hans, CC)'));
    assert.ok(txt.includes('[00:00] AI 编程工程化'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: --track en 覆盖默认轨', () => {
  const { db, dir } = setupDb();
  try {
    const r = buildBundle(db, { filters: { hasSubtitle: true }, track: 'en', limit: 100, now: 0 });
    const bv1 = r.manifest.videos.find((v) => v.source_vid === 'BV1')!;
    assert.equal(bv1.subtitle?.lan, 'en');
    assert.equal(bv1.subtitle?.origin, 'asr');
    assert.ok(r.files.find((f) => f.path === 'videos/BV1.txt')!.content.includes('轨: English(en, AI)'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: limit 截断（total_matched > exported）且 filters 回显', () => {
  const { db, dir } = setupDb();
  try {
    const filters: VideosListOpts = { creator: 'Alpha' };
    const r = buildBundle(db, { filters, limit: 1, now: 0 });
    assert.equal(r.manifest.total_matched, 2);
    assert.equal(r.manifest.exported, 1);
    assert.equal(r.manifest.limit, 1);
    assert.deepEqual(r.manifest.filters, { creator: 'Alpha' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: payload 损坏 → errors[] 记录、subtitle:null、整包不中断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BVX', title: '损坏', creator: { source_uid: '9', name: 'X' }, extra: {}, duration: 60 },
    tracks: [{ lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'asr', payload: { broken: true }, source_url: null }] }],
  });
  try {
    const r = buildBundle(db, { filters: {}, limit: 10, now: 0 });
    const bvx = r.manifest.videos.find((v) => v.source_vid === 'BVX')!;
    assert.equal(bvx.subtitle, null);
    assert.equal(r.manifest.errors!.length, 1);
    assert.ok(r.manifest.errors![0].message.includes('结构不符'));
    assert.ok(r.files.some((f) => f.path === 'manifest.json'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: 空命中正常产出（exported=0，仍含 manifest+ANALYZE）', () => {
  const { db, dir } = setupDb();
  try {
    const r = buildBundle(db, { filters: { creator: '不存在的人' }, limit: 10, now: 0 });
    assert.equal(r.manifest.total_matched, 0);
    assert.equal(r.manifest.exported, 0);
    assert.deepEqual(r.files.map((f) => f.path).sort(), ['ANALYZE.md', 'manifest.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── pot_limited 受限标记（最近一次 collect_tasks 任务 status='limited' 即标记；重采成功后自然消失）──

test('buildBundle: 最近任务 limited 的视频标 pot_limited=true，真无字幕/有字幕为 false；重采成功后标记消失', () => {
  const { db, dir } = setupDb();
  try {
    // BV2 无字幕（setupDb 造的「真无字幕」形态）；给它补一条 limited 任务 → 半入库形态
    db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at, finished_at) VALUES ('bilibili', 'BV2', 'https://b23.tv/BV2', 'limited', 100, 200)").run();
    let r = buildBundle(db, { filters: {}, limit: 100, now: 0 });
    const bv1 = r.manifest.videos.find((v) => v.source_vid === 'BV1')!;
    const bv2 = r.manifest.videos.find((v) => v.source_vid === 'BV2')!;
    assert.equal(bv1.pot_limited, false, '有字幕且无任务记录 → false');
    assert.equal(bv2.pot_limited, true, '最近任务 limited → true（半入库，与真无字幕区分）');
    assert.equal(bv2.subtitle, null);
    // 重采成功（id 更大的 succeeded 任务成为「最近一条」）→ 标记自然消失（选任务表派生而非 videos 加列的原因）
    db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at, finished_at) VALUES ('bilibili', 'BV2', 'https://b23.tv/BV2', 'succeeded', 300, 400)").run();
    r = buildBundle(db, { filters: {}, limit: 100, now: 0 });
    assert.equal(r.manifest.videos.find((v) => v.source_vid === 'BV2')!.pot_limited, false, '重采成功后标记应消失');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: 失败任务不算受限（仅 limited 终态标记）；无任何任务的真无字幕视频为 false', () => {
  const { db, dir } = setupDb();
  try {
    db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at, finished_at) VALUES ('bilibili', 'BV2', 'https://b23.tv/BV2', 'failed', 100, 200)").run();
    const r = buildBundle(db, { filters: {}, limit: 100, now: 0 });
    assert.equal(r.manifest.videos.find((v) => v.source_vid === 'BV2')!.pot_limited, false, 'failed ≠ limited，不标受限');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 头部元信息降级分支：缺 creator/duration/published_at、轨缺 lan/lan_doc/track_type ──
// 覆盖 videoHeader 的 '未知UP'/'未知'/'?'/'(无lan)' 与 BundleSubtitleMeta 的 null 透传。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R2 | videoHeader 降级分支 + track_type=3 '翻译' 标签 | 通过 | 头部字段各自回落占位文案 |

test('buildBundle: 无 creator/duration/published_at + 轨缺 lan/lan_doc/track_type → 头部占位文案 + meta null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  // 无 creator、无 duration/published_at；轨不带 lan/lan_doc/track_type；版本 manual 档
  ingestVideo(db, {
    source: 'youtube',
    video: { source_vid: 'ytBare', title: '裸元信息' },
    tracks: [{ versions: [{ origin: 'manual', payload: { body: [{ from: 1, to: 2, content: 'hi' }] }, source_url: null }] }],
  });
  try {
    const r = buildBundle(db, { filters: {}, limit: 10, now: 0 });
    const v = r.manifest.videos.find((x) => x.source_vid === 'ytBare')!;
    assert.equal(v.creator_name, null);
    assert.equal(v.duration, null);
    assert.equal(v.published_at, null);
    assert.equal(v.subtitle?.lan, null);
    assert.equal(v.subtitle?.lan_doc, null);
    assert.equal(v.subtitle?.track_type, null);
    assert.equal(v.subtitle?.origin, 'manual');
    const txt = r.files.find((f) => f.path === 'videos/ytBare.txt')!.content;
    assert.ok(txt.includes('# 裸元信息'));
    assert.ok(txt.includes('UP: 未知UP  时长: 未知  发布: 未知'), `头部降级文案不符: ${txt.split('\n')[1]}`);
    assert.ok(txt.includes('轨: (无lan)  版本来源: manual'), `轨行降级文案不符: ${txt.split('\n')[2]}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: track_type=3（翻译轨）→ 头部轨标签「翻译」；有 lan 无 lan_doc → 只显 lan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'youtube',
    video: { source_vid: 'ytT3', title: '翻译轨视频', creator: { source_uid: 'UC1', name: 'ch' }, extra: {}, duration: 60, published_at: 1724000000000 },
    tracks: [{ lan: 'ja', lan_doc: '日本語', track_type: 3, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 1, content: 'こん' }] }, source_url: 'https://tt?tlang=ja' }] }],
  });
  // lan 存在但 lan_doc 缺 → trackLabel 退化为裸 lan（不带 (lan, 类型) 后缀）
  ingestVideo(db, {
    source: 'youtube',
    video: { source_vid: 'ytNoDoc', title: '无轨名视频', creator: { source_uid: 'UC1', name: 'ch' }, extra: {}, duration: 60, published_at: 1724000000000 },
    tracks: [{ lan: 'ko', track_type: 1, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 1, content: '안녕' }] }, source_url: 'https://tt?lang=ko' }] }],
  });
  try {
    const r = buildBundle(db, { filters: {}, track: 'ja', limit: 10, now: 0 });
    let txt = r.files.find((f) => f.path === 'videos/ytT3.txt')!.content;
    assert.ok(txt.includes('轨: 日本語(ja, 翻译)'), `track_type=3 应标「翻译」: ${txt.split('\n')[2]}`);
    const r2 = buildBundle(db, { filters: {}, track: 'ko', limit: 10, now: 0 });
    txt = r2.files.find((f) => f.path === 'videos/ytNoDoc.txt')!.content;
    assert.ok(txt.includes('轨: ko  版本来源: external'), `lan_doc 缺失应只显 lan: ${txt.split('\n')[2]}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
