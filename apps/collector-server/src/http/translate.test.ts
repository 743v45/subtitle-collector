// http/translate.ts 端点测试：POST /api/translate/fill 全链路 + GET /api/translate/pending + GET /api/translate/source/:source/:vid。
// 覆盖：成功写回（时间轴拷贝/默认轨生效/manual 语义）+ 四条失败路径（404 视频/404 源轨/400 行数/400 参数）+ 二次 fill 版本堆积；
// pending：清单/langs 行数标注/source·from 过滤/sort·时间参数 400/补翻完成后缺口清零；
// source：结构化行+text 拼回/显式 from/404 视频/404 轨带 available_lans/400 默认轨已中文。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | fill 成功×2（含二次 fill）+ 404×2 + 400×2 + 默认轨优先级断言 | 通过 | |
// | R2 | pending 全参数矩阵 + source 全错误路径映射（Phase 1 web 化） | 通过 | BV3 仅中文轨种子加入 |

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
  // BV3：仅 ai-zh 轨（source 端点「默认轨已中文 → 400」用例；pending 因已有中文排除）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV3', title: '仅中文轨', creator: { source_uid: '1', name: 'up' }, duration: 10, published_at: 1700000000000 },
    tracks: [{ lan: 'ai-zh', lan_doc: '中文', track_type: 1, versions: [{ origin: 'external', payload: enPayload() }] }],
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

// 通用 GET/POST（pending / source 路由用）
async function callPath(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

test('translate pending：清单 + langs 行数标注 + source/from 过滤 + 补翻完成后缺口清零', async () => {
  const { port, cleanup } = await setup();
  try {
    // 1. 全量清单：BV1（ai-en，无中文）命中；BV2/BV3 已有中文被排除
    let r = await callPath(port, 'GET', '/api/translate/pending');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.total, 1);
    assert.equal(r.json.page, 1);
    assert.equal(r.json.size, 20);
    assert.equal(r.json.items.length, 1);
    const item = r.json.items[0];
    assert.equal(item.source, 'bilibili');
    assert.equal(item.source_vid, 'BV1');
    assert.equal(item.title, '英文无中文');
    assert.equal(item.creator_name, 'up');
    // langs 逐轨标注行数（enPayload 三行；每轨一个默认版本）
    assert.deepEqual(item.langs, [{ lan: 'ai-en', lan_doc: 'English', lines: 3 }]);

    // 2. source 过滤（非命中平台 → 空页）
    r = await callPath(port, 'GET', '/api/translate/pending?source=youtube');
    assert.equal(r.json.total, 0);
    assert.deepEqual(r.json.items, []);

    // 3. from 过滤（有 ai-en 轨才列）
    r = await callPath(port, 'GET', '/api/translate/pending?from=ai-en');
    assert.equal(r.json.total, 1);
    r = await callPath(port, 'GET', '/api/translate/pending?from=ai-ja');
    assert.equal(r.json.total, 0);

    // 4. creator 过滤（模糊命中/不命中）
    r = await callPath(port, 'GET', '/api/translate/pending?creator=nope');
    assert.equal(r.json.total, 0);
    r = await callPath(port, 'GET', '/api/translate/pending?creator=up');
    assert.equal(r.json.total, 1);

    // 5. 分页：size=1 取第一页仍是 BV1（total 不随分页变）
    r = await callPath(port, 'GET', '/api/translate/pending?page=1&size=1');
    assert.equal(r.json.total, 1);
    assert.equal(r.json.size, 1);
    assert.equal(r.json.items[0].source_vid, 'BV1');

    // 6. 补翻完成后缺口清零（fill 写入 zh-manual → pending 排除）
    const f = await call(port, { source: 'bilibili', source_vid: 'BV1', from_lan: 'ai-en', lines: ['你好世界', '第二行', ''] });
    assert.equal(f.status, 200);
    r = await callPath(port, 'GET', '/api/translate/pending');
    assert.equal(r.json.total, 0);
  } finally {
    cleanup();
  }
});

test('translate pending：非法 sort/since/until → 400；合法时间窗过滤生效', async () => {
  const { port, cleanup } = await setup();
  try {
    // sort 非法键 → 400
    let r = await callPath(port, 'GET', '/api/translate/pending?sort=title');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /first_seen\|published_at/);
    // since/until 非数字 → 400（静默忽略=「以为筛了其实没筛」暗坑，规格定为严格 400）
    r = await callPath(port, 'GET', '/api/translate/pending?since=abc');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /since is not a number/);
    r = await callPath(port, 'GET', '/api/translate/pending?until=xyz');
    assert.equal(r.status, 400);
    // 合法时间窗：BV1 first_seen 为「现在附近」，未来下界 → 空
    r = await callPath(port, 'GET', `/api/translate/pending?since=${Date.now() + 60_000}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 0);
    // 合法时间窗：过去下界 → 命中
    r = await callPath(port, 'GET', `/api/translate/pending?since=${Date.now() - 60_000}`);
    assert.equal(r.json.total, 1);
  } finally {
    cleanup();
  }
});

test('translate source：结构化行 + text 拼回 + 显式 from；404 视频/轨（带 available_lans）/ 400 已中文', async () => {
  const { port, cleanup } = await setup();
  try {
    // 1. 缺省 from：取优先级首个非中文轨（BV1 仅 ai-en）
    let r = await callPath(port, 'GET', '/api/translate/source/bilibili/BV1');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.source, 'bilibili');
    assert.equal(r.json.source_vid, 'BV1');
    assert.equal(r.json.lan, 'ai-en');
    assert.equal(typeof r.json.version_id, 'number');
    // 结构化行：line 从 1 起、text 剥占位空行无换行（enPayload 三行）
    assert.deepEqual(r.json.lines, [
      { line: 1, text: 'Hello world' },
      { line: 2, text: 'Second line' },
      { line: 3, text: '' },
    ]);
    // text = tab 拼回（CLI stdout 原契约）
    assert.equal(r.json.text, '1\tHello world\n2\tSecond line\n3\t\n');

    // 2. 显式 from 精确匹配
    r = await callPath(port, 'GET', '/api/translate/source/bilibili/BV1?from=ai-en');
    assert.equal(r.status, 200);
    assert.equal(r.json.lan, 'ai-en');

    // 3. 视频不存在 → 404
    r = await callPath(port, 'GET', '/api/translate/source/bilibili/BVnope');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /视频不存在/);

    // 4. 轨不存在 → 404 + available_lans
    r = await callPath(port, 'GET', '/api/translate/source/bilibili/BV1?from=ai-ja');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /源轨不存在/);
    assert.deepEqual(r.json.available_lans, ['ai-en']);

    // 5. 默认轨已是中文 → 400（BV3 仅 ai-zh；确需重翻显式 from）
    r = await callPath(port, 'GET', '/api/translate/source/bilibili/BV3');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /已是中文/);
    // 显式 from 指向中文轨 → 允许（重翻自由）
    r = await callPath(port, 'GET', '/api/translate/source/bilibili/BV3?from=ai-zh');
    assert.equal(r.status, 200);
    assert.equal(r.json.lan, 'ai-zh');

    // 6. URL 编码路径段正常解码
    r = await callPath(port, 'GET', '/api/translate/source/bilibili/%42V1');
    assert.equal(r.status, 200);
    assert.equal(r.json.source_vid, 'BV1');
  } finally {
    cleanup();
  }
});
