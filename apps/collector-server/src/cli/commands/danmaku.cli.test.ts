// danmaku 命令组子进程端到端：真 CLI 进程 + 进程内 mock server（collector 四端点 + mock B 站 seg.so/view），
// 覆盖 --help 全选项、ARGS 各退 2（双缺/aid 不一致/page 越界·非法/format 非法/cookie 文件不可读）、
// collect 成功回执 / dry-run / 匿名 cookie、BV404 退 5。
// 编排判停细节（mock 注入 sleep/fetch）见 danmaku.test.ts；真实 B 站通路不在本文件（真实验收由主会话执行）。
//
// 【为何必须子进程】node:test 子隔离模式下父子走 process.stdout 二进制协议帧；进程内 stub stdout
// 跑真实异步网络 I/O 会把协议帧吸进捕获串（comments.cli.test.ts 头注详述）——collect 全链路含真
// fetch/http server，只能像 comments.cli.test.ts 一样 execFile 子进程跑。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | help 全选项 / 双缺·mismatch·page 非法越界·cookie 不可读 ARGS 退 2 / 全局 format 非法兜底 / collect 成功 + dry-run + 匿名 + 显式 cookie / BV404 退 5 / verify 真实临时库 + NOT_FOUND·ARGS | 通过 | 2026-10-07 C4;含真实段间隔 sleep(~1s,无注入口,接受并在此登记);局部 --format 因 commander 与全局同名冲突不设(实测锁行为用例) |
// | R2 | cookie 空文件 ARGS 退 2 / count 哨兵失败 RUNTIME 退 1(collectErrorExit 兜底) | 通过 | 2026-10-07 R2;全局 branches 门 ≥93% 补齐(mock collector 加 countFail 注入开关) |

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http, { type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/cli/commands
const MAIN_TS = join(HERE, '..', 'main.ts');
const APP_ROOT = resolve(HERE, '../../..');

// ── 测试专用最小 protobuf 编码器（自含副本,禁跨测试文件 import;与 bili-danmaku.test.ts 同款）──

function encVarint(n: number | bigint): Uint8Array {
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return new Uint8Array(out);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

const tag = (fieldNo: number, wireType: number): Uint8Array => encVarint((fieldNo << 3) | wireType);
const fStr = (fieldNo: number, s: string): Uint8Array => {
  const bytes = new TextEncoder().encode(s);
  return concat(tag(fieldNo, 2), encVarint(bytes.length), bytes);
};
/** 单 elem:field12 id_str + field7 content(field2 progress);seg 顶层每 elem 包为 field1。 */
const elem = (id: string, progress: number): Uint8Array =>
  concat(fStr(12, id), fStr(7, `弹幕${id}`), concat(tag(2, 0), encVarint(progress)));
const segBuf = (items: Array<[string, number]>): Buffer =>
  Buffer.from(concat(...items.map(([id, p]) => concat(tag(1, 2), encVarint(elem(id, p).length), elem(id, p)))));

// ── mock B 站（view + seg.so:P1(111) seg1 两条/seg2 一条;P2(222) seg1 即 304;其余 304）──

const VIEW_DATA = {
  code: 0, data: {
    aid: 500, bvid: 'BV1dmCLI', title: 'CLI测试视频', duration: 400, cid: 111,
    pages: [
      { cid: 111, page: 1, part: 'P1', duration: 400 },
      { cid: 222, page: 2, part: 'P2', duration: 100 },
    ],
    stat: { danmaku: 4242 },
  },
};

function segResponse(cid: number, seg: number, res: ServerResponse): void {
  const body = cid === 111 && seg === 1 ? segBuf([['c1', 100], ['c2', 200]])
    : cid === 111 && seg === 2 ? segBuf([['c3', 300]])
    : cid === 222 && seg === 1 ? segBuf([['p1', 50]])
    : null;
  if (body == null) {
    res.writeHead(304, { 'bili-status-code': '-304' });
    res.end();
    return;
  }
  res.writeHead(200, { 'bili-status-code': '0', 'Content-Type': 'application/octet-stream' });
  res.end(body);
}

const biliServer: Server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '';
  if (url.includes('/x/v2/dm/web/seg.so')) {
    const q = new URL(url, 'http://x').searchParams;
    return segResponse(Number(q.get('oid')), Number(q.get('segment_index')), res);
  }
  if (url.includes('/x/web-interface/view')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(VIEW_DATA));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: -400, message: `mock bili 未路由: ${url}` }));
});

// ── mock collector server（视频详情 / count / ingest / verify）──

const collectorState = {
  ingests: [] as Array<Record<string, unknown>>,
  verifyCalls: 0,
  countCalls: new Map<string, number>(),
  /** 注入开关:count 端点失败(RUNTIME 退 1 用例用,finally 复位) */
  countFail: false as boolean,
};

const collectorServer: Server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '';
  const json = (body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const m = url.match(/^\/api\/videos\/bilibili\/([^/?]+)/);
  if (m) {
    const vid = decodeURIComponent(m[1]);
    // BV404 → video:null(NOT_FOUND 退 5);其余带 extra.aid=500(供 --aid 交叉校验 mismatch 用例)
    return json(vid === 'BV404'
      ? { video: null }
      : { video: { id: 1, source_vid: vid, title: 'CLI测试视频', duration: 400, extra: JSON.stringify({ aid: 500, cid: 111, pages: VIEW_DATA.data.pages }) } });
  }
  if (url.startsWith('/api/danmaku/count')) {
    if (collectorState.countFail) return json({ ok: false, error: 'count 注入失败(测试)' });
    const bvid = new URL(url, 'http://x').searchParams.get('bvid') ?? '?';
    const n = collectorState.countCalls.get(bvid) ?? 0;
    collectorState.countCalls.set(bvid, n + 1);
    const rows = n === 0 ? 0 : collectorState.ingests.reduce((s, b) => s + (Array.isArray(b.danmakus) ? b.danmakus.length : 0), 0);
    return json({ ok: true, rows, pages: [] });
  }
  if (url.startsWith('/api/danmaku/ingest')) {
    let body: Record<string, unknown> = {};
    req.on('data', (c: Buffer) => {
      try { body = { ...body, ...(JSON.parse(String(c)) as typeof body) }; } catch { /* 忽略坏块 */ }
    });
    return req.on('end', () => {
      collectorState.ingests.push(body);
      const n = Array.isArray(body.danmakus) ? body.danmakus.length : 0;
      json({ ok: true, video_id: 1, inserted: n, updated: 0 });
    });
  }
  if (url.startsWith('/api/danmaku/verify')) {
    collectorState.verifyCalls++;
    return json({
      ok: true, bvid: new URL(url, 'http://x').searchParams.get('bvid'),
      counts: { rows: 4, pages: 2, by_page: [{ cid: 111, page: 1, rows: 3 }, { cid: 222, page: 2, rows: 1 }] },
      timeline: { min_progress_ms: 100, max_progress_ms: 300, histogram_60s: [], peak_minute: null },
      integrity: { dup_id: 0, negative_progress: 0 }, mode: { '1': 3 },
      weight: { p50: 9, p90: 9, max: 9 }, ctime: { min_s: 1_700_000_000, max_s: 1_700_000_100 },
    });
  }
  json({ ok: false, error: `mock collector 未路由: ${url}` });
});

async function listen0(server: Server): Promise<string> {
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const started = (async () => {
  const biliUrl = await listen0(biliServer);
  const collectorUrl = await listen0(collectorServer);
  return { biliUrl, collectorUrl };
})();

interface CliResult { code: number; out: string; err: string }

async function cli(args: string[]): Promise<CliResult> {
  const { biliUrl } = await started;
  const env = { ...process.env, COLLECTOR_BILI_API: biliUrl } as NodeJS.ProcessEnv;
  delete env.COLLECTOR_BILI_COOKIE_FILE; // cookie 一律显式 --cookie-file;不给即匿名(可选取代 comments 必配)
  return new Promise((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, ...args], { cwd: APP_ROOT, env }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
}

// collect 专用参数（--db 给临时路径占位：collect 不开库;--server 指向 mock collector）
const collectArgs = async (rest: string[]): Promise<string[]> => {
  const { collectorUrl } = await started;
  return ['--db', join(tmpdir(), 'unused.db'), '--server', collectorUrl, '--token', 't', ...rest];
};

// ── help 全选项 ──

test('danmaku collect --help 含全部选项（bvid/aid/page/max-segments/max-requests/segment-interval-ms/batch-size/dry-run/cookie-file）', async () => {
  const r = await cli(await collectArgs(['danmaku', 'collect', '--help']));
  assert.equal(r.code, 0);
  for (const flag of ['--bvid', '--aid', '--page', '--max-segments', '--max-requests', '--segment-interval-ms', '--batch-size', '--dry-run', '--cookie-file']) {
    assert.ok(r.out.includes(flag), `help 缺 ${flag}`);
  }
});

test('danmaku verify --help 含 --bvid（回执格式走全局 --format,局部项因 commander 同名冲突不设）', async () => {
  const r = await cli(await collectArgs(['danmaku', 'verify', '--help']));
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('--bvid'));
  assert.ok(!r.out.includes('--format <fmt>'), '局部 --format 不存在（与全局同名,commander 实测冲突）');
});

// ── ARGS 退 2 族 ──

test('collect 双缺（无 bvid/aid）→ ARGS 退 2（cookie 可选,缺失不再是 ARGS）', async () => {
  const r = await cli(await collectArgs(['danmaku', 'collect']));
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, 'ARGS');
  assert.match(r.err, /--bvid 或 --aid/);
});

test('collect --aid 与 extra.aid 不一致 → aid_mismatch ARGS 退 2', async () => {
  const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV1dmCLI', '--aid', '999']));
  assert.equal(r.code, 2);
  const body = JSON.parse(r.out);
  assert.equal(body.code, 'ARGS');
  assert.equal(body.collect_code, 'aid_mismatch');
});

test('collect --page 非法(0/abc)与越界(3/共 2 P)→ ARGS 退 2', async () => {
  for (const bad of ['0', 'abc']) {
    const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV1dmCLI', '--page', bad]));
    assert.equal(r.code, 2, `--page ${bad} 应退 2`);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
  }
  const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV1dmCLI', '--page', '3']));
  assert.equal(r.code, 2, '--page 3 越界应退 2');
  assert.match(r.err, /越界/, '越界报错带观测分 P 数');
});

test('全局 --format 非法值 → normalizeFormat 静默兜底 json 退 0（局部 --format 因 commander 同名冲突不设,锁此实测行为）', async () => {
  const { biliUrl, collectorUrl } = await started;
  const env = { ...process.env, COLLECTOR_BILI_API: biliUrl } as NodeJS.ProcessEnv;
  delete env.COLLECTOR_BILI_COOKIE_FILE;
  const r = await new Promise<CliResult>((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, '--db', join(tmpdir(), 'unused.db'), '--server', collectorUrl,
      '--token', 't', '--format', 'xml', 'danmaku', 'collect', '--bvid', 'BV1dmCLI', '--page', '2', '--dry-run'],
    { cwd: APP_ROOT, env }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
  assert.equal(r.code, 0, 'normalizeFormat 对非法值兜底 json,不退错');
  assert.equal(JSON.parse(r.out).ok, true, 'stdout 仍为合法 JSON 回执');
});

test('collect --cookie-file 不可读 → ARGS 退 2（可选项给了就要能用,静默降级会掩盖错路径）', async () => {
  const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV1dmCLI', '--cookie-file', '/nonexistent/ck.txt']));
  assert.equal(r.code, 2);
  assert.match(r.err, /cookie 文件不可读/);
});

test('collect --cookie-file 空文件 → ARGS 退 2（cookie 文件为空:给了就要非空,不给则匿名）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'danmaku-cli-'));
  try {
    const ck = join(dir, 'empty.txt');
    writeFileSync(ck, '  \n', 'utf-8'); // 仅空白:trim 后为空 → 空文件路径
    const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV1dmCLI', '--cookie-file', ck]));
    assert.equal(r.code, 2);
    assert.match(r.err, /cookie 文件为空/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collect count 哨兵查询失败(server ok:false) → RUNTIME 退 1（collectErrorExit 兜底口径）', async () => {
  collectorState.countFail = true;
  try {
    // --page 2 --dry-run:定位成功即撞 count,不进段循环,输出面最小
    const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV1dmCLI', '--page', '2', '--dry-run']));
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'RUNTIME');
    assert.match(body.error, /danmaku count 查询失败/);
  } finally { collectorState.countFail = false; }
});

// ── collect 端到端（mock B 站 seg.so 二进制 protobuf + mock collector 全链路）──

test('collect 成功:两 P 串行(seg 304 越界正常终态),回执 JSON 完整,ingest 批落 mock collector', async () => {
  // 前置用例(xml 探针等)可能推进过 mock 计数——成功用例断言绝对值,先清零保证顺序无关
  collectorState.ingests.length = 0;
  collectorState.verifyCalls = 0;
  collectorState.countCalls.clear();
  const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV1dmCLI']));
  assert.equal(r.code, 0, r.out + r.err);
  const receipt = JSON.parse(r.out);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.partial, false);
  assert.equal(receipt.dry_run, false);
  assert.equal(receipt.video.bvid, 'BV1dmCLI');
  assert.equal(receipt.video.aid, 500);
  assert.equal(receipt.fetched_total, 4, 'P1 三条(seg1 双条+seg2 一条)+ P2 一条(seg2 落 304)');
  assert.deepEqual(receipt.store, { inserted: 4, updated: 0, requests: 2 }, '默认 batchSize 2000 → 每 P 尾批冲一次');
  assert.equal(receipt.before_rows, 0);
  assert.equal(receipt.after_rows, 4);
  assert.deepEqual(receipt.stat_danmaku, { view: null }, 'extra 路径不回查 view → 哨兵 null');
  assert.ok(receipt.verify && receipt.verify.counts.rows === 4, '内嵌 verify 段嵌入回执');
  assert.equal(receipt.bili_requests, 3, 'P1 两段 + P2 一段(N=ceil(100/360)=1)后即 304');
  assert.equal(collectorState.ingests.length, 2, '每 P 尾批冲一次(P1 3 条 + P2 1 条)');
  assert.equal(collectorState.verifyCalls, 1);
});

test('collect --dry-run:回执 dry_run + would_requests/would_rows,mock collector 零 ingest/verify', async () => {
  const before = collectorState.ingests.length;
  const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV1dmCLI', '--dry-run']));
  assert.equal(r.code, 0, r.out + r.err);
  const receipt = JSON.parse(r.out);
  assert.equal(receipt.dry_run, true);
  assert.equal(receipt.partial, false);
  assert.deepEqual(receipt.store, { would_requests: 2, would_rows: 4 });
  assert.equal(receipt.verify, null, 'dry-run 跳过内嵌 verify');
  assert.equal(collectorState.ingests.length, before, '零写库请求');
});

test('collect 匿名(无 cookie):正常采完非 partial（D9;stderr 提示匿名采集）', async () => {
  const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV1dmCLI', '--page', '1']));
  assert.equal(r.code, 0, r.out + r.err);
  const receipt = JSON.parse(r.out);
  assert.equal(receipt.partial, false);
  assert.equal(receipt.fetched_total, 3);
  assert.match(r.err, /匿名/, 'stderr 带匿名采集提示');
});

test('collect --cookie-file 给路径:正常读取作 Cookie 头,采完非 partial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'danmaku-cli-'));
  try {
    const ck = join(dir, 'cookie.txt');
    writeFileSync(ck, 'SESSDATA=mock-cookie-value', 'utf-8');
    const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV1dmCLI', '--page', '2', '--cookie-file', ck]));
    assert.equal(r.code, 0, r.out + r.err);
    const receipt = JSON.parse(r.out);
    assert.equal(receipt.partial, false);
    assert.equal(receipt.pages.length, 1, '--page 2 只采 P2');
    assert.match(r.err, /cookie 来源/, 'stderr 带 cookie 来源日志');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collect BV404 → NOT_FOUND 退 5（弹幕挂在 videos.id,先采视频）', async () => {
  const r = await cli(await collectArgs(['danmaku', 'collect', '--bvid', 'BV404']));
  assert.equal(r.code, 5);
  const body = JSON.parse(r.out);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'NOT_FOUND');
  assert.match(body.error, /video not found/);
});

// ── verify（纯本地 --db 只读;显式 --server 触发 openDbOrEmit 忽略警告,对齐 comments tree/verify 先例）──

/** 样本库:BV1dmVERIFY 两页同 P 弹幕两条(30s/mode1/w9 与 90s/mode4/w6)——直插 danmaku 表,不动生产链路。 */
function seedDanmakuDb(dir: string): string {
  const dbPath = join(dir, 'test.db');
  const db: Database.Database = openDb(dbPath);
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1dmVERIFY', title: '校验视频', creator: { source_uid: '1', name: 'UP酱' }, extra: {}, duration: 120, published_at: 1_700_000_000_000 },
    tracks: [],
  });
  const videoId = (db.prepare('SELECT id FROM videos WHERE source_vid = ?').get('BV1dmVERIFY') as { id: number }).id;
  const ins = db.prepare(`INSERT INTO danmaku (
    id_str, video_id, cid, page, progress_ms, mode, fontsize, color, mid_hash, content,
    ctime_s, weight, pool, action, first_seen_at, last_seen_at, batch_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('d1', videoId, 111, 1, 30_000, 1, 25, 16777215, 'aaaa1111', '弹一', 1_700_000_000, 9, 0, null, 1, 1, 'b1');
  ins.run('d2', videoId, 111, 1, 90_000, 4, 25, 16777215, 'aaaa2222', '弹二', 1_700_000_060, 6, 0, null, 1, 1, 'b1');
  db.close();
  return dbPath;
}

test('verify:真实临时库读 danmaku 表出 R1-R5 统计(峰值分钟并列取小 / weight 分位 / --server 忽略警告)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'danmaku-cli-'));
  try {
    const dbPath = seedDanmakuDb(dir);
    const r = await cli(['--db', dbPath, '--server', 'http://127.0.0.1:1', '--token', 't', 'danmaku', 'verify', '--bvid', 'BV1dmVERIFY']);
    assert.equal(r.code, 0);
    assert.match(r.err, /只读本地 --db/, 'DB-only 组 --server 忽略警告');
    const body = JSON.parse(r.out) as {
      ok: boolean; bvid: string;
      counts: { rows: number; pages: number; by_page: Array<{ rows: number }> };
      timeline: { min_progress_ms: number; max_progress_ms: number; peak_minute: { from_ms: number; rows: number } | null };
      mode: Record<string, number>;
      weight: { p50: number; p90: number; max: number };
      integrity: { dup_id: number; negative_progress: number };
      ctime: { min_s: number; max_s: number };
    };
    assert.equal(body.ok, true);
    assert.equal(body.bvid, 'BV1dmVERIFY');
    assert.equal(body.counts.rows, 2);
    assert.equal(body.counts.pages, 1);
    assert.equal(body.counts.by_page[0].rows, 2);
    assert.deepEqual(body.mode, { '1': 1, '4': 1 }, 'mode 分布键升序十进制字符串');
    assert.deepEqual(body.weight, { p50: 6, p90: 9, max: 9 }, 'nearest-rank 分位:排序 [6,9]');
    assert.deepEqual(body.timeline.peak_minute, { from_ms: 0, rows: 1 }, '30s/90s 分落 0/60s 桶,并列取 from_ms 小者');
    assert.equal(body.timeline.min_progress_ms, 30_000);
    assert.equal(body.timeline.max_progress_ms, 90_000);
    assert.deepEqual(body.integrity, { dup_id: 0, negative_progress: 0 });
    assert.deepEqual(body.ctime, { min_s: 1_700_000_000, max_s: 1_700_000_060 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify:BV 不在库 → NOT_FOUND 退 5;--bvid 缺失 → ARGS 退 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'danmaku-cli-'));
  try {
    const dbPath = seedDanmakuDb(dir);
    const missing = await cli(['--db', dbPath, 'danmaku', 'verify', '--bvid', 'BVmissing']);
    assert.equal(missing.code, 5);
    assert.equal(JSON.parse(missing.out).code, 'NOT_FOUND');
    const noArg = await cli(['--db', dbPath, 'danmaku', 'verify']);
    assert.equal(noArg.code, 2);
    assert.equal(JSON.parse(noArg.out).code, 'ARGS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

after(async () => {
  await new Promise<void>((res) => biliServer.close(() => res()));
  await new Promise<void>((res) => collectorServer.close(() => res()));
});
