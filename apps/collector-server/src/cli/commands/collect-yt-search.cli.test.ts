// collect-yt-search.ts commander 装配层测试：子进程跑真 CLI + 本地 mock HTTP server。
// 覆盖：yt-search action 参数透传（order/pages 默认与显式）、--since-days 过滤（null 保留）、
// --collect 串行采集（已入库跳过 / 空 vid 过滤 / DB 缺失退 4）、参数校验（ARGS）、
// 扩展失败（502→RUNTIME）与旧扩展（unknown action→EXT_UPDATE）。
// 纯函数见 collect-yt-search.test.ts；扩展侧编排见 apps/subtitle-collector/test/yt-search.test.mjs。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 默认/显式参数、--since-days、--collect、校验、502、EXT_UPDATE | 通过 | mock server 按 body.action 分发 |

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

const HERE = dirname(fileURLToPath(import.meta.url));
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

const ok = (result: unknown): SrvRes => ({ status: 200, json: { ok: true, client_id: 'ext-1', result } });
const NO_DB = join(tmpdir(), 'cli-yt-search-no-such.db');
const args = (dbPath: string, serverUrl: string, rest: string[]): string[] =>
  ['--db', dbPath, '--server', serverUrl, '--token', 'tok-1', ...rest];

// 样本库：YT1 已采（youtube source）
function setup(): { db: Database.Database; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-yt-search-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'youtube',
    video: { source_vid: 'YT1', title: '已采', creator: { source_uid: 'c1', name: 'Chan' }, duration: 60, published_at: 1 },
    tracks: [],
  });
  return { db, dbPath: join(dir, 'test.db'), dir };
}

const nowSec = Math.floor(Date.now() / 1000);

// ── 默认参数与透传 ──

test('collect yt-search：默认 order=relevance pages=1，透传响应（含 diag），退 0', async () => {
  const srv = await startMockServer((req) => (req.body?.action === 'yt-search'
    ? ok({ keyword: 'kw', raw_total: 999, pages_fetched: 1, items: [{ vid: 'AAAAAAAAAAA', title: 'Hit', created: nowSec, play: 5, length: '1:00' }], diag: { html_len: 100, hit_lockups: 0, hit_renderers: 1 } })
    : { status: 404 }));
  try {
    const r = await cli(args(NO_DB, srv.url, ['collect', 'yt-search', 'kw', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    // body 形状：action + keyword/order/pages + timeout（sendCommand 层附加）
    assert.equal(srv.reqs[0]!.body!.action, 'yt-search');
    assert.deepEqual(
      { keyword: srv.reqs[0]!.body!.keyword, order: srv.reqs[0]!.body!.order, pages: srv.reqs[0]!.body!.pages },
      { keyword: 'kw', order: 'relevance', pages: 1 },
    );
    const data = JSON.parse(r.out);
    assert.equal(data.count, 1);
    assert.equal(data.raw_total, 999);
    assert.equal(data.items[0].vid, 'AAAAAAAAAAA');
    // diag 解析命中计数透传（§9 可观察性）
    assert.deepEqual(data.diag, { html_len: 100, hit_lockups: 0, hit_renderers: 1 });
  } finally { await srv.close(); }
});

test('collect yt-search --order newest --pages 3：显式参数透传', async () => {
  const srv = await startMockServer((req) => (req.body?.action === 'yt-search' ? ok({ items: [] }) : { status: 404 }));
  try {
    const r = await cli(args(NO_DB, srv.url, ['collect', 'yt-search', 'kw', '--order', 'newest', '--pages', '3', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    assert.equal(srv.reqs[0]!.body!.order, 'newest');
    assert.equal(srv.reqs[0]!.body!.pages, 3);
  } finally { await srv.close(); }
});

// ── --since-days 过滤 ──

test('collect yt-search --since-days 7：旧视频滤除，null created 保留', async () => {
  const srv = await startMockServer((req) => (req.body?.action === 'yt-search'
    ? ok({ raw_total: 3, items: [
        { vid: 'YT_NEW', created: nowSec },
        { vid: 'YT_OLD', created: 1_000_000 },
        { vid: 'YT_NULL', created: null },
      ] })
    : { status: 404 }));
  try {
    const r = await cli(args(NO_DB, srv.url, ['collect', 'yt-search', 'kw', '--since-days', '7', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.deepEqual(data.items.map((i: { vid: string }) => i.vid), ['YT_NEW', 'YT_NULL']);
  } finally { await srv.close(); }
});

// ── --collect 采集 ──

test('collect yt-search --collect：串行采未入库（已入库跳过，空 vid 不下发），退 0', async () => {
  const { db, dbPath, dir } = setup();
  const srv = await startMockServer((req) => {
    if (req.body?.action === 'yt-search') {
      return ok({ raw_total: 3, items: [
        { vid: 'YT1', created: nowSec },   // 已入库 → 跳过
        { vid: 'YT2', created: nowSec },   // 未采 → fetch-youtube-subtitle
        { vid: '', created: nowSec },      // 防御：空 vid 不下发
      ] });
    }
    if (req.body?.action === 'fetch-youtube-subtitle') return ok({ captured: 2 });
    return { status: 404 };
  });
  try {
    const r = await cli(args(dbPath, srv.url, ['collect', 'yt-search', 'kw', '--collect', '--client', 'ext-1']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.collected_now, 1);
    assert.equal(data.already_in_db, 1);
    assert.deepEqual(data.results, [{ vid: 'YT2', ok: true }]);
    assert.equal(srv.reqs.filter((x) => x.body?.action === 'fetch-youtube-subtitle').length, 1);
  } finally { await srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collect yt-search --collect：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const srv = await startMockServer((req) => (req.body?.action === 'yt-search' ? ok({ items: [{ vid: 'YT2', created: nowSec }] }) : { status: 404 }));
  try {
    const r = await cli(args(NO_DB, srv.url, ['collect', 'yt-search', 'kw', '--collect', '--client', 'ext-1']));
    assert.equal(r.code, 4);
    assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
  } finally { await srv.close(); }
});

// ── 参数校验 ──

test('collect yt-search：非法 --order / --pages / --since-days / --timeout → ARGS 退 2', async () => {
  const r1 = await cli(args(NO_DB, 'http://127.0.0.1:1', ['collect', 'yt-search', 'kw', '--order', 'rating', '--client', 'ext-1']));
  assert.equal(r1.code, 2);
  assert.match(r1.err, /invalid --order: rating/);
  const r2 = await cli(args(NO_DB, 'http://127.0.0.1:1', ['collect', 'yt-search', 'kw', '--pages', '11', '--client', 'ext-1']));
  assert.equal(r2.code, 2);
  assert.match(r2.err, /invalid --pages: 11/);
  const r3 = await cli(args(NO_DB, 'http://127.0.0.1:1', ['collect', 'yt-search', 'kw', '--since-days', '-1', '--client', 'ext-1']));
  assert.equal(r3.code, 2);
  assert.match(r3.err, /invalid --since-days: -1/);
  const r4 = await cli(args(NO_DB, 'http://127.0.0.1:1', ['collect', 'yt-search', 'kw', '--timeout', '0', '--client', 'ext-1']));
  assert.equal(r4.code, 2);
  assert.match(r4.err, /invalid --timeout: 0/);
});

// ── 失败路径 ──

test('collect yt-search：扩展执行失败（server 502）→ RUNTIME 退 1', async () => {
  const srv = await startMockServer(() => ({ status: 502, json: { error: '结果页无 ytInitialData（keyword=kw html_len=5200，疑似反爬/consent 页）' } }));
  try {
    const r = await cli(args(NO_DB, srv.url, ['collect', 'yt-search', 'kw', '--client', 'ext-1']));
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).code, 'RUNTIME');
    assert.match(r.out, /ytInitialData/); // 扩展侧诊断特征透传（§9 可观察性）
  } finally { await srv.close(); }
});

test('collect yt-search：旧扩展不认识 action → EXT_UPDATE 退 6', async () => {
  const srv = await startMockServer(() => ({ status: 502, json: { error: 'unknown action: yt-search', needs_update: true } }));
  try {
    const r = await cli(args(NO_DB, srv.url, ['collect', 'yt-search', 'kw', '--client', 'ext-1']));
    assert.equal(r.code, 6);
    assert.equal(JSON.parse(r.out).code, 'EXT_UPDATE');
  } finally { await srv.close(); }
});
