// collect.ts commander 装配层测试：子进程跑真 CLI + 本地 mock HTTP server（路由按 body.action 分发），
// 覆盖十个 action 的成功路径、--timeout/--since-days/--min-fans/--since 等校验、HTTP 错误归一化
// （SERVER_UNREACHABLE / ExtCommandError→RUNTIME / 404→NOT_FOUND / no online client→ARGS）与 DB 分支。
// 纯函数（parseSeasonArg/collectDedupe/collectFind/resolveFans 等）见 collect.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | search/subtitle/dedupe/season/upper-info/upper-videos/yt-videos/new-videos/discover/find 全 action | 通过 | 长流程逐分支喂 mock 响应 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/cli/commands
const MAIN_TS = join(HERE, '..', 'main.ts');
const APP_ROOT = resolve(HERE, '../../..');

function cli(args_: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, ...args_], { cwd: APP_ROOT }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
}

// —— mock server：记录请求，responder 按 (method, path, body) 分发；destroy:true 模拟连接中断（传输层错误）——
interface SrvReq { method: string; path: string; body: Record<string, unknown> | null }
interface SrvRes { status: number; json?: unknown; destroy?: boolean }
type Responder = (req: SrvReq) => SrvRes;

function startMockServer(respond: Responder): Promise<{ url: string; reqs: SrvReq[]; close(): Promise<void> }> {
  return new Promise((resolveSrv) => {
    const reqs: SrvReq[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let body: Record<string, unknown> | null = null;
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* 空 body */ }
        const rec: SrvReq = { method: req.method ?? '', path: req.url ?? '', body };
        reqs.push(rec);
        const r = respond(rec);
        if (r.destroy) { res.destroy(); return; } // 模拟 server 中途断连 → fetch 抛 TypeError
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(r.json === undefined ? '' : JSON.stringify(r.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolveSrv({ url: `http://127.0.0.1:${addr.port}`, reqs, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

const DEAD = 'http://127.0.0.1:1';
const args = (dbPath: string, serverUrl: string, rest: string[]): string[] =>
  ['--db', dbPath, '--server', serverUrl, '--token', 'tok-1', ...rest];
const NO_DB = join(tmpdir(), 'cli-collect-no-such.db');

// 样本库：BV1（含 ugc_season 777）+ BV2 已采；YT1 已采（youtube）；creators uid=1 fans=5000。
function setup(): { db: Database.Database; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-collect-cli-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  // BV 号须满足 /^BV[0-9A-Za-z]{10}$/（parseSeasonArg 契约），season 用例用满长 BV
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1Season001', title: '合集视频', creator: { source_uid: '1', name: 'Alpha UP' }, extra: { ugc_season: { id: 777 } }, duration: 60, published_at: 1 },
    tracks: [],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV2Season002', title: '无合集视频', creator: { source_uid: '1', name: 'Alpha UP' }, extra: {}, duration: 30, published_at: 1 },
    tracks: [],
  });
  ingestVideo(db, {
    source: 'youtube',
    video: { source_vid: 'YT1', title: 'yt old', creator: { source_uid: 'y1', name: 'Yt UP' }, extra: {}, duration: 100, published_at: 1 },
    tracks: [],
  });
  db.prepare("UPDATE creators SET fans = 5000 WHERE source = 'bilibili' AND source_uid = '1'").run();
  return { db, dbPath: join(dir, 'test.db'), dir };
}

// 常用 responder 组件
const ok = (result: unknown): SrvRes => ({ status: 200, json: { ok: true, client_id: 'ext-1', result } });

// ── collect search ──

test('collect search --client：body 带 keyword/page/order/tid + timeout，透传响应，退 0', async () => {
  const srv = await startMockServer((req) => (req.body?.action === 'search' ? ok({ total: 1, items: [{ bvid: 'BVX' }] }) : { status: 404 }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, [
      'collect', 'search', '通胀', '--client', 'ext-1', '--page', '2', '--order', 'view', '--tid', '17', '--timeout', '777',
    ]));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out).result, { total: 1, items: [{ bvid: 'BVX' }] });
    assert.equal(srv.reqs[0]!.path, '/api/clients/ext-1/command');
    assert.deepEqual(srv.reqs[0]!.body, { action: 'search', keyword: '通胀', page: 2, order: 'view', tid: 17, timeout: 777 });
  } finally { await srv.close(); }
});

test('collect search 缺省 --client：先 GET /api/clients 取第一个在线 client', async () => {
  const srv = await startMockServer((req) =>
    req.method === 'GET' && req.path === '/api/clients'
      ? { status: 200, json: { clients: [{ client_id: 'ext-9' }] } }
      : req.body?.action === 'search' ? ok({ items: [] }) : { status: 404 });
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'search', 'kw']));
    assert.equal(r.code, 0);
    assert.equal(srv.reqs[0]!.path, '/api/clients');
    assert.equal(srv.reqs[1]!.path, '/api/clients/ext-9/command');
  } finally { await srv.close(); }
});

test('collect search：无在线 client → ARGS 退 2', async () => {
  const srv = await startMockServer((req) =>
    req.method === 'GET' && req.path === '/api/clients' ? { status: 200, json: { clients: [] } } : { status: 404 });
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'search', 'kw']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /no online client/);
  } finally { await srv.close(); }
});

test('collect search --timeout abc → ARGS 退 2', async () => {
  const r = await cli(args('/tmp/none.db', DEAD, ['collect', 'search', 'kw', '--client', 'ext-1', '--timeout', 'abc']));
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, 'ARGS');
  assert.match(r.err, /invalid --timeout: NaN/);
});

test('collect search：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args('/tmp/none.db', DEAD, ['collect', 'search', 'kw', '--client', 'ext-1']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
});

test('collect search：扩展执行失败（502 + error JSON）→ ExtCommandError → RUNTIME 退 1（带 status）', async () => {
  const srv = await startMockServer(() => ({ status: 502, json: { ok: false, error: 'boom' } }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'search', 'kw', '--client', 'ext-1']));
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'RUNTIME');
    assert.equal(body.status, 502);
    assert.match(r.err, /search failed: boom/);
  } finally { await srv.close(); }
});

// ── collect subtitle ──

test('collect subtitle：body {bvid, timeout}，透传 result，退 0', async () => {
  const srv = await startMockServer((req) => (req.body?.action === 'fetch-subtitle' ? ok({ tracks: 2 }) : { status: 404 }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'subtitle', 'BV1', '--client', 'ext-1', '--timeout', '123']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out).result, { tracks: 2 });
    assert.deepEqual(srv.reqs[0]!.body, { action: 'fetch-subtitle', bvid: 'BV1', timeout: 123 });
  } finally { await srv.close(); }
});

test('collect subtitle：不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args('/tmp/none.db', DEAD, ['collect', 'subtitle', 'BV1', '--client', 'ext-1']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
});

test('collect subtitle --timeout 0 → ARGS 退 2', async () => {
  const r = await cli(args('/tmp/none.db', DEAD, ['collect', 'subtitle', 'BV1', '--client', 'ext-1', '--timeout', '0']));
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, 'ARGS');
});

// ── collect dedupe（直读 DB）──

test('collect dedupe：按 video 是否入库分 collected/missing，退 0', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['collect', 'dedupe', 'BV1Season001', 'BV9']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { collected: ['BV1Season001'], missing: ['BV9'] });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect dedupe：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const r = await cli(args(NO_DB, DEAD, ['collect', 'dedupe', 'BV1Season001']));
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
});

// ── collect season ──

test('collect season <id>：展开 → 判重 → 未采批量建任务（creator_uid 带 mid），退 0', async () => {
  const { db, dir, dbPath } = setup();
  const srv = await startMockServer((req) => {
    if (req.body?.action === 'list-season-videos') return ok({ mid: 42, items: [{ bvid: 'BV1Season001' }, { bvid: 'BVNEW' }] });
    if (req.path === '/api/collect-tasks/batch') return { status: 200, json: { created: 1, skipped: 0 } };
    return { status: 404 };
  });
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'season', '888', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.season_id, 888);
    assert.equal(data.total, 2);
    assert.equal(data.collected, 1);  // BV1 已入库
    assert.equal(data.missing, 1);    // BVNEW 未采
    assert.equal(data.tasks_created, 1);
    // list-season-videos body：season_id + timeout
    assert.deepEqual(srv.reqs[0]!.body, { action: 'list-season-videos', season_id: 888, timeout: 180000 });
    // 批量建任务 body：vids=missing + source=bilibili + creator_uid=mid
    assert.deepEqual(srv.reqs[1]!.body, { vids: ['BVNEW'], source: 'bilibili', creator_uid: '42' });
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect season <BV号>：库内 extra.ugc_season.id 反查合集 id', async () => {
  const { db, dir, dbPath } = setup();
  const srv = await startMockServer((req) => {
    if (req.body?.action === 'list-season-videos') return ok({ mid: 42, items: [{ bvid: 'BV1Season001' }] });
    return { status: 404 };
  });
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'season', 'BV1Season001', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).season_id, 777);
    assert.equal(srv.reqs[0]!.body!.season_id, 777);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect season --dry-run：只列 missing 不建任务', async () => {
  const { db, dir, dbPath } = setup();
  const srv = await startMockServer((req) => (req.body?.action === 'list-season-videos' ? ok({ mid: 42, items: [{ bvid: 'BV1Season001' }, { bvid: 'BVNEW' }] }) : { status: 404 }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'season', '888', '--dry-run', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.dry_run, true);
    assert.deepEqual(data.missing_bvids, ['BVNEW']);
    assert.equal(srv.reqs.filter((x) => x.path === '/api/collect-tasks/batch').length, 0, 'dry-run 不建任务');
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect season：合集视频已全部采集 → tasks_created 0 + note', async () => {
  const { db, dir, dbPath } = setup();
  const srv = await startMockServer((req) => (req.body?.action === 'list-season-videos' ? ok({ mid: 42, items: [{ bvid: 'BV1Season001' }, { bvid: 'BV2Season002' }] }) : { status: 404 }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'season', '888', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.tasks_created, 0);
    assert.match(data.note, /已全部采集/);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect season：BV 未采集过（库内无合集归属）→ RUNTIME 退 1', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['collect', 'season', 'BV2Season002', '--client', 'ext-1']));
    assert.equal(r.code, 1);
    assert.match(r.err, /BV 未采集过,库内无合集归属/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect season：无法识别的参数 → RUNTIME 退 1', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['collect', 'season', 'garbage!!!', '--client', 'ext-1']));
    assert.equal(r.code, 1);
    assert.match(r.err, /无法识别合集参数/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect season：旧扩展不认识 action → EXT_UPDATE 退 6', async () => {
  const { db, dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 502, json: { error: 'unknown action: list-season-videos' } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'season', '888', '--client', 'ext-1']));
    assert.equal(r.code, 6);
    assert.equal(JSON.parse(r.out).code, 'EXT_UPDATE');
    assert.match(r.err, /扩展版本过旧/);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect season：DB 缺失 → DB_UNREADABLE 退 4；--timeout 0 → ARGS 退 2', async () => {
  const r1 = await cli(args(NO_DB, DEAD, ['collect', 'season', '888', '--client', 'ext-1']));
  assert.equal(r1.code, 4);
  assert.equal(JSON.parse(r1.out).code, 'DB_UNREADABLE');
  const r2 = await cli(args(NO_DB, DEAD, ['collect', 'season', '888', '--client', 'ext-1', '--timeout', '0']));
  assert.equal(r2.code, 2);
  assert.equal(JSON.parse(r2.out).code, 'ARGS');
});

// ── collect upper-info ──

test('collect upper-info：body {mid} 透传 result，退 0', async () => {
  const srv = await startMockServer((req) => (req.body?.action === 'get-upper-info' ? ok({ mid: 42, fans: 100 }) : { status: 404 }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'upper-info', '42', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out).result, { mid: 42, fans: 100 });
    assert.deepEqual(srv.reqs[0]!.body, { action: 'get-upper-info', mid: '42', timeout: 180000 });
  } finally { await srv.close(); }
});

test('collect upper-info：不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args('/tmp/none.db', DEAD, ['collect', 'upper-info', '42', '--client', 'ext-1']));
  assert.equal(r.code, 3);
});

// ── collect upper-videos ──

test('collect upper-videos 单页：body {mid,page,page_size}，退 0', async () => {
  const srv = await startMockServer((req) => (req.body?.action === 'list-upper-videos'
    ? ok({ total: 5, items: [{ bvid: 'BV1', title: 'x' }] })
    : { status: 404 }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'upper-videos', '42', '--page', '3', '--size', '10', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).result.total, 5);
    assert.deepEqual(srv.reqs[0]!.body, { action: 'list-upper-videos', mid: '42', page: 3, page_size: 10, timeout: 180000 });
  } finally { await srv.close(); }
});

test('collect upper-videos --all：翻页拉完合并（页不足 size 停），单页响应形状', async () => {
  const pages: Record<number, unknown[]> = {
    1: [{ bvid: 'BVA' }, { bvid: 'BVB' }], // size=2 → 满
    2: [{ bvid: 'BVC' }],                  // 不足 size → 到尾停
  };
  const srv = await startMockServer((req) => (req.body?.action === 'list-upper-videos'
    ? ok({ total: 3, items: pages[req.body!.page as number] ?? [] })
    : { status: 404 }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'upper-videos', '42', '--all', '--size', '2', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.result.total, 3);
    assert.deepEqual(data.result.items.map((i: { bvid: string }) => i.bvid), ['BVA', 'BVB', 'BVC']);
    assert.equal(srv.reqs.length, 2, '翻两页后停');
  } finally { await srv.close(); }
});

test('collect upper-videos --all --since-created：created 早于下限被过滤（null 保留）+ total 用过滤后长度', async () => {
  const since = Math.floor(Date.now() / 1000) - 86400; // 近 1 天
  const srv = await startMockServer((req) => (req.body?.action === 'list-upper-videos'
    ? ok({ total: 3, items: [
        { bvid: 'NEW', created: Math.floor(Date.now() / 1000) },
        { bvid: 'OLD', created: 1_000_000 },
        { bvid: 'NULLCREATED', created: null },
      ] })
    : { status: 404 }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'upper-videos', '42', '--all', '--size', '5', '--since-created', String(since), '--client', 'ext-1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.deepEqual(data.result.items.map((i: { bvid: string }) => i.bvid), ['NEW', 'NULLCREATED']);
    assert.equal(data.result.total, 2, '传 since-created 后 total = 过滤后长度');
  } finally { await srv.close(); }
});

test('collect upper-videos --all：某页扩展失败 → RUNTIME 退 1（带页号上下文）', async () => {
  const srv = await startMockServer((req) => (req.body?.action === 'list-upper-videos'
    ? ((req.body!.page as number) === 1 ? ok({ total: 4, items: [{ bvid: 'A' }, { bvid: 'B' }] }) : { status: 502, json: { error: 'boom' } })
    : { status: 404 }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'upper-videos', '42', '--all', '--size', '2', '--client', 'ext-1']));
    assert.equal(r.code, 1);
    assert.match(r.err, /list-upper-videos page=2 failed: boom/);
  } finally { await srv.close(); }
});

test('collect upper-videos --timeout 0 → ARGS 退 2', async () => {
  const r = await cli(args('/tmp/none.db', DEAD, ['collect', 'upper-videos', '42', '--client', 'ext-1', '--timeout', '0']));
  assert.equal(r.code, 2);
});

// ── collect yt-videos ──

const ytResp = (items: unknown[]) => ok({ channel_id: 'UCxxx', channel_name: '频道', total: items.length, items });

test('collect yt-videos @handle：仅列清单（--since-days 过滤旧视频，null 保留），退 0', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => (req.body?.action === 'list-yt-channel-videos'
    ? ytResp([
        { vid: 'YT_NEW', created: nowSec, title: '新' },
        { vid: 'YT_OLD', created: 1_000_000, title: '旧' },
        { vid: 'YT_NULL', created: null, title: '未知时间' },
      ])
    : { status: 404 }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'yt-videos', '@handle', '--since-days', '7', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.deepEqual(data.items.map((i: { vid: string }) => i.vid), ['YT_NEW', 'YT_NULL']);
    assert.deepEqual(srv.reqs[0]!.body, { action: 'list-yt-channel-videos', ident: { handle: '@handle' }, refresh: false, timeout: 180000 });
  } finally { await srv.close(); }
});

test('collect yt-videos 频道页 URL → channelId 识别；--refresh 透传', async () => {
  const srv = await startMockServer((req) => (req.body?.action === 'list-yt-channel-videos' ? ytResp([]) : { status: 404 }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'yt-videos', 'https://youtube.com/channel/UCabcdefghij123456789_12', '--refresh', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    assert.deepEqual(srv.reqs[0]!.body!.ident, { channelId: 'UCabcdefghij123456789_12' });
    assert.equal(srv.reqs[0]!.body!.refresh, true);
  } finally { await srv.close(); }
});

test('collect yt-videos：非法频道参数 → ARGS 退 2；--since-days -1 → ARGS；--timeout 0 → ARGS', async () => {
  const r1 = await cli(args('/tmp/none.db', DEAD, ['collect', 'yt-videos', 'garbage', '--client', 'ext-1']));
  assert.equal(r1.code, 2);
  assert.match(r1.err, /无法识别的频道参数/);
  const r2 = await cli(args('/tmp/none.db', DEAD, ['collect', 'yt-videos', '@handle', '--since-days', '-1', '--client', 'ext-1']));
  assert.equal(r2.code, 2);
  assert.match(r2.err, /invalid --since-days: -1/);
  const r3 = await cli(args('/tmp/none.db', DEAD, ['collect', 'yt-videos', '@handle', '--client', 'ext-1', '--timeout', '0']));
  assert.equal(r3.code, 2);
});

test('collect yt-videos --collect：串行采未入库视频（已入库跳过），退 0', async () => {
  const { db, dir, dbPath } = setup();
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => {
    if (req.body?.action === 'list-yt-channel-videos') {
      return ytResp([{ vid: 'YT1', created: nowSec }, { vid: 'YT2', created: nowSec }]); // YT1 已入库，YT2 未采
    }
    if (req.body?.action === 'fetch-youtube-subtitle') return ok({ captured: 3 });
    return { status: 404 };
  });
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'yt-videos', '@handle', '--collect', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.collected_now, 1);
    assert.equal(data.already_in_db, 1);
    assert.deepEqual(data.results, [{ vid: 'YT2', ok: true }]);
    // 只对未入库的 YT2 下发 fetch-youtube-subtitle
    assert.equal(srv.reqs.filter((x) => x.body?.action === 'fetch-youtube-subtitle').length, 1);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect yt-videos --collect：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => (req.body?.action === 'list-yt-channel-videos' ? ytResp([{ vid: 'YT2', created: nowSec }]) : { status: 404 }));
  try {
    const r = await cli(args(NO_DB, srv.url, ['collect', 'yt-videos', '@handle', '--collect', '--client', 'ext-1']));
    assert.equal(r.code, 4);
    assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
  } finally { await srv.close(); }
});

// ── collect new-videos ──

test('collect new-videos <mid>：列表对比库 → new/collected，退 0', async () => {
  const { db, dir, dbPath } = setup();
  const srv = await startMockServer((req) => (req.body?.action === 'list-upper-videos'
    ? ok({ total: 3, items: [{ bvid: 'BV1Season001' }, { bvid: 'BVNEW1' }, { bvid: 'BVNEW2' }] })
    : { status: 404 }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'new-videos', '42', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { total: 3, new: ['BVNEW1', 'BVNEW2'], collected: ['BV1Season001'] });
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect new-videos：列表为空 → total 透传 + 空 new/collected', async () => {
  const { db, dir, dbPath } = setup();
  const srv = await startMockServer((req) => (req.body?.action === 'list-upper-videos' ? ok({ total: 7, items: [] }) : { status: 404 }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'new-videos', '42', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { total: 7, new: [], collected: [] });
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect new-videos：DB 缺失 → DB_UNREADABLE 退 4；--timeout 0 → ARGS 退 2', async () => {
  const r1 = await cli(args(NO_DB, DEAD, ['collect', 'new-videos', '42', '--client', 'ext-1']));
  assert.equal(r1.code, 4);
  const r2 = await cli(args(NO_DB, DEAD, ['collect', 'new-videos', '42', '--client', 'ext-1', '--timeout', '0']));
  assert.equal(r2.code, 2);
});

// ── collect discover ──

test('collect discover <mid...>：单 mid 失败记录 error 不影响其他，退 0', async () => {
  const { db, dir, dbPath } = setup();
  const srv = await startMockServer((req) => {
    if (req.body?.action !== 'list-upper-videos') return { status: 404 };
    return (req.body!.mid as string) === '1'
      ? ok({ total: 2, items: [{ bvid: 'BV1Season001' }, { bvid: 'BVNEW' }] })
      : { status: 502, json: { error: 'boom' } }; // mid=2 扩展失败（软失败记录）
  });
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'discover', '1', '2', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.per_mid.length, 2);
    assert.deepEqual(data.per_mid[0], { mid: '1', total: 2, new: ['BVNEW'], collected: ['BV1Season001'] });
    assert.equal(data.per_mid[1].error !== undefined, true);
    assert.match(data.per_mid[1].error, /list-upper-videos failed: boom/);
    assert.deepEqual(data.all_new, ['BVNEW']);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect discover：DB 缺失 → DB_UNREADABLE 退 4；--timeout 0 → ARGS 退 2', async () => {
  const r1 = await cli(args(NO_DB, DEAD, ['collect', 'discover', '1', '--client', 'ext-1']));
  assert.equal(r1.code, 4);
  const r2 = await cli(args(NO_DB, DEAD, ['collect', 'discover', '1', '--client', 'ext-1', '--timeout', '0']));
  assert.equal(r2.code, 2);
});

// ── collect find ──

test('collect find：fans 走 creators 缓存 + --min-fans 过滤，退 0', async () => {
  const { db, dir, dbPath } = setup();
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => (req.body?.action === 'search'
    ? ok({ total: 2, items: [
        { bvid: 'BVHIT', mid: 1, pubdate: nowSec },   // uid=1 缓存 fans=5000
        { bvid: 'BVSMALL', mid: 2, pubdate: nowSec },  // uid=2 无缓存 → 实时查 fans=100
      ] })
    : req.body?.action === 'get-upper-info' ? ok({ fans: 100 })
      : { status: 404 }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'find', 'kw', '--client', 'ext-1', '--min-fans', '1000', '--sleep', '1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.fans_cache_hit, 1);
    assert.equal(data.fans_fetched, 1);
    assert.equal(data.fans_unknown, 0);
    assert.equal(data.after_fans, 1); // 5000 ≥ 1000 留下，100 < 1000 滤掉
    assert.deepEqual(data.items.map((i: { bvid: string }) => i.bvid), ['BVHIT']);
    assert.equal(data.items[0].fans, 5000);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect find --no-cache：跳过缓存全实时查', async () => {
  const { db, dir, dbPath } = setup();
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => (req.body?.action === 'search'
    ? ok({ total: 1, items: [{ bvid: 'BV1', mid: 1, pubdate: nowSec }] })
    : req.body?.action === 'get-upper-info' ? ok({ fans: 100 })
      : { status: 404 }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'find', 'kw', '--no-cache', '--client', 'ext-1', '--sleep', '1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.fans_cache_hit, 0);
    assert.equal(data.fans_fetched, 1);
    assert.equal(data.items[0].fans, 100);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect find：实时查 fans 失败（502）→ fans 未知保守保留 + fans_unknown 计数', async () => {
  const { db, dir, dbPath } = setup();
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => (req.body?.action === 'search'
    ? ok({ total: 1, items: [{ bvid: 'BVX', mid: 9, pubdate: nowSec }] }) // mid=9 无缓存
    : req.body?.action === 'get-upper-info' ? { status: 502, json: { error: 'boom' } }
      : { status: 404 }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'find', 'kw', '--client', 'ext-1', '--sleep', '1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.fans_unknown, 1);
    assert.equal(data.items[0].fans, null);
    assert.equal(data.after_fans, 1, 'fans 未知不滤掉（保守）');
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect find --since-days：发布时间过滤；结果无 mid → 不查 fans', async () => {
  const { db, dir, dbPath } = setup();
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => (req.body?.action === 'search'
    ? ok({ total: 2, items: [
        { bvid: 'BVNEW', pubdate: nowSec },               // 无 mid
        { bvid: 'BVOLD', pubdate: nowSec - 400 * 86400 }, // 超 since-days
      ] })
    : { status: 404 }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'find', 'kw', '--since-days', '30', '--client', 'ext-1', '--sleep', '1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.after_date, 1);
    assert.equal(data.items[0].fans, null, '无 mid → fans null');
    assert.equal(srv.reqs.filter((x) => x.body?.action === 'get-upper-info').length, 0, '无 mid 不实时查');
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect find --since YYYY-MM-DD：日期下限解析生效', async () => {
  const { db, dir, dbPath } = setup();
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => (req.body?.action === 'search'
    ? ok({ total: 1, items: [{ bvid: 'BVNEW', pubdate: nowSec }] })
    : { status: 404 }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'find', 'kw', '--since', '2020-01-01', '--client', 'ext-1', '--sleep', '1']));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).after_date, 1);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect find --collect：对最终候选串行采字幕（no_subtitle 记 ok:false），退 0', async () => {
  const { db, dir, dbPath } = setup();
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => {
    if (req.body?.action === 'search') return ok({ total: 2, items: [{ bvid: 'BVCAP', mid: 1, pubdate: nowSec }, { bvid: 'BGNOSUB', mid: 1, pubdate: nowSec }] });
    if (req.body?.action === 'fetch-subtitle') {
      return (req.body!.bvid as string) === 'BVCAP' ? ok({ captured: 2 }) : ok({ reason: 'no_subtitle' });
    }
    return { status: 404 };
  });
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'find', 'kw', '--collect', '--client', 'ext-1', '--sleep', '1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.deepEqual(data.collected, [
      { bvid: 'BVCAP', ok: true },
      { bvid: 'BGNOSUB', ok: false, reason: 'no_subtitle' },
    ]);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect find：search 第 2 页失败 → RUNTIME 退 1（带页号上下文）', async () => {
  const { db, dir, dbPath } = setup();
  const srv = await startMockServer((req) => (req.body?.action === 'search'
    ? ((req.body!.page as number) === 1 ? ok({ total: 40, items: [{ bvid: 'A' }] }) : { status: 502, json: { error: 'boom' } })
    : { status: 404 }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'find', 'kw', '--pages', '2', '--client', 'ext-1', '--sleep', '1']));
    assert.equal(r.code, 1);
    assert.match(r.err, /search page=2 failed: boom/);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect find：--min-fans -1 / --since 非法 / --timeout 0 → ARGS 退 2', async () => {
  const r1 = await cli(args(NO_DB, DEAD, ['collect', 'find', 'kw', '--min-fans', '-1', '--client', 'ext-1']));
  assert.equal(r1.code, 2);
  assert.match(r1.err, /invalid --min-fans: -1/);
  const r2 = await cli(args(NO_DB, DEAD, ['collect', 'find', 'kw', '--since', 'not-a-date', '--client', 'ext-1']));
  assert.equal(r2.code, 2);
  assert.match(r2.err, /invalid --since/);
  const r3 = await cli(args(NO_DB, DEAD, ['collect', 'find', 'kw', '--client', 'ext-1', '--timeout', '0']));
  assert.equal(r3.code, 2);
});

test('collect find：不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const r = await cli(args(NO_DB, DEAD, ['collect', 'find', 'kw', '--client', 'ext-1']));
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
});

test('collect find：DB 读失败（--db 缺失）→ fans 缓存降级为全实时查，退 0', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => (req.body?.action === 'search'
    ? ok({ total: 1, items: [{ bvid: 'BVX', mid: 5, pubdate: nowSec }] })
    : req.body?.action === 'get-upper-info' ? ok({ fans: 300 })
      : { status: 404 }));
  try {
    const r = await cli(args(NO_DB, srv.url, ['collect', 'find', 'kw', '--client', 'ext-1', '--sleep', '1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.fans_cache_hit, 0);
    assert.equal(data.fans_fetched, 1);
  } finally { await srv.close(); }
});

// ── 补充分支：resolveClientId 的 listClients 错误归一化（ServerResponseError 直达 handleHttpError）──

test('collect search 缺省 --client + GET /api/clients 404 → NOT_FOUND 退 5', async () => {
  const srv = await startMockServer((req) =>
    req.method === 'GET' && req.path === '/api/clients' ? { status: 404, json: { error: 'no route' } } : { status: 404 });
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'search', 'kw']));
    assert.equal(r.code, 5);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(body.status, 404);
  } finally { await srv.close(); }
});

test('collect search 缺省 --client + GET /api/clients 500 → RUNTIME 退 1', async () => {
  const srv = await startMockServer((req) =>
    req.method === 'GET' && req.path === '/api/clients' ? { status: 500, json: { error: 'boom' } } : { status: 404 });
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'search', 'kw']));
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'RUNTIME');
    assert.equal(body.status, 500);
  } finally { await srv.close(); }
});

// ── 补充分支：find --collect 的硬停（need_login / risk_control）──

test('collect find --collect：need_login → 硬停 STOP → RUNTIME 退 1', async () => {
  const { db, dir, dbPath } = setup();
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => {
    if (req.body?.action === 'search') return ok({ total: 1, items: [{ bvid: 'BV1', mid: 1, pubdate: nowSec }] });
    if (req.body?.action === 'fetch-subtitle') return { status: 502, json: { error: 'need_login' } };
    return { status: 404 };
  });
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'find', 'kw', '--collect', '--client', 'ext-1', '--sleep', '1']));
    assert.equal(r.code, 1);
    assert.match(r.err, /collect BV1 STOP: need_login/);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 补充分支：yt-videos / new-videos action 外层 catch（扩展执行失败）──

test('collect yt-videos：列表拉取 502 → RUNTIME 退 1', async () => {
  const srv = await startMockServer(() => ({ status: 502, json: { error: 'boom' } }));
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'yt-videos', '@handle', '--client', 'ext-1']));
    assert.equal(r.code, 1);
    assert.match(r.err, /list-yt-channel-videos failed: boom/);
  } finally { await srv.close(); }
});

test('collect new-videos：列表拉取 502 → RUNTIME 退 1', async () => {
  const { db, dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 502, json: { error: 'boom' } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'new-videos', '42', '--client', 'ext-1']));
    assert.equal(r.code, 1);
    assert.match(r.err, /list-upper-videos failed: boom/);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 补充分支：传输层错误（连接中断）穿透非 ExtCommandError 的 rethrow ──

test('collect upper-videos --all：第 2 页连接中断 → SERVER_UNREACHABLE 退 3', async () => {
  const srv = await startMockServer((req) => {
    if (req.body?.action !== 'list-upper-videos') return { status: 404 };
    return (req.body!.page as number) === 1
      ? ok({ total: 4, items: [{ bvid: 'A' }, { bvid: 'B' }] })
      : { status: 0, destroy: true }; // 第 2 页断连 → ServerUnreachableError（非 ExtCommandError → 原样上抛）
  });
  try {
    const r = await cli(args('/tmp/none.db', srv.url, ['collect', 'upper-videos', '42', '--all', '--size', '2', '--client', 'ext-1']));
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  } finally { await srv.close(); }
});

test('collect find：实时查 fans 连接中断 → SERVER_UNREACHABLE 退 3（fetchFans 原样上抛）', async () => {
  const { db, dir, dbPath } = setup();
  const nowSec = Math.floor(Date.now() / 1000);
  const srv = await startMockServer((req) => {
    if (req.body?.action === 'search') return ok({ total: 1, items: [{ bvid: 'BVX', mid: 9, pubdate: nowSec }] }); // mid=9 无缓存
    if (req.body?.action === 'get-upper-info') return { status: 0, destroy: true };
    return { status: 404 };
  });
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'find', 'kw', '--client', 'ext-1', '--sleep', '1']));
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── collect subtitle 自动打 no-subtitle 系统标（2026-08-23）──
// 前提：fetch-subtitle 回执 reason=no_subtitle（视频元信息已 ingest）；操作：CLI 收到回执后应再 POST /api/tags/apply；
// 断言：apply 请求体 names=['no-subtitle']、source='system'、items 含该 bvid；apply 失败不阻断结果输出（退 0）。
test('collect subtitle：reason=no_subtitle → 自动 POST /api/tags/apply 打 no-subtitle system 标', async () => {
  const srv = await startMockServer((req) => {
    if (req.body?.action === 'fetch-subtitle') return { status: 200, json: { ok: true, client_id: 'ext-1', action: 'fetch-subtitle', result: { reason: 'no_subtitle', tracks: 0, ai_tracks: 0, ingested: true } } };
    if (req.path === '/api/tags/apply') return { status: 200, json: { ok: true, inserted: 1 } };
    return { status: 404 };
  });
  try {
    const r = await cli(args(NO_DB, srv.url, ['collect', 'subtitle', 'BV1', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    // 第二个请求是打标：system 档 no-subtitle
    const applyReq = srv.reqs.find((q) => q.path === '/api/tags/apply');
    assert.ok(applyReq, '发出了 /api/tags/apply');
    assert.deepEqual(applyReq!.body, {
      items: [{ source: 'bilibili', source_vid: 'BV1' }],
      names: ['no-subtitle'],
      source: 'system',
    });
  } finally { await srv.close(); }
});

// 前提：回执正常采到轨（无 no_subtitle）；操作：CLI 不应发 apply；断言：请求列表里无 /api/tags/apply。
test('collect subtitle：正常采到轨 → 不打标（无 /api/tags/apply 请求）', async () => {
  const srv = await startMockServer((req) => (
    req.body?.action === 'fetch-subtitle'
      ? { status: 200, json: { ok: true, client_id: 'ext-1', action: 'fetch-subtitle', result: { tracks: 1 } } }
      : { status: 404 }
  ));
  try {
    const r = await cli(args(NO_DB, srv.url, ['collect', 'subtitle', 'BV1', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    assert.equal(srv.reqs.some((q) => q.path === '/api/tags/apply'), false, '正常轨不触发打标');
  } finally { await srv.close(); }
});
