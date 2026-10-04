// http/collect-proxy.ts 三端点测试：POST /api/collect-search、POST /api/season/preview、POST /api/upper-info/refresh
// （CLI 全功能 web 化 Phase 3——server 白名单选 action 驱动扩展的编排层）。
// 覆盖：每端点的参数校验 400 / 无在线 503 / 扩展失败 502（need_login 透传、unknown action 版本过旧提示）/
// 成功路径下发参数对齐 CLI（action 与 params 逐字段断言）+ exists/has_subtitle 标注（内存库播种）。
// mock 方式：createCollectProxyHandler(deps) 在 requestCommand/listOnlineClients 层注入（不起真扩展 WS，
// 对齐 tasks/wsBridge 注入先例）；timeout 断言对齐 CLI DEFAULT_COLLECT_TIMEOUT_MS=180000。
// 措辞：字幕（subtitle），非弹幕。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 三端点成功+标注 / 400 族 / 503 / 502 / 504 / 404 | 通过 | Phase 3 web 化 |

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
import { createCollectProxyHandler, type CollectProxyDeps } from './collect-proxy.js';
import { runHandler } from './http-util.js';

// ── mock 依赖与 HTTP 测试底座 ──

interface SentCommand { clientId: string; action: string; params: Record<string, unknown>; timeout?: number }
// reply：按下发命令决定 mock 扩展的回执（ok+data / ok:false+error / offline / timeout）
type MockReply = { ok: true; data?: unknown } | { ok: false; error: string } | { offline: true } | { timeout: true };

function makeDeps(opts: { online?: string[]; reply?: (cmd: { action: string; params: Record<string, unknown> }) => MockReply }): {
  deps: CollectProxyDeps; sent: SentCommand[];
} {
  const sent: SentCommand[] = [];
  const deps: CollectProxyDeps = {
    requestCommand: async (clientId, action, params, timeoutMs) => {
      sent.push({ clientId, action, params, timeout: timeoutMs });
      const r = opts.reply?.({ action, params }) ?? { ok: true, data: {} };
      if ('offline' in r) return { ok: false, code: 'offline' };
      if ('timeout' in r) return { ok: false, code: 'timeout' };
      if (r.ok) return { ok: true, result: { ok: true, data: r.data } }; // 对齐 ws/server：result 是整条 WS 消息
      return { ok: true, result: { ok: false, error: r.error } };
    },
    listOnlineClients: () => (opts.online ?? ['ext-1']).map((client_id) => ({ client_id })),
  };
  return { deps, sent };
}

function setup(mock: Parameters<typeof makeDeps>[0]): Promise<{ port: number; sent: SentCommand[]; db: Database.Database; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-collectproxy-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  // BV1：bilibili 已入库 + 有字幕轨（标注 exists=true/has_subtitle=true）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '有字幕', creator: { source_uid: '1', name: 'up' }, duration: 60, published_at: 1 },
    tracks: [{ lan: 'ai-zh', lan_doc: '中文', versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 2, content: '你好' }] } }] }],
  });
  // BV2：bilibili 已入库、无字幕轨（标注 exists=true/has_subtitle=false——无字幕视频也入库）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV2', title: '无字幕', creator: { source_uid: '1', name: 'up' }, duration: 60, published_at: 1 },
    tracks: [],
  });
  // BV16i4y1s7Qj：带 ugc_season.id=777（season/preview 的 BV 号路径：库内 extra.ugc_season.id 取合集 id）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV16i4y1s7Qj', title: '合集内视频', creator: { source_uid: '1', name: 'up' }, duration: 60, published_at: 1, extra: { ugc_season: { id: 777, title: '测试合集' } } },
    tracks: [],
  });
  // YT1：youtube 已入库 + 有字幕轨（yt-search 的 vid 标注）
  ingestVideo(db, {
    source: 'youtube',
    video: { source_vid: 'YT1', title: 'yt 有字幕', creator: { source_uid: '2', name: 'up2' }, duration: 60, published_at: 1 },
    tracks: [{ lan: 'ai-en', lan_doc: 'English', versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 2, content: 'hello' }] } }] }],
  });
  const { deps, sent } = makeDeps(mock);
  const handler = createCollectProxyHandler(deps);
  // 与 main.ts 分发一致包 runHandler：handler 内 HttpError（503/502/504 路径）靠它落响应，
  // 否则 fetch 永久挂起（本次 R1 首跑即栽在这里——失败路径全无输出）
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void runHandler(res, () => handler(req, res, db)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port, sent, db,
        cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
      });
    });
  });
}

async function call(port: number, path: string, body?: unknown, method = 'POST'): Promise<{ status: number; json: any }> {
  const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ── POST /api/collect-search ──

test('collect-search bilibili：成功路径——search 下发参数对齐 CLI + exists/has_subtitle 标注', async () => {
  const { port, sent, cleanup } = await setup({
    reply: () => ({ ok: true, data: { total: 3, items: [
      { bvid: 'BV1', title: '有字幕', up: 'up', mid: 1, play: 10, duration: 60, pubdate: 1 },
      { bvid: 'BV2', title: '无字幕', up: 'up', mid: 1, play: 11, duration: 61, pubdate: 2 },
      { bvid: 'BV9', title: '未采集', up: 'up', mid: 1, play: 12, duration: 62, pubdate: 3 },
    ] } }),
  });
  try {
    const r = await call(port, '/api/collect-search', { source: 'bilibili', keyword: '测试' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.source, 'bilibili');
    assert.equal(r.json.keyword, '测试');
    assert.equal(r.json.client_id, 'ext-1');
    assert.equal(r.json.total, 3);
    // 下发断言：action=search，params 对齐 cli collectSearch（page 缺省 1、order 缺省 pubdate、不带 tid）、timeout 对齐 CLI 180000
    assert.equal(sent.length, 1);
    assert.equal(sent[0].clientId, 'ext-1');
    assert.equal(sent[0].action, 'search');
    assert.deepEqual(sent[0].params, { keyword: '测试', page: 1, order: 'pubdate' });
    assert.equal(sent[0].timeout, 180000);
    // 标注断言：BV1 有字幕 / BV2 无字幕（已入库）/ BV9 未入库
    assert.equal(r.json.items[0].bvid, 'BV1');
    assert.equal(r.json.items[0].exists, true);
    assert.equal(r.json.items[0].has_subtitle, true);
    assert.equal(r.json.items[1].exists, true);
    assert.equal(r.json.items[1].has_subtitle, false);
    assert.equal(r.json.items[2].exists, false);
    assert.equal(r.json.items[2].has_subtitle, false);
  } finally { cleanup(); }
});

test('collect-search bilibili：order 覆盖与 tid 透传', async () => {
  const { port, sent, cleanup } = await setup({ reply: () => ({ ok: true, data: { items: [{ bvid: 'BV1' }] } }) });
  try {
    const r = await call(port, '/api/collect-search', { source: 'bilibili', keyword: 'k', order: 'click', tid: 21 });
    assert.equal(r.status, 200);
    assert.deepEqual(sent[0].params, { keyword: 'k', page: 1, order: 'click', tid: 21 });
  } finally { cleanup(); }
});

test('collect-search：参数校验 400 族——source/keyword/旋钮归属/枚举/越界', async () => {
  // reply 供「合法边界放行」的两个 200 用例；400 族全部在校验层拦下，不触碰 reply
  const { port, sent, cleanup } = await setup({ reply: () => ({ ok: true, data: { items: [{ bvid: 'BV1', vid: 'YT1' }] } }) });
  try {
    const cases: Array<[unknown, RegExp]> = [
      [{ source: 'douyin', keyword: 'k' }, /source must be/],                       // 平台白名单只有两档
      [{ source: 'bilibili' }, /keyword/],                                          // keyword 缺失
      [{ source: 'bilibili', keyword: '' }, /keyword/],
      [{ source: 'bilibili', keyword: '长'.repeat(101) }, /keyword too long/],      // ≤100
      [{ source: 'youtube', keyword: 'k', tid: 21 }, /tid only applies/],            // tid 是 bilibili 旋钮
      [{ source: 'bilibili', keyword: 'k', pages: 2 }, /pages only applies/],       // pages 是 youtube 旋钮
      [{ source: 'bilibili', keyword: 'k', since_days: 7 }, /since_days only applies/],
      [{ source: 'youtube', keyword: 'k', order: 'bogus' }, /order must be/],       // youtube 枚举校验（对齐 CLI）
      [{ source: 'youtube', keyword: 'k', pages: 0 }, /positive integer/],          // 0 = 非正数，落整数校验
      [{ source: 'youtube', keyword: 'k', pages: 6 }, /pages must be 1\.\.5/],      // 上限 5（web 形态比 CLI 1..10 收紧）
      [{ source: 'youtube', keyword: 'k', pages: 1.5 }, /positive integer/],
      [{ source: 'youtube', keyword: 'k', since_days: 0 }, /positive integer/],
      [{ source: 'youtube', keyword: 'k', since_days: 366 }, /since_days must be 1\.\.365/],
      [{ source: 'bilibili', keyword: 'k', tid: -1 }, /positive integer/],
    ];
    for (const [body, re] of cases) {
      const r = await call(port, '/api/collect-search', body);
      assert.equal(r.status, 400, `应 400: ${JSON.stringify(body)}`);
      assert.match(r.json.error, re, `错误文案应匹配: ${JSON.stringify(body)}`);
    }
    assert.equal(sent.length, 0, '校验失败不应下发任何扩展命令');
    // 合法边界放行：pages=5 / since_days=365 / bilibili order 不校验枚举（对齐 CLI 透传）
    let r = await call(port, '/api/collect-search', { source: 'youtube', keyword: 'k', pages: 5, since_days: 365 });
    assert.equal(r.status, 200);
    r = await call(port, '/api/collect-search', { source: 'bilibili', keyword: 'k', order: 'anything' });
    assert.equal(r.status, 200);
  } finally { cleanup(); }
});

test('collect-search：无在线扩展 → 503（不触碰 requestCommand）', async () => {
  const { port, sent, cleanup } = await setup({ online: [] });
  try {
    const r = await call(port, '/api/collect-search', { source: 'bilibili', keyword: 'k' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'no online client（扩展未连接）');
    assert.equal(sent.length, 0);
  } finally { cleanup(); }
});

test('collect-search：扩展失败 502——need_login 原样透传；unknown action 带版本过旧提示', async () => {
  const { port, cleanup } = await setup({ reply: () => ({ ok: false, error: 'need_login' }) });
  try {
    const r = await call(port, '/api/collect-search', { source: 'bilibili', keyword: 'k' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'need_login', '硬停类错误原样透传给上层解读');
  } finally { cleanup(); }
  const { port: p2, cleanup: c2 } = await setup({ reply: () => ({ ok: false, error: 'unknown action: search' }) });
  try {
    const r = await call(p2, '/api/collect-search', { source: 'bilibili', keyword: 'k' });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /扩展版本过旧/);
    assert.match(r.json.error, /unknown action: search/);
  } finally { c2(); }
});

test('collect-search：回执结构漂移——items 非数组 → 502（不盲猜直接报）', async () => {
  const { port, cleanup } = await setup({ reply: () => ({ ok: true, data: { total: 5 } }) });
  try {
    const r = await call(port, '/api/collect-search', { source: 'bilibili', keyword: 'k' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'extension receipt malformed: items is not an array');
  } finally { cleanup(); }
});

test('collect-search：传输层失败——offline → 503 / timeout → 504', async () => {
  const { port, cleanup } = await setup({ reply: () => ({ offline: true }) });
  try {
    const r = await call(port, '/api/collect-search', { source: 'bilibili', keyword: 'k' });
    assert.equal(r.status, 503);
  } finally { cleanup(); }
  const { port: p2, cleanup: c2 } = await setup({ reply: () => ({ timeout: true }) });
  try {
    const r = await call(p2, '/api/collect-search', { source: 'youtube', keyword: 'k' });
    assert.equal(r.status, 504);
    assert.equal(r.json.error, 'extension result timeout');
  } finally { c2(); }
});

test('collect-search youtube：成功路径——yt-search 参数对齐 + since_days 本地过滤（created null 保留）+ vid 标注', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { port, sent, cleanup } = await setup({
    reply: () => ({ ok: true, data: {
      raw_total: 3, pages_fetched: 2, diag: { parsed: 3 },
      items: [
        { vid: 'YT1', title: '新且有字幕', created: now - 3600, play: 100, length: '10:00', pic: 'p1' },
        { vid: 'YTX', title: '太旧', created: now - 10 * 86400, play: 200, length: '5:00', pic: 'p2' },
        { vid: 'YTN', title: '时间解析失败', created: null, play: 300, length: null, pic: null },
      ],
    } }),
  });
  try {
    const r = await call(port, '/api/collect-search', { source: 'youtube', keyword: 'hello', order: 'views', pages: 2, since_days: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.source, 'youtube');
    assert.equal(r.json.client_id, 'ext-1');
    // 下发断言：action=yt-search，params 对齐 cli collectYtSearch（since_days 不下发——CLI 侧本地过滤）
    assert.equal(sent[0].action, 'yt-search');
    assert.deepEqual(sent[0].params, { keyword: 'hello', order: 'views', pages: 2 });
    // since_days 过滤：YTX（10 天前）被滤掉；YTN（created=null）保留（对齐 filterYtBySince 防漏采口径）
    assert.equal(r.json.since_days, 1);
    assert.equal(r.json.since_filtered, 1);
    assert.equal(r.json.total, 2);
    assert.deepEqual(r.json.items.map((it: any) => it.vid), ['YT1', 'YTN']);
    assert.equal(r.json.items[0].exists, true);
    assert.equal(r.json.items[0].has_subtitle, true);
    assert.equal(r.json.items[1].exists, false);
    // 解析命中计数透传（对齐 CLI summary 的可观察性字段）
    assert.equal(r.json.raw_total, 3);
    assert.equal(r.json.pages_fetched, 2);
    assert.deepEqual(r.json.diag, { parsed: 3 });
  } finally { cleanup(); }
});

// ── POST /api/season/preview ──

test('season/preview：成功路径（纯数字合集 id）——list-season-videos 下发 + bvid 标注 + season 回显', async () => {
  const { port, sent, cleanup } = await setup({
    reply: () => ({ ok: true, data: { season_id: 777, mid: 42, total: 2, items: [
      { bvid: 'BV1', title: '合集视频一', created: 1, play: 1, length: '1:00', pic: 'p' },
      { bvid: 'BV9', title: '合集视频二', created: 2, play: 2, length: '2:00', pic: 'q' },
    ] } }),
  });
  try {
    const r = await call(port, '/api/season/preview', { arg: '777' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.season, { id: 777, mid: 42 });
    assert.equal(r.json.client_id, 'ext-1');
    assert.equal(r.json.total, 2);
    assert.equal(sent[0].action, 'list-season-videos');
    assert.deepEqual(sent[0].params, { season_id: 777 });
    assert.equal(sent[0].timeout, 180000);
    assert.equal(r.json.items[0].bvid, 'BV1');
    assert.equal(r.json.items[0].exists, true);
    assert.equal(r.json.items[0].has_subtitle, true);
    assert.equal(r.json.items[1].exists, false);
  } finally { cleanup(); }
});

test('season/preview：BV 号路径——库内 ugc_season 命中；未采集过的 BV → 404', async () => {
  const { port, sent, cleanup } = await setup({ reply: () => ({ ok: true, data: { mid: 42, items: [{ bvid: 'BV1' }] } }) });
  try {
    // BV16i4y1s7Qj 已采过且 extra.ugc_season.id=777 → 解析出合集 id 再下发
    const r = await call(port, '/api/season/preview', { arg: 'BV16i4y1s7Qj' });
    assert.equal(r.status, 200);
    assert.equal(r.json.season.id, 777);
    assert.deepEqual(sent[0].params, { season_id: 777 });
  } finally { cleanup(); }
  const { port: p2, cleanup: c2 } = await setup({});
  try {
    // BV + 10 位合法形态但库里没有 → 404（对齐 CLI「BV 未采集过,库内无合集归属」）
    const r = await call(p2, '/api/season/preview', { arg: 'BV1zzzzzzzzz' });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /库内无合集归属/);
  } finally { c2(); }
});

test('season/preview：参数校验 400 族——arg 缺失/空白/无法识别', async () => {
  const { port, sent, cleanup } = await setup({});
  try {
    let r = await call(port, '/api/season/preview', {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /arg/);
    r = await call(port, '/api/season/preview', { arg: '   ' });
    assert.equal(r.status, 400);
    r = await call(port, '/api/season/preview', { arg: 'hello world' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /无法识别合集参数/);
    r = await call(port, '/api/season/preview', { arg: 'https://space.bilibili.com/1/channel/collectiondetail?other=1' });
    assert.equal(r.status, 400, 'URL 无 sid/season_id 也算无法识别');
    assert.equal(sent.length, 0);
  } finally { cleanup(); }
});

test('season/preview：无在线 503 / 扩展失败 502（unknown action 版本过旧 + 空展开）', async () => {
  const { port, sent, cleanup } = await setup({ online: [] });
  try {
    const r = await call(port, '/api/season/preview', { arg: '777' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'no online client（扩展未连接）');
    assert.equal(sent.length, 0);
  } finally { cleanup(); }
  const { port: p2, cleanup: c2 } = await setup({ reply: () => ({ ok: false, error: 'unknown action: list-season-videos' }) });
  try {
    const r = await call(p2, '/api/season/preview', { arg: '777' });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /扩展版本过旧/);
  } finally { c2(); }
  const { port: p3, cleanup: c3 } = await setup({ reply: () => ({ ok: true, data: { mid: 1, items: [] } }) });
  try {
    // 空展开 = 合集不存在或扩展拉取失败，对齐 CLI 按失败报（不空手 200）
    const r = await call(p3, '/api/season/preview', { arg: '777' });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /展开结果为空/);
  } finally { c3(); }
});

// ── POST /api/upper-info/refresh ──

test('upper-info/refresh：成功路径——get-upper-info 单 action 下发 + creator 透传', async () => {
  const { port, sent, cleanup } = await setup({
    reply: () => ({ ok: true, data: {
      mid: '42', source_uid: '42', name: '某UP主', avatar: 'http://a', sign: '简介', level: 6, sex: '保密',
      official_type: -1, official_title: '', fans: 1234, following: 10, stat_failed: false,
    } }),
  });
  try {
    const r = await call(port, '/api/upper-info/refresh', { mid: '42' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.client_id, 'ext-1');
    // 只发一个 action：ingest-upper 由扩展自己推（background.js），server 无第二步
    assert.equal(sent.length, 1);
    assert.equal(sent[0].action, 'get-upper-info');
    assert.deepEqual(sent[0].params, { mid: '42' });
    assert.equal(sent[0].timeout, 180000);
    assert.equal(r.json.creator.name, '某UP主');
    assert.equal(r.json.creator.fans, 1234);
    assert.equal(r.json.creator.stat_failed, false);
  } finally { cleanup(); }
});

test('upper-info/refresh：mid 校验 400——缺失/非数字/带符号/数字类型', async () => {
  const { port, sent, cleanup } = await setup({});
  try {
    for (const body of [{}, { mid: '' }, { mid: 'abc' }, { mid: '-5' }, { mid: '4 2' }, { mid: 42 }]) {
      const r = await call(port, '/api/upper-info/refresh', body);
      assert.equal(r.status, 400, `应 400: ${JSON.stringify(body)}`);
      assert.match(r.json.error, /mid/);
    }
    assert.equal(sent.length, 0);
  } finally { cleanup(); }
});

test('upper-info/refresh：无在线 503 / 扩展失败 502 / 回执非对象 502', async () => {
  const { port, cleanup } = await setup({ online: [] });
  try {
    const r = await call(port, '/api/upper-info/refresh', { mid: '42' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'no online client（扩展未连接）');
  } finally { cleanup(); }
  const { port: p2, cleanup: c2 } = await setup({ reply: () => ({ ok: false, error: 'risk_control' }) });
  try {
    const r = await call(p2, '/api/upper-info/refresh', { mid: '42' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'risk_control');
  } finally { c2(); }
  const { port: p3, cleanup: c3 } = await setup({ reply: () => ({ ok: true, data: null }) });
  try {
    const r = await call(p3, '/api/upper-info/refresh', { mid: '42' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'extension receipt malformed: data is not an object');
  } finally { c3(); }
});

// ── 路由与方法收口 ──

test('非 POST 方法与未登记路径 → 404（白名单编排不扩散）', async () => {
  const { port, sent, cleanup } = await setup({});
  try {
    let r = await call(port, '/api/collect-search', { source: 'bilibili', keyword: 'k' }, 'GET');
    assert.equal(r.status, 404);
    r = await call(port, '/api/season', { arg: '777' });
    assert.equal(r.status, 404, '/api/season 本体未登记（只有 /preview 子路径）');
    r = await call(port, '/api/upper-info', { mid: '42' });
    assert.equal(r.status, 404);
    r = await call(port, '/api/collect-search/extra', { source: 'bilibili', keyword: 'k' });
    assert.equal(r.status, 404);
    assert.equal(sent.length, 0);
  } finally { cleanup(); }
});
