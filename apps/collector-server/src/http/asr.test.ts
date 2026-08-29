// http/asr.ts 端点测试：POST /api/asr/submit 全链路。
// 覆盖：成功写回（asr-zh-<engine> 轨 / origin=asr / asr_engine / track_type=1 / payload 结构 / no-subtitle 摘标）
// + 多引擎分轨并存（不同 engine → 不同轨，版本各自成轨；2026-08-29 引擎命名改造）
// + 幂等重跑（origin=asr 按 body_hash 去重 skipped）+ 失败路径（404 视频 / 400 参数族）。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 成功×1（含摘标断言）+ 幂等重跑 + 404×1 + 400×4 | 通过 | |
// | R2 | lan 改按引擎派生（asr-zh-fireredasr-aed-l / lan_doc 中文（ASR·引擎））+ 引擎 B 再写 → 第二轨并存 | 通过 | 新命名断言在旧代码（lan 恒 asr-zh）上红，失败→通过锚点 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { markNoSubtitle } from '../db/tags.js';
import { getVideo } from '../db/queries.js';
import { handleAsrHttp } from './asr.js';

// 起 handler 直挂的测试 server（不经 main.ts 的 Origin 守卫，聚焦 handler 逻辑；对齐 translate.test.ts 范式）
function setup(): Promise<{ port: number; db: Database.Database; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-asr-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  // BV1：无轨视频 + 已打 no-subtitle 系统标（ASR 兜底的典型目标态）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '无字幕视频', creator: { source_uid: '1', name: 'up' }, duration: 10, published_at: 1700000000000 },
    tracks: [],
  });
  markNoSubtitle(db, { source: 'bilibili', source_vid: 'BV1' });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleAsrHttp(req, res, db);
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

async function call(port: number, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/asr/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function cues() {
  return [
    { from: 0.0, to: 2.5, content: '第一句转写' },
    { from: 2.6, to: 5.0, content: '第二句转写' },
  ];
}

test('asr submit：成功写回（asr-zh-<engine> 轨 + origin/asr_engine 落位 + no-subtitle 摘标）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 1. 首次 submit 成功（lan 从请求 engine 派生）
    const r = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'fireredasr-aed-l', cues: cues() });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.lan, 'asr-zh-fireredasr-aed-l');
    assert.equal(r.json.cues, 2);
    assert.equal(r.json.inserted, 1);
    assert.equal(r.json.skipped, 0);
    assert.equal(r.json.no_subtitle_unmarked, true, '新轨落库应摘 no-subtitle 标');

    // 2. 库内断言：asr-zh-fireredasr-aed-l 轨一条（track_type=1）+ asr 版本一条（origin/asr_engine/source_url 落位）
    const detail = getVideo(db, 'bilibili', 'BV1')!;
    const track = detail.tracks.find((t) => t.lan === 'asr-zh-fireredasr-aed-l');
    assert.ok(track, 'asr-zh-fireredasr-aed-l 轨已写入');
    assert.equal(track.lan_doc, '中文（ASR·fireredasr-aed-l）');
    assert.equal(track.versions.length, 1);
    const trackRow = db.prepare('SELECT track_type FROM subtitle_tracks WHERE id = ?').get(track.id) as { track_type: number };
    assert.equal(trackRow.track_type, 1, 'track_type=1（AI/ASR 自动轨语义）');
    const verRow = db.prepare('SELECT payload, origin, asr_engine, source_url FROM subtitle_versions WHERE track_id = ?').get(track.id) as { payload: string; origin: string; asr_engine: string; source_url: string };
    assert.equal(verRow.origin, 'asr');
    assert.equal(verRow.asr_engine, 'fireredasr-aed-l');
    assert.equal(verRow.source_url, 'asr://fireredasr-aed-l');
    const payload = JSON.parse(verRow.payload);
    assert.equal(payload.type, 'AIsubtitle');
    assert.deepEqual(payload.body, cues(), 'cues 逐条映射 body（from/to 秒 + content）');

    // 3. 摘标断言：video_tags 里 no-subtitle 关系已移除
    const tagRow = db.prepare(
      `SELECT COUNT(*) AS c FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
       JOIN videos v ON v.id = vt.video_id WHERE v.source = 'bilibili' AND v.source_vid = 'BV1' AND t.name = 'no-subtitle'`,
    ).get() as { c: number };
    assert.equal(tagRow.c, 0, 'no-subtitle 标已摘');

    // 4. 幂等重跑：同 cues 再 submit → asr 按 (track, origin, engine, body_hash) 命中 skipped，零新增
    const r2 = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'fireredasr-aed-l', cues: cues() });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.inserted, 0);
    assert.equal(r2.json.skipped, 1);
    assert.equal(r2.json.no_subtitle_unmarked, false, '标已摘，重复 submit 不再报摘标');
    assert.equal(getVideo(db, 'bilibili', 'BV1')!.tracks.find((t) => t.lan === 'asr-zh-fireredasr-aed-l')!.versions.length, 1, '版本不堆积');
  } finally {
    cleanup();
  }
});

test('asr submit 多引擎：引擎 B 再写 → 第二轨并存（asr-zh-<B>），两轨各自 versions/engine 标记', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 1. 引擎 A 写入 → 轨 asr-zh-<A>
    const rA = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'engine-a', cues: cues() });
    assert.equal(rA.status, 200);
    assert.equal(rA.json.lan, 'asr-zh-engine-a');
    assert.equal(rA.json.inserted, 1);

    // 2. 引擎 B 写入 → 新轨 asr-zh-<B> 并存（UNIQUE(video_id,lan,track_type) 天然分轨，不互相顶替）
    const rB = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'engine-b', cues: cues() });
    assert.equal(rB.status, 200);
    assert.equal(rB.json.lan, 'asr-zh-engine-b');
    assert.equal(rB.json.inserted, 1);

    // 3. 库内断言：两轨并存，各挂一条自己的 asr 版本（engine/source_url 落位），lan_doc 各带引擎名
    const detail = getVideo(db, 'bilibili', 'BV1')!;
    const trackA = detail.tracks.find((t) => t.lan === 'asr-zh-engine-a');
    const trackB = detail.tracks.find((t) => t.lan === 'asr-zh-engine-b');
    assert.ok(trackA, '引擎 A 轨存在');
    assert.ok(trackB, '引擎 B 轨存在');
    assert.notEqual(trackA.id, trackB.id, '两轨是各自独立的行');
    assert.equal(trackA.lan_doc, '中文（ASR·engine-a）');
    assert.equal(trackB.lan_doc, '中文（ASR·engine-b）');
    const verA = db.prepare('SELECT origin, asr_engine, source_url FROM subtitle_versions WHERE track_id = ?').get(trackA.id) as { origin: string; asr_engine: string; source_url: string };
    const verB = db.prepare('SELECT origin, asr_engine, source_url FROM subtitle_versions WHERE track_id = ?').get(trackB.id) as { origin: string; asr_engine: string; source_url: string };
    assert.equal(verA.asr_engine, 'engine-a');
    assert.equal(verB.asr_engine, 'engine-b');
    assert.equal(verA.source_url, 'asr://engine-a');
    assert.equal(verB.source_url, 'asr://engine-b');

    // 4. 同引擎重跑（A 再写同内容）→ 命中 body_hash 幂等去重，A 轨版本不堆积，B 轨不受影响
    const rA2 = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'engine-a', cues: cues() });
    assert.equal(rA2.json.inserted, 0);
    assert.equal(rA2.json.skipped, 1);
    const after = getVideo(db, 'bilibili', 'BV1')!;
    assert.equal(after.tracks.find((t) => t.lan === 'asr-zh-engine-a')!.versions.length, 1, '同引擎重跑版本不堆积');
    assert.equal(after.tracks.find((t) => t.lan === 'asr-zh-engine-b')!.versions.length, 1, 'B 轨不受 A 重跑影响');
  } finally {
    cleanup();
  }
});

test('asr submit 失败路径：404 视频 / 400 参数族（缺字段 / 空数组 / from≥to / 全空 content）', async () => {
  const { port, cleanup } = await setup();
  try {
    // 1. 视频不存在 → 404
    let r = await call(port, { source: 'bilibili', vid: 'BVnope', engine: 'e', cues: cues() });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /video not found/);

    // 2. 缺 engine → 400
    r = await call(port, { source: 'bilibili', vid: 'BV1', cues: cues() });
    assert.equal(r.status, 400);
    // 3. cues 空数组 → 400
    r = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'e', cues: [] });
    assert.equal(r.status, 400);
    // 4. from ≥ to → 400
    r = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'e', cues: [{ from: 3, to: 3, content: 'x' }] });
    assert.equal(r.status, 400);
    // 4b. from 负数 → 400
    r = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'e', cues: [{ from: -1, to: 1, content: 'x' }] });
    assert.equal(r.status, 400);
    // 4c. cues 条目非对象 / 字段类型不对（engine 数字）→ 400
    r = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'e', cues: ['not-an-object'] });
    assert.equal(r.status, 400);
    r = await call(port, { source: 'bilibili', vid: 'BV1', engine: 42, cues: cues() });
    assert.equal(r.status, 400);
    // 4d. cues 条目是对象但字段类型错（content 数字）→ 400
    r = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'e', cues: [{ from: 1, to: 2, content: 5 }] });
    assert.equal(r.status, 400);
    // 4e. 空串字段（engine 空串）→ 400
    r = await call(port, { source: 'bilibili', vid: 'BV1', engine: '', cues: cues() });
    assert.equal(r.status, 400);
    // 5. content 全空白 → 剔空后为空数组 → 400
    r = await call(port, { source: 'bilibili', vid: 'BV1', engine: 'e', cues: [{ from: 0, to: 1, content: '   ' }] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /all empty/);

    // 6. 非 submit 路径（GET 同路径）→ 404
    const res = await fetch(`http://127.0.0.1:${port}/api/asr/submit`);
    assert.equal(res.status, 404);
  } finally {
    cleanup();
  }
});
