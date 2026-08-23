// http/translate.ts 端点测试：POST /api/translate/fill 全链路。
// 覆盖：成功写回（时间轴拷贝/默认轨生效/manual 语义）+ 四条失败路径（404 视频/404 源轨/400 行数/400 参数）+ 二次 fill 版本堆积。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 成功×2（含二次 fill）+ 404×2 + 400×2 + 默认轨优先级断言 | 通过 | |

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
import { getVideo } from '../db/queries.js';
import { handleTranslateHttp } from './translate.js';

// B 站 payload 样例：body 三行（第三行空文本——占位行契约）
function enPayload(): unknown {
  return {
    font_size: 0.4, background_color: '#9C27B0', type: 'AIsubtitle', lang: 'en',
    body: [
      { from: 0.04, to: 2.56, sid: 0, content: 'Hello world' },
      { from: 4.56, to: 5.52, sid: 1, content: 'Second line' },
      { from: 6.0, to: 7.0, sid: 2, content: '' },
    ],
  };
}

// 起 handler 直挂的测试 server（不经 main.ts 的 Origin 守卫，聚焦 handler 逻辑；对齐 tags.test.ts 范式）
function setup(): Promise<{ port: number; db: Database.Database; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-translate-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  // BV1：ai-en 轨（pending 目标）；BV2：已有 ai-zh 轨（fill 不拦但默认轨不受影响）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '英文无中文', creator: { source_uid: '1', name: 'up' }, duration: 10, published_at: 1700000000000 },
    tracks: [{ lan: 'ai-en', lan_doc: 'English', versions: [{ origin: 'external', payload: enPayload() }] }],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV2', title: '已有中文', creator: { source_uid: '1', name: 'up' }, duration: 10, published_at: 1700000000000 },
    tracks: [
      { lan: 'ai-en', lan_doc: 'English', versions: [{ origin: 'external', payload: enPayload() }] },
      { lan: 'ai-zh', lan_doc: '中文', versions: [{ origin: 'external', payload: enPayload() }] },
    ],
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleTranslateHttp(req, res, db);
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
  const res = await fetch(`http://127.0.0.1:${port}/api/translate/fill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('translate fill：成功写回（时间轴拷贝 + zh-manual 默认轨 + manual 不去重）', async () => {
  const { port, db, cleanup } = await setup();
  try {
    // 1. 首次 fill 成功
    let r = await call(port, { source: 'bilibili', source_vid: 'BV1', from_lan: 'ai-en', lines: ['你好世界', '第二行', ''] });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.lines, 3);
    assert.equal(r.json.zh_manual_versions_before, 0);

    // 2. 库内断言：zh-manual 轨一条 + manual 版本一条，payload 时间轴/sid 全拷贝、content 换译文、元数据沿用
    const detail = getVideo(db, 'bilibili', 'BV1')!;
    const zhTrack = detail.tracks.find((t) => t.lan === 'zh-manual');
    assert.ok(zhTrack, 'zh-manual 轨已写入');
    assert.equal(zhTrack.lan_doc, '中文（补翻）');
    assert.equal(zhTrack.versions.length, 1);
    const verRow = db.prepare('SELECT payload, source_url, origin FROM subtitle_versions WHERE track_id = ?').get(zhTrack.id) as { payload: string; source_url: string; origin: string };
    assert.equal(verRow.origin, 'manual');
    assert.equal(verRow.source_url, 'translate://ai-en');
    const payload = JSON.parse(verRow.payload);
    assert.equal(payload.type, 'AIsubtitle', '顶层元数据沿用源 payload');
    assert.deepEqual(payload.body, [
      { from: 0.04, to: 2.56, sid: 0, content: '你好世界' },
      { from: 4.56, to: 5.52, sid: 1, content: '第二行' },
      { from: 6.0, to: 7.0, sid: 2, content: '' },
    ], '时间轴/sid 拷贝 + content 逐行替换（空行占位保留）');

    // 3. 默认轨生效：zh-manual（优先级 1.5）排在 ai-en 前——补翻完成后默认轨变中文
    assert.equal(detail.tracks[0].lan, 'zh-manual');

    // 4. 二次 fill：manual 不去重 → 版本堆积为 2，轨仍一条，响应带堆积计数
    r = await call(port, { source: 'bilibili', source_vid: 'BV1', from_lan: 'ai-en', lines: ['你好世界', '第二行', ''] });
    assert.equal(r.status, 200);
    assert.equal(r.json.zh_manual_versions_before, 1);
    const detail2 = getVideo(db, 'bilibili', 'BV1')!;
    assert.equal(detail2.tracks.filter((t) => t.lan === 'zh-manual').length, 1, '轨 upsert 不重复建');
    assert.equal(detail2.tracks.find((t) => t.lan === 'zh-manual')!.versions.length, 2, '版本按 manual 语义堆积快照');

    // 5. 已有 ai-zh 的视频 fill 不拦（显式重翻自由）。B 站轨无 track_type（原优先级落 5 档），
    //    zh-manual 档位 1.5 反超之——显式重翻的语义就是补翻轨接管默认导出，符合预期。
    r = await call(port, { source: 'bilibili', source_vid: 'BV2', from_lan: 'ai-en', lines: ['你好世界', '第二行', ''] });
    assert.equal(r.status, 200);
    assert.equal(getVideo(db, 'bilibili', 'BV2')!.tracks[0].lan, 'zh-manual');
  } finally {
    cleanup();
  }
});

test('translate fill 失败路径：404 视频 / 404 源轨（带可用轨清单）/ 400 行数 / 400 参数', async () => {
  const { port, cleanup } = await setup();
  try {
    // 1. 视频不存在 → 404
    let r = await call(port, { source: 'bilibili', source_vid: 'BVnope', from_lan: 'ai-en', lines: ['x'] });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /video not found/);

    // 2. 源轨不存在 → 404 + available_lans（可观察性：直接看出可用轨）
    r = await call(port, { source: 'bilibili', source_vid: 'BV1', from_lan: 'ai-ja', lines: ['x', 'y', 'z'] });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /source track not found: lan=ai-ja/);
    assert.deepEqual(r.json.available_lans, ['ai-en']);

    // 3. 行数不符 → 400 + expected/got
    r = await call(port, { source: 'bilibili', source_vid: 'BV1', from_lan: 'ai-en', lines: ['只有一行'] });
    assert.equal(r.status, 400);
    assert.equal(r.json.expected, 3);
    assert.equal(r.json.got, 1);
    assert.match(r.json.error, /3 行.*1 行/);

    // 4. 参数校验：缺 from_lan / lines 空数组 / lines 非全 string → 400
    r = await call(port, { source: 'bilibili', source_vid: 'BV1', lines: ['x'] });
    assert.equal(r.status, 400);
    r = await call(port, { source: 'bilibili', source_vid: 'BV1', from_lan: 'ai-en', lines: [] });
    assert.equal(r.status, 400);
    r = await call(port, { source: 'bilibili', source_vid: 'BV1', from_lan: 'ai-en', lines: ['x', 42] });
    assert.equal(r.status, 400);

    // 5. 非 fill 路径（GET 同路径）→ 404
    const res = await fetch(`http://127.0.0.1:${port}/api/translate/fill`);
    assert.equal(res.status, 404);
  } finally {
    cleanup();
  }
});
