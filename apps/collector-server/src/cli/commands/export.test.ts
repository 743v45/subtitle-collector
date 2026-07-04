// export.ts 纯处理函数单测：resolveSubtitle（默认/track/version/NOT_FOUND/各格式）+ serializeVideosResult。
// 跑法（不在 pnpm test glob 内）：cd apps/collector-server && node --test --import tsx src/cli/commands/export.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | resolveSubtitle + serializeVideosResult | 通过 | 字幕 payload 对齐 info/body.json 结构 |
// | R2 | 端到端 commander 解析（--sub-format 回归） | 通过 | spawn tsx 跑 main.ts，防 commander 同名 option 冲突再现 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { resolveSubtitle, serializeVideosResult } from './export.js';
import type { VideoListItemAdvanced, PageResult } from '../../db/advanced.js';

// B 站字幕 payload 样本（结构对齐 info/body.json，裁剪为 2 条便于断言）
const ZH_PAYLOAD = {
  font_size: 0.4, type: 'AIsubtitle', lang: 'zh', version: 'v1',
  body: [
    { from: 0.36, to: 2.56, content: '前几期我一直在讲AI编程工程化' },
    { from: 2.56, to: 5.63, content: '评论区很多观众说能不能看实际的代码的流程' },
  ],
};
const EN_PAYLOAD = { body: [{ from: 0, to: 1, content: 'hello world' }] };

function setup(): { db: Database.Database; dir: string; ids: { zhVer: number; enVer: number; v1: number } } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-export-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);

  ingestVideo(db, {
    source: 'bilibili',
    video: {
      source_vid: 'BV1', title: '标题A',
      creator: { source_uid: '1', name: 'Alpha UP' },
      extra: { tid: 17, tname: '单机游戏', stat: { view: 1000 } }, duration: 600, published_at: 1000,
    },
    tracks: [
      // zh-Hans CC（track_type=2）→ getVideo 排序后为默认轨
      { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: ZH_PAYLOAD, source_url: 'https://cc' }] },
      { lan: 'en', lan_doc: 'English', track_type: 1, versions: [{ origin: 'external', payload: EN_PAYLOAD, source_url: 'https://en' }] },
    ],
  });

  const verOf = (lan: string) => (db.prepare(
    'SELECT sv.id FROM subtitle_versions sv JOIN subtitle_tracks st ON st.id = sv.track_id JOIN videos v ON v.id = st.video_id WHERE v.source_vid = ? AND st.lan = ?',
  ).get('BV1', lan) as { id: number }).id;
  const v1 = (db.prepare('SELECT id FROM videos WHERE source_vid = ?').get('BV1') as { id: number }).id;
  return { db, dir, ids: { zhVer: verOf('zh-Hans'), enVer: verOf('en'), v1 } };
}

// ── resolveSubtitle：选轨 / 选版本 ──

test('resolveSubtitle: 默认取 is_default 轨（zh-Hans CC）的 is_default version', () => {
  const { db, dir, ids } = setup();
  try {
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', format: 'json' });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    assert.equal(r.versionId, ids.zhVer);
    assert.deepEqual(r.payload, ZH_PAYLOAD);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveSubtitle: --track en 取 en 轨默认版本', () => {
  const { db, dir, ids } = setup();
  try {
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', track: 'en', format: 'json' });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    assert.equal(r.versionId, ids.enVer);
    assert.deepEqual(r.payload, EN_PAYLOAD);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveSubtitle: --version <id> 优先于 --track', () => {
  const { db, dir, ids } = setup();
  try {
    // --track zh-Hans 但 --version 指向 en 的版本 → 取 en 版本
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', track: 'zh-Hans', versionId: ids.enVer, format: 'json' });
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    assert.equal(r.versionId, ids.enVer);
    assert.deepEqual(r.payload, EN_PAYLOAD);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveSubtitle: NOT_FOUND（视频 / track / version）', () => {
  const { db, dir, ids } = setup();
  try {
    assert.equal(resolveSubtitle(db, { source: 'bilibili', sourceVid: 'NOPE', format: 'srt' }).kind, 'not_found');
    const r1 = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', track: 'ja', format: 'srt' });
    assert.equal(r1.kind, 'not_found');
    if (r1.kind === 'not_found') assert.match(r1.message, /lan=ja/);
    const r2 = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', versionId: 99999, format: 'srt' });
    assert.equal(r2.kind, 'not_found');
    if (r2.kind === 'not_found') assert.match(r2.message, /99999/);
    assert.ok(ids.zhVer > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── resolveSubtitle：各字幕格式输出 ──

test('resolveSubtitle: srt 头块序号+逗号毫秒时间戳+content', () => {
  const { db, dir } = setup();
  try {
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', format: 'srt' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    assert.ok(
      r.text.startsWith('1\n00:00:00,360 --> 00:00:02,560\n前几期我一直在讲AI编程工程化'),
      `srt 头块不符: ${r.text.slice(0, 80)}`,
    );
    assert.ok(r.text.endsWith('\n'));
    assert.equal(r.text.replace(/\n$/, '').split('\n\n').length, 2); // 2 块
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveSubtitle: vtt WEBVTT 头 + 小数点毫秒时间戳', () => {
  const { db, dir } = setup();
  try {
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', format: 'vtt' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    assert.ok(r.text.startsWith('WEBVTT\n\n'), `vtt 缺 WEBVTT 头: ${r.text.slice(0, 40)}`);
    assert.match(r.text, /00:00:00\.360 --> 00:00:02\.560/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveSubtitle: txt 仅 content 每条一行', () => {
  const { db, dir } = setup();
  try {
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', format: 'txt' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    const lines = r.text.replace(/\n$/, '').split('\n');
    assert.deepEqual(lines, ['前几期我一直在讲AI编程工程化', '评论区很多观众说能不能看实际的代码的流程']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveSubtitle: json 可往返 parse 回原 payload', () => {
  const { db, dir } = setup();
  try {
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', format: 'json' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    assert.deepEqual(JSON.parse(r.text), ZH_PAYLOAD);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── serializeVideosResult（export videos -o 写文件序列化）──

function makeItem(over: Partial<VideoListItemAdvanced>): VideoListItemAdvanced {
  return {
    id: 1, source: 'bilibili', source_vid: 'BV1', title: '标题A',
    creator_name: 'Alpha UP', creator_source_uid: '1',
    duration: 600, published_at: 1000, first_seen_at: 1000, track_count: 2,
    ...over,
  };
}

test('serializeVideosResult: json 美化整个 {total,page,size,items}，末尾换行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-export-ser-'));
  try {
    const result: PageResult<VideoListItemAdvanced> = { total: 1, page: 1, size: 20, items: [makeItem({})] };
    const out = serializeVideosResult(result, 'json');
    assert.deepEqual(JSON.parse(out), result);
    assert.ok(out.endsWith('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('serializeVideosResult: ndjson 每行一个 item', () => {
  const result: PageResult<VideoListItemAdvanced> = {
    total: 2, page: 1, size: 20,
    items: [makeItem({ id: 1, source_vid: 'BV1' }), makeItem({ id: 2, source_vid: 'BV2', title: '标题B' })],
  };
  const out = serializeVideosResult(result, 'ndjson');
  const lines = out.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), result.items[0]);
  assert.deepEqual(JSON.parse(lines[1]), result.items[1]);
});

test('serializeVideosResult: csv 表头 + 各行；含逗号字段双引号转义', () => {
  const result: PageResult<VideoListItemAdvanced> = {
    total: 1, page: 1, size: 20,
    items: [makeItem({ title: '标题,A' })],
  };
  const out = serializeVideosResult(result, 'csv');
  const lines = out.replace(/\n$/, '').split('\n');
  assert.equal(
    lines[0],
    'id,source,source_vid,title,creator_name,creator_source_uid,duration,published_at,first_seen_at,track_count',
  );
  // 含逗号的 title 字段被双引号包裹
  assert.ok(lines[1].includes('"标题,A"'), `csv 含逗号字段未转义: ${lines[1]}`);
});

// ── 端到端：export subtitle 纯函数输出 + 手写文件（验证 -o 路径可写）──

test('export subtitle -o 等价：resolveSubtitle.text 写文件后字节一致', () => {
  const { db, dir } = setup();
  try {
    const r = resolveSubtitle(db, { source: 'bilibili', sourceVid: 'BV1', format: 'srt' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    const file = join(dir, 'out.srt');
    writeFileSync(file, r.text);
    const written = readFileSync(file, 'utf-8');
    assert.equal(written, r.text);
    assert.equal(statSync(file).size, Buffer.byteLength(r.text));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 端到端：commander 解析层回归（防 export --format 与全局 --format 同名冲突再现）──
// 背景：commander 的 program 级 --format 会吞掉子命令同名 option，导致 export subtitle 的
// 字幕格式永远走默认 srt。修复改用 --sub-format，此测试 spawn 真实 CLI 验证 --sub-format 经
// commander 解析后真正生效（输出 WEBVTT 而非 srt）。

test('端到端: export subtitle --sub-format vtt 经 commander 输出 WEBVTT（非默认 srt）', () => {
  const { db, dir } = setup();
  db.close(); // 关写连接，让 spawn 的只读连接独占读
  try {
    const dbPath = join(dir, 'test.db');
    const r = spawnSync('./node_modules/.bin/tsx', [
      'src/cli/main.ts', '--db', dbPath, '--quiet',
      'export', 'subtitle', 'bilibili', 'BV1', '--sub-format', 'vtt',
    ], { encoding: 'utf-8' });
    assert.equal(r.status, 0, `期望 exit=0，实际 exit=${r.status}，stderr=${r.stderr}`);
    assert.match(r.stdout, /WEBVTT/, `stdout 缺 WEBVTT 头（--sub-format 未生效）: ${r.stdout.slice(0, 80)}`);
    assert.doesNotMatch(r.stdout, /^1\r?\n00:00:00,360/, `仍输出 srt 格式，--sub-format vtt 未被 commander 接收`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
