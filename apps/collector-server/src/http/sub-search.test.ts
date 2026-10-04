// http/sub-search.ts 端点测试：GET /api/sub-search（CLI `sub search` 的 web 形态）。
// 覆盖：命中检索（items/snippets 结构、无 full 字段）/ keyword 校验 400 / 非法正则 400 /
// 数字参数校验 400 / since 非法 400 / max_snippets 截断 / all_tracks 全轨 / source 过滤 / 大小写敏感。
// 措辞：字幕（subtitle），非弹幕。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 命中结构/400 族/截断/all_tracks/source/大小写/非 GET 404 | 通过 | Phase 1 web 化 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { handleSubSearchHttp } from './sub-search.js';

function setup(): Promise<{ port: number; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-subsearch-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  // BV1：ai-en 默认轨，三行（hello 命中 1 段；alpha 命中 1 段）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '英文一', creator: { source_uid: '1', name: 'up' }, duration: 60, published_at: 1 },
    tracks: [{
      lan: 'ai-en', lan_doc: 'English',
      versions: [{ origin: 'external', payload: { body: [
        { from: 0, to: 2, content: 'alpha one' },
        { from: 4, to: 6, content: 'hello world' },
        { from: 8, to: 10, content: 'goodbye' },
      ] } }],
    }],
  });
  // BV2：ai-zh（track_type=1，优先级 1 → 默认轨）+ ai-en（非默认）——all_tracks 用例：
  // 命中词只在非默认的 ai-en 轨里，默认轨检索必落空、all_tracks=1 才命中
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV2', title: '双语', creator: { source_uid: '1', name: 'up' }, duration: 60, published_at: 1 },
    tracks: [
      { lan: 'ai-zh', lan_doc: '中文', track_type: 1, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 2, content: '你好世界' }] } }] },
      { lan: 'ai-en', lan_doc: 'English', versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 2, content: 'specialtoken only' }] } }] },
    ],
  });
  // BV3：youtube 平台（source 过滤用例）
  ingestVideo(db, {
    source: 'youtube',
    video: { source_vid: 'YT1', title: '英文二', creator: { source_uid: '2', name: 'up2' }, duration: 60, published_at: 1 },
    tracks: [{ lan: 'ai-en', lan_doc: 'English', versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 2, content: 'alpha two' }] } }] }],
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleSubSearchHttp(req, res, db);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}

async function call(port: number, query: string, method = 'GET'): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sub-search${query}`, { method });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('sub-search：命中检索——items 结构 + snippets 内容 + 不带 full 字段', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await call(port, '?keyword=hello');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.keyword, 'hello');
    assert.equal(r.json.regex, false);
    assert.equal(r.json.matched_videos, 1);
    assert.equal(r.json.total_snippets, 1);
    assert.equal(r.json.truncated, false);
    assert.equal(r.json.items.length, 1);
    const item = r.json.items[0];
    // video 元信息：刻意不含媒体字段（pic/链接），对齐 CLI 契约
    assert.equal(item.video.source, 'bilibili');
    assert.equal(item.video.source_vid, 'BV1');
    assert.equal(item.video.title, '英文一');
    assert.equal(item.video.creator_name, 'up');
    assert.equal(item.track.lan, 'ai-en');
    assert.equal(typeof item.version.id, 'number');
    assert.equal(item.snippets.length, 1);
    assert.equal(item.snippets[0].content, 'hello world');
    assert.equal(item.snippets[0].from, 4);
    assert.equal(item.snippets[0].to, 6);
    assert.equal(typeof item.snippets[0].context, 'string');
    // 未请求 full → 结构上无 full 字段（大文本 Phase 2 另走下载）
    assert.ok(!('full' in item));
  } finally { cleanup(); }
});

test('sub-search：keyword 缺失/超长 → 400', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await call(port, '');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /keyword query param required/);
    r = await call(port, `?keyword=${'长'.repeat(201)}`);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /keyword too long/);
    // 恰好 200 → 放行（0 命中也是合法结果）
    r = await call(port, `?keyword=${'长'.repeat(200)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.matched_videos, 0);
  } finally { cleanup(); }
});

test('sub-search：非法正则 → 400（透传「非法正则」文案）', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await call(port, '?keyword=(unclosed&regex=1');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /非法正则/);
  } finally { cleanup(); }
});

test('sub-search：数字参数非正数/非数字 → 400（ctx/max_snippets_per_video/max_snippets/max_videos）', async () => {
  const { port, cleanup } = await setup();
  try {
    for (const [name, value] of [['ctx', 'abc'], ['ctx', '0'], ['ctx', '-1'], ['max_snippets_per_video', 'abc'], ['max_snippets', '0'], ['max_videos', 'xyz']] as const) {
      const r = await call(port, `?keyword=hello&${name}=${value}`);
      assert.equal(r.status, 400, `${name}=${value} 应 400`);
      assert.match(r.json.error, new RegExp(`${name} must be a positive number`));
    }
    // max_videos 上限夹取：999 → 500（防全表扫 payload），仍是 200
    const r = await call(port, '?keyword=hello&max_videos=999');
    assert.equal(r.status, 200);
  } finally { cleanup(); }
});

test('sub-search：since/until 非数字 → 400（规格指定严格校验，不静默忽略）', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await call(port, '?keyword=hello&since=abc');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /since is not a number/);
    r = await call(port, '?keyword=hello&until=xyz');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /until is not a number/);
  } finally { cleanup(); }
});

test('sub-search：max_snippets 跨视频截断 → truncated=true', async () => {
  const { port, cleanup } = await setup();
  try {
    // alpha 命中 BV1 + YT2 两个视频各 1 段；cap=1 → 截 1 段并标 truncated
    const r = await call(port, '?keyword=alpha&max_snippets=1');
    assert.equal(r.status, 200);
    assert.equal(r.json.matched_videos, 1);
    assert.equal(r.json.total_snippets, 1);
    assert.equal(r.json.truncated, true);
    // cap 足够 → 不截断
    const r2 = await call(port, '?keyword=alpha');
    assert.equal(r2.json.matched_videos, 2);
    assert.equal(r2.json.total_snippets, 2);
    assert.equal(r2.json.truncated, false);
  } finally { cleanup(); }
});

test('sub-search：all_tracks=1 才检索非默认轨（命中词只在 BV2 的 ai-en 非默认轨）', async () => {
  const { port, cleanup } = await setup();
  try {
    // 默认轨口径（BV2 默认是 ai-zh）：specialtoken 落空
    let r = await call(port, '?keyword=specialtoken');
    assert.equal(r.status, 200);
    assert.equal(r.json.matched_videos, 0);
    // all_tracks=1：BV2 的 ai-en 轨命中
    r = await call(port, '?keyword=specialtoken&all_tracks=1');
    assert.equal(r.json.matched_videos, 1);
    assert.equal(r.json.items[0].video.source_vid, 'BV2');
    assert.equal(r.json.items[0].track.lan, 'ai-en');
  } finally { cleanup(); }
});

test('sub-search：source 过滤（bilibili 不含 youtube 的命中）+ creator 过滤', async () => {
  const { port, cleanup } = await setup();
  try {
    // 不筛平台：alpha 命中 BV1 + YT1
    let r = await call(port, '?keyword=alpha');
    assert.equal(r.json.matched_videos, 2);
    // source=bilibili → 只剩 BV1
    r = await call(port, '?keyword=alpha&source=bilibili');
    assert.equal(r.json.matched_videos, 1);
    assert.equal(r.json.items[0].video.source_vid, 'BV1');
    // source=youtube → 只剩 YT1
    r = await call(port, '?keyword=alpha&source=youtube');
    assert.equal(r.json.matched_videos, 1);
    assert.equal(r.json.items[0].video.source_vid, 'YT1');
    // creator 过滤
    r = await call(port, '?keyword=alpha&creator=up2');
    assert.equal(r.json.matched_videos, 1);
    assert.equal(r.json.items[0].video.creator_name, 'up2');
  } finally { cleanup(); }
});

test('sub-search：case_sensitive=1 区分大小写（HELLO 默认命中小写、敏感后落空）+ regex=1 正则命中', async () => {
  const { port, cleanup } = await setup();
  try {
    let r = await call(port, '?keyword=HELLO');
    assert.equal(r.json.matched_videos, 1, '默认大小写不敏感');
    r = await call(port, '?keyword=HELLO&case_sensitive=1');
    assert.equal(r.json.matched_videos, 0, '敏感后大小写不合落空');
    // 正则模式：hello|goodbye 只在 BV1 两行（YT1 无这两个词）
    r = await call(port, '?keyword=hello%7Cgoodbye&regex=1');
    assert.equal(r.status, 200);
    assert.equal(r.json.regex, true);
    assert.equal(r.json.matched_videos, 1);
  } finally { cleanup(); }
});

test('sub-search：非 GET 方法 → 404', async () => {
  const { port, cleanup } = await setup();
  try {
    const r = await call(port, '?keyword=hello', 'POST');
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});
