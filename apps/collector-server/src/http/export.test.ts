// http/export.ts 端点测试：文件下载通道（CLI 全功能 web 化 Phase 2）。
// 覆盖：/api/export/videos（csv 表头/转义 + ndjson + json + 分页取全 + 筛选 + 空结果探针表头 +
// 空库空文件 + format/sort 400）/ /api/export/subtitle（默认轨默认版本 + 各格式 + 显式 track/version +
// 404 族带 available_lans + 参数 400 + vid decodeURIComponent）/ /api/export/bundle（zip 完整性 +
// manifest 口径 + 部分成功 errors + limit/name_order/track + 400 族）。
// 措辞：字幕（subtitle），非弹幕。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 三端点全参数/错误码/下载头/zip 完整性/分页/空态 | 通过 | Phase 2 下载通道 |
// | R2 | +payload 损坏 400；bundle 断言改锚有字幕视频；export.ts 复杂度重构（19→≤15）后回归 | 通过 | 静态门收敛 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { handleExportHttp } from './export.js';

// 数据集：BV1 双轨（ai-zh CC 默认 2 行 + ai-en 双版本 external/manual）/ BV2 payload 损坏（bundle errors 用）/
// YT1（youtube 平台筛选用）/ 'yt 中'（vid decodeURIComponent 用）/ 102 个无轨视频（分页取全 size=100 用，
// 其中 1 个标题含逗号引号——csv 转义）。总 106 行 > 100 → 跨两页。
function setup(): Promise<{ port: number; db: Database.Database; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-export-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '英文一', creator: { source_uid: '1', name: 'up' }, duration: 60, published_at: 1 },
    tracks: [
      { lan: 'ai-zh', lan_doc: '中文', track_type: 2, versions: [{ origin: 'external', payload: { body: [
        { from: 0, to: 2, content: '你好' },
        { from: 3, to: 5, content: '世界' },
      ] } }] },
      { lan: 'ai-en', lan_doc: 'English', versions: [
        { origin: 'external', payload: { body: [{ from: 0, to: 2, content: 'hello one' }] } },
        { origin: 'manual', payload: { body: [{ from: 0, to: 2, content: 'manual hello' }] } },
      ] },
    ],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV2', title: '损坏', creator: { source_uid: '1', name: 'up' }, duration: 60, published_at: 1 },
    tracks: [{ lan: 'ai-zh', lan_doc: '中文', versions: [{ origin: 'external', payload: { body: 'broken-not-array' } }] }],
  });
  ingestVideo(db, {
    source: 'youtube',
    video: { source_vid: 'YT1', title: '英文二', creator: { source_uid: '2', name: 'up2' }, duration: 60, published_at: 1 },
    tracks: [{ lan: 'ai-en', lan_doc: 'English', versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 2, content: 'alpha two' }] } }] }],
  });
  ingestVideo(db, {
    source: 'youtube',
    video: { source_vid: 'yt 中', title: '解码', creator: { source_uid: '2', name: 'up2' }, duration: 60, published_at: 1 },
    tracks: [{ lan: 'ai-en', lan_doc: 'English', versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 2, content: 'decoded' }] } }] }],
  });
  for (let i = 1; i <= 102; i++) {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: `VID${String(i).padStart(4, '0')}`, title: i === 1 ? '带,引号"标题' : `分页视频${i}`, creator: { source_uid: '9', name: 'bulk' }, duration: 10, published_at: 1 },
      tracks: [],
    });
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleExportHttp(req, res, db);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        db,
        cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
      });
    });
  });
}

// 空库 setup（空文件/探针落空用例）
function setupEmpty(): Promise<{ port: number; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-export-empty-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleExportHttp(req, res, db);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
      });
    });
  });
}

async function get(port: number, path: string, method = 'GET'): Promise<{ status: number; headers: Headers; buf: Buffer; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf, json: res.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(buf.toString('utf8')) : null };
}

// ── /api/export/videos ──

test('export videos：csv 全量下载——下载头/X-Export-Count/表头=首条 keys/行数/csvEscape 转义', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await get(port, '/api/export/videos?format=csv');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="videos-export.csv"; filename*=UTF-8\'\'videos-export.csv');
    assert.equal(r.headers.get('x-export-count'), '106');
    const text = r.buf.toString('utf8');
    const lines = text.split('\n');
    // 末尾换行 → 最后一段空串；数据行 = 表头 + 106
    assert.equal(lines.length, 108);
    // 表头 = listVideosFiltered 首条行 keys（含 CLI export videos 口径的核心列）
    for (const k of ['id', 'source', 'source_vid', 'title', 'creator_name', 'duration', 'published_at', 'first_seen_at', 'track_count']) {
      assert.ok(lines[0].split(',').includes(k), `表头应含 ${k}`);
    }
    // csvEscape：含逗号/引号的标题被双引号包裹 + 内部引号双写（复用 cli/output.ts 同一转义）
    assert.ok(text.includes('"带,引号""标题"'), '特殊标题应转义');
  } finally { cleanup(); }
});

test('export videos：ndjson 每条一行 + json 整体 {total, items}', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await get(port, '/api/export/videos?format=ndjson');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    const rows = r.buf.toString('utf8').trimEnd().split('\n');
    assert.equal(rows.length, 106);
    assert.equal(r.headers.get('x-export-count'), '106');
    const first = JSON.parse(rows[0]);
    assert.equal(typeof first.source_vid, 'string');

    r = await get(port, '/api/export/videos?format=json');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.json.total, 106);
    assert.equal(r.json.items.length, 106);
    // 缺省 format = json（对齐 CLI 全局 --format 默认）
    const dft = await get(port, '/api/export/videos');
    assert.equal(dft.json.total, 106);
  } finally { cleanup(); }
});

test('export videos：筛选与排序生效（source=youtube 只出该平台；sort/desc 走 parseSortParams）', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await get(port, '/api/export/videos?format=json&source=youtube');
    assert.equal(r.json.total, 2);
    assert.ok(r.json.items.every((it: any) => it.source === 'youtube'));
    r = await get(port, '/api/export/videos?format=json&source=bilibili&sort=title&desc=false');
    assert.equal(r.json.total, 104);
    // sort 非法 → 400（错误列全合法键，对齐 /api/videos 口径）
    r = await get(port, '/api/export/videos?sort=bad');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /sort must be one of/);
  } finally { cleanup(); }
});

test('export videos：分页取全（106 条 > 单页 100，循环拉两页拼齐）', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await get(port, '/api/export/videos?format=ndjson&sort=first_seen');
    const rows = r.buf.toString('utf8').trimEnd().split('\n');
    assert.equal(rows.length, 106);
    const vids = new Set(rows.map((l) => JSON.parse(l).source_vid));
    assert.equal(vids.size, 106);
  } finally { cleanup(); }
});

test('export videos：format 非法 → 400', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await get(port, '/api/export/videos?format=table');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /format must be one of csv\|ndjson\|json/);
  } finally { cleanup(); }
});

test('export videos：空结果（filter 无命中）→ csv 仅探针表头行；空库 → 空文件', async () => {
  const { port, cleanup } = await setup();
  try {
    // filter 无命中：探针（不带 filter）拿到 keys → 只回表头行
    const r = await get(port, '/api/export/videos?format=csv&source=nomatch');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-export-count'), '0');
    const lines = r.buf.toString('utf8').trimEnd().split('\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('source_vid'));
  } finally { cleanup(); }

  const { port: port2, cleanup: cleanup2 } = await setupEmpty();
  try {
    // 空库：探针也无行 → 空文件（包络靠 X-Export-Count）
    const r = await get(port2, '/api/export/videos?format=csv');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-export-count'), '0');
    assert.equal(r.buf.length, 0);
  } finally { cleanup2(); }
});

// ── /api/export/subtitle ──

test('export subtitle：默认轨默认版本 srt——正文/下载头/X-Track-Lan/X-Version-Id', async () => {
  const { port, db, cleanup } = await setup();
  try {
    const r = await get(port, '/api/export/subtitle/bilibili/BV1?format=srt');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="BV1.srt"; filename*=UTF-8\'\'BV1.srt');
    const text = r.buf.toString('utf8');
    // 默认轨 = CC中文（track_type=2 优先），两行 SRT
    assert.ok(text.includes('1\n00:00:00,000 --> 00:00:02,000\n你好'), '首块时间轴+文本');
    assert.ok(text.includes('00:00:03,000 --> 00:00:05,000\n世界'), '次块');
    assert.equal(r.headers.get('x-track-lan'), 'ai-zh');
    const verId = db.prepare("SELECT v.id FROM subtitle_versions v JOIN subtitle_tracks t ON v.track_id=t.id WHERE t.video_id=(SELECT id FROM videos WHERE source_vid='BV1') AND t.lan='ai-zh'").get() as { id: number };
    assert.equal(r.headers.get('x-version-id'), String(verId.id));
  } finally { cleanup(); }
});

test('export subtitle：vtt/txt/json 三格式', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await get(port, '/api/export/subtitle/bilibili/BV1?format=vtt');
    assert.ok(r.buf.toString('utf8').startsWith('WEBVTT'));
    assert.ok(r.buf.toString('utf8').includes('00:00:00.000 --> 00:00:02.000'));
    r = await get(port, '/api/export/subtitle/bilibili/BV1?format=txt');
    assert.equal(r.buf.toString('utf8'), '你好\n世界\n');
    r = await get(port, '/api/export/subtitle/bilibili/BV1?format=json');
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(r.buf.toString('utf8')), { body: [
      { from: 0, to: 2, content: '你好' },
      { from: 3, to: 5, content: '世界' },
    ] });
  } finally { cleanup(); }
});

test('export subtitle：显式 track 覆盖默认轨；version 优先于 track（manual 版本内容）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    let r = await get(port, '/api/export/subtitle/bilibili/BV1?track=ai-en');
    assert.equal(r.buf.toString('utf8'), '1\n00:00:00,000 --> 00:00:02,000\nhello one\n');
    assert.equal(r.headers.get('x-track-lan'), 'ai-en');
    const manual = db.prepare("SELECT id FROM subtitle_versions WHERE origin='manual'").get() as { id: number };
    r = await get(port, `/api/export/subtitle/bilibili/BV1?track=ai-en&version=${manual.id}`);
    assert.equal(r.buf.toString('utf8'), '1\n00:00:00,000 --> 00:00:02,000\nmanual hello\n');
  } finally { cleanup(); }
});

test('export subtitle：vid 经 decodeURIComponent（含空格与中文的 source_vid）', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await get(port, `/api/export/subtitle/youtube/${encodeURIComponent('yt 中')}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="yt _.srt"; filename*=UTF-8\'\'yt%20%E4%B8%AD.srt');
    assert.ok(r.buf.toString('utf8').includes('decoded'));
  } finally { cleanup(); }
});

test('export subtitle：404 族——轨不存在带 available_lans/版本不存在/视频不存在；format/version 参数 400', async () => {
  const { port, cleanup } = await setup();
  try {
    // 轨不存在 → 404 + available_lans（对齐 http/translate.ts 先例）
    let r = await get(port, '/api/export/subtitle/bilibili/BV1?track=ja');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /track not found: lan=ja/);
    assert.deepEqual(r.json.available_lans.sort(), ['ai-en', 'ai-zh']);
    // 视频不存在 → 404 无 available_lans
    r = await get(port, '/api/export/subtitle/bilibili/NOPE');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /video not found/);
    assert.equal(r.json.available_lans, undefined);
    // 版本不存在 → 404
    r = await get(port, '/api/export/subtitle/bilibili/BV1?version=999999');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /subtitle_version not found: id=999999/);
    // format 非法 → 400
    r = await get(port, '/api/export/subtitle/bilibili/BV1?format=mp3');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /format must be one of srt\|vtt\|txt\|json/);
    // version 非数字 → 400
    r = await get(port, '/api/export/subtitle/bilibili/BV1?version=abc');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /version must be a positive integer/);
    // payload 损坏（convertSubtitle 抛）→ 400，错误文案透传（错误分支可观察）
    r = await get(port, '/api/export/subtitle/bilibili/BV2');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /payload 结构不符：body 不是非空数组/);
  } finally { cleanup(); }
});

// ── /api/export/bundle ──

// zip 落临时盘跑 unzip 子命令（-t 完整性 / -p 抽文件 / -l 列名）
function withZip(zip: Buffer, fn: (fp: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'collector-export-bundle-'));
  try {
    const fp = join(dir, 'bundle.zip');
    writeFileSync(fp, zip);
    fn(fp);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('export bundle：全量出包——zip 完整性/manifest 口径/X-Bundle-* 头/部分成功 errors', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await get(port, '/api/export/bundle');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename="bundle-\d{8}-\d{6}\.zip"/);
    assert.equal(r.headers.get('x-bundle-total'), '106');
    assert.equal(r.headers.get('x-bundle-exported'), '106');
    // BV2 payload 损坏 → errors=1 仍照常出包（部分成功语义，对齐 CLI）
    assert.equal(r.headers.get('x-bundle-errors'), '1');
    withZip(r.buf, (fp) => {
      assert.match(execSync(`unzip -t ${JSON.stringify(fp)}`, { encoding: 'utf8' }), /No errors detected/);
      const manifest = JSON.parse(execSync(`unzip -p ${JSON.stringify(fp)} manifest.json`, { encoding: 'utf8' }));
      assert.equal(manifest.total_matched, 106);
      assert.equal(manifest.exported, 106);
      assert.equal(manifest.errors.length, 1);
      assert.equal(manifest.errors[0].source_vid, 'BV2');
      const listing = execSync(`unzip -l ${JSON.stringify(fp)}`, { encoding: 'utf8' });
      assert.ok(listing.includes('ANALYZE.md'));
      assert.ok(listing.includes('manifest.json'));
      // 默认 name_order=id,name：有字幕视频才有 <vid>-<标题>.txt 文件（BV1 有 ai-zh 轨 → videos/BV1-*.txt；
      // 无轨视频不产字幕文件，BV2 payload 损坏走 errors——CLI 同口径）。macOS 系统 unzip 对 UTF-8 名显示乱码，
      // 故只锚 ASCII 前后缀；中文文件名正确性已由 zip.test.ts 的字节级解析覆盖
      assert.ok(/BV1-[^ ]*\.txt/.test(listing), '有字幕视频应有 <vid>-<标题>.txt 文件');
    });
  } finally { cleanup(); }
});

test('export bundle：limit 截断 + name_order=id,time 生效 + track 覆盖（manifest 轨 lan）', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await get(port, '/api/export/bundle?limit=2');
    assert.equal(r.headers.get('x-bundle-exported'), '2');
    withZip(r.buf, (fp) => {
      const manifest = JSON.parse(execSync(`unzip -p ${JSON.stringify(fp)} manifest.json`, { encoding: 'utf8' }));
      assert.equal(manifest.exported, 2);
      assert.equal(manifest.limit, 2);
    });
    // name_order=id,time：文件名 <vid>-<发布日期>.txt（has_subtitle=1 圈定有字幕集 + desc=false
    // 使 BV1 落在前 limit=3 内——无轨视频不产字幕文件，无法断言文件名；BV2 payload 损坏不出文件，
    // 故锚 BV1 的 published_at=1 → 1970-01-01）
    r = await get(port, '/api/export/bundle?limit=3&name_order=id,time&has_subtitle=1&desc=false');
    assert.equal(r.status, 200);
    withZip(r.buf, (fp) => {
      const listing = execSync(`unzip -l ${JSON.stringify(fp)}`, { encoding: 'utf8' });
      assert.ok(/BV1-\d{4}-\d{2}-\d{2}\.txt/.test(listing), '应有 <vid>-<日期>.txt 文件名');
    });
    // track=ai-en 统一覆盖：BV1 的 subtitle.lan 变 ai-en（默认轨本为 ai-zh；q=英文一 圈定只导 BV1）
    r = await get(port, '/api/export/bundle?limit=1&track=ai-en&q=%E8%8B%B1%E6%96%87%E4%B8%80');
    withZip(r.buf, (fp) => {
      const manifest = JSON.parse(execSync(`unzip -p ${JSON.stringify(fp)} manifest.json`, { encoding: 'utf8' }));
      assert.equal(manifest.exported, 1);
      const bv1 = manifest.videos.find((v: any) => v.source_vid === 'BV1');
      assert.equal(bv1.subtitle.lan, 'ai-en');
    });
  } finally { cleanup(); }
});

test('export bundle：limit 非法/超上限/name_order 非法 → 400（列合法值）', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await get(port, '/api/export/bundle?limit=1001');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /limit must be <= 1000/);
    r = await get(port, '/api/export/bundle?limit=abc');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /limit must be a positive integer/);
    r = await get(port, '/api/export/bundle?limit=0');
    assert.equal(r.status, 400);
    r = await get(port, '/api/export/bundle?name_order=bad');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /invalid name_order part: bad/);
    assert.match(r.json.error, /id\|name\|time\|author/);
    r = await get(port, '/api/export/bundle?name_order=id,id');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /duplicate name_order part/);
    // sort 非法同款 400（parseSortParams 口径）
    r = await get(port, '/api/export/bundle?sort=bad');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /sort must be one of/);
  } finally { cleanup(); }
});

test('export：未知路径与非 GET → 404', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await get(port, '/api/export/whatever');
    assert.equal(r.status, 404);
    r = await get(port, '/api/export/videos', 'POST');
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});
