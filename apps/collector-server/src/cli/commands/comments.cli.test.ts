// comments 命令组子进程端到端（C4 collect / C5 tree·verify）：真 CLI 进程 + 进程内 mock server
// （collector HTTP 四端点 + mock B 站 nav/wbi/main），覆盖 --help 全选项、ARGS 各退 2、
// collect 成功回执/dry-run/批量 bvid-file、tree 缩进文本、verify JSON（--stat-reply 启 R9）。
// 纯函数与编排判停（mock 注入 sleep/fetch）见 comments.test.ts；真实 B 站通路不在本文件（真实验收由主会话执行）。
//
// 【为何必须子进程】node:test 子隔离模式下父子走 process.stdout 二进制协议帧；进程内 stub
// stdout 跑真实异步网络 I/O 会把协议帧吸进捕获串、父进程丢测试结果（comments.test.ts 头注详述）——
// collect 全链路含真 fetch/http server，只能像 stats.cli.test.ts 一样 execFile 子进程跑。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | help 全选项 / 双缺·mismatch·mode 非法·cookie 缺失 ARGS 退 2 / collect 成功+dry-run+批量 / tree+verify+--stat-reply / 未知视频 NOT_FOUND | 通过 | 批量 case 含一次真实 5s 视频间隔（sleepMs 无注入口，接受并在此登记） |
// | R2 | +4（16）：单视频 BV404 退 5 / server 不可达退 3 / nav -101 退 1 重取指引 / nav -400 退 1 无指引 | 通过 | magicNav 注入（collector 视频路由按 BV 号预置一次 nav 失败码）|

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
import { upsertComments, clearAndSetPins, type CommentUpsertRow } from '../../db/comments.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/cli/commands
const MAIN_TS = join(HERE, '..', 'main.ts');
const APP_ROOT = resolve(HERE, '../../..');

// ── mock B 站（nav wbi keys + wbi/main 两页循环；roots rcount=0 → 无楼中楼请求）──

const WBI_IMG = '7cd084941338484aae1ad9425b84077c';
const WBI_SUB = '4932caff0ff746eab6f01bf08b70ac45';
const okData = (data: unknown) => ({ code: 0, message: '0', ttl: 1, data });
const errBody = (code: number, message = 'mock 拦截') => ({ code, message });

// nav 失败注入（collector 视频路由按 BV 号置码,bili nav 消费一次后归零——模拟 cookie 失效/风控页）
const magicNav = { code: 0 };

function cliRoot(o: { rpid: number; ctime: number; like?: number }) {
  return {
    rpid: o.rpid, rpid_str: String(o.rpid), root: 0, root_str: '0', parent: 0, parent_str: '0',
    dialog: 0, dialog_str: '0', mid: 9000 + o.rpid, mid_str: String(9000 + o.rpid),
    member: { uname: `用户${o.rpid}` }, content: { message: `评论${o.rpid}` },
    like: o.like ?? 1, rcount: 0, count: 0, ctime: o.ctime, state: 0,
  };
}

// wbi/main 两页（奇数次请求=首页根 1/2，偶数次=末页根 3+置顶 10 is_end）——多轮 collect 循环复用
const MAIN_PAGES = [
  okData({
    replies: [cliRoot({ rpid: 1, ctime: 1_700_000_001 }), cliRoot({ rpid: 2, ctime: 1_700_000_002 })],
    cursor: { is_end: false, all_count: 3, pagination_reply: { next_offset: 'TOK1' } },
    top: {}, upper: { mid: 999 },
  }),
  okData({
    replies: [cliRoot({ rpid: 3, ctime: 1_700_000_003 })],
    cursor: { is_end: true, all_count: 3, pagination_reply: { next_offset: null } },
    top: { upper: cliRoot({ rpid: 10, ctime: 1_700_000_010, like: 9 }) },
    upper: { mid: 999 },
  }),
];

const biliServer: Server = (function makeBili() {
  let mainCalls = 0;
  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    const json = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.includes('/x/web-interface/nav')) {
      if (magicNav.code) {
        const c = magicNav.code;
        magicNav.code = 0;
        return json(errBody(c));
      }
      return json(okData({ isLogin: true, wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${WBI_IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${WBI_SUB}.png` } }));
    }
    if (url.includes('/x/v2/reply/wbi/main')) {
      return json(MAIN_PAGES[mainCalls++ % 2]);
    }
    json({ code: -400, message: `mock bili 未路由: ${url}` });
  });
})();

// ── mock collector server（视频详情 / count / ingest / verify；count 首查 0 行后续 3 行撑完整轮守卫）──

const collectorState = { ingestBatches: 0, countCalls: new Map<string, number>() };

const collectorServer: Server = (function makeCollector() {
  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    const json = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const m = url.match(/^\/api\/videos\/bilibili\/([^/?]+)/);
    if (m) {
      // BV404 → video:null（NOT_FOUND 路径）；BVNAV* → 预置一次 nav 失败码；其余返回带 extra.aid 的详情
      const vid = decodeURIComponent(m[1]);
      if (vid === 'BVNAVFAIL') magicNav.code = -101;
      if (vid === 'BVNAV400') magicNav.code = -400;
      return json(vid === 'BV404'
        ? { video: null }
        : { video: { id: 1, source_vid: vid, title: 'CLI测试视频', extra: JSON.stringify({ aid: 500 }) } });
    }
    if (url.startsWith('/api/comments/count')) {
      const bvid = new URL(url, 'http://x').searchParams.get('bvid') ?? '?';
      const n = collectorState.countCalls.get(bvid) ?? 0;
      collectorState.countCalls.set(bvid, n + 1);
      // 首查 0 行（auto→full / 水位 0），复查 3 行 ≥ all_count÷1.2（完整轮守卫通过）
      return json(n === 0 ? { ok: true, rows: 0, roots: 0, max_ctime_s: null } : { ok: true, rows: 3, roots: 3, max_ctime_s: 1_700_000_003 });
    }
    if (url.startsWith('/api/comments/ingest')) {
      let body: { replies?: unknown[]; full_scan?: boolean } = {};
      req.on('data', (c: Buffer) => {
        try { body = { ...body, ...(JSON.parse(String(c)) as typeof body) }; } catch { /* 忽略坏块 */ }
      });
      return req.on('end', () => {
        collectorState.ingestBatches++;
        const n = Array.isArray(body.replies) ? body.replies.length : 0;
        json(body.full_scan
          ? { ok: true, inserted: n, updated: 0, missing: { candidates: 1, confirmed: 2 } }
          : { ok: true, inserted: n, updated: 0 });
      });
    }
    if (url.startsWith('/api/comments/verify')) {
      return json({
        ok: true, counts: { roots: 4, floors: 0, total: 4 },
        integrity: { orphan_floor: 0, dangling_parent: 0, dangling_dialog: 0, rcount_mismatch: 0 },
        coverage: { ratio: 1 },
      });
    }
    json({ ok: false, error: `mock collector 未路由: ${url}` });
  });
})();

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
  delete env.COLLECTOR_BILI_COOKIE_FILE; // cookie 一律显式 --cookie-file，缺失 case 才可断言
  return new Promise((resolve_) => {
    execFile('node', ['--import', 'tsx', MAIN_TS, ...args], { cwd: APP_ROOT, env }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve_({ code: typeof code === 'number' ? code : 1, out: String(stdout), err: String(stderr) });
    });
  });
}

// collect 专用参数（--db 给临时路径占位：collect 不开库；--server 指向 mock collector）
const collectArgs = async (rest: string[]): Promise<string[]> => {
  const { collectorUrl } = await started;
  return ['--db', join(tmpdir(), 'unused.db'), '--server', collectorUrl, '--token', 't', ...rest];
};

// cookie 临时文件
function writeCookie(dir: string): string {
  const p = join(dir, 'cookie.txt');
  writeFileSync(p, 'SESSDATA=mock-cookie-value', 'utf-8');
  return p;
}

// ── help 全选项 ──

test('collect --help 含全部选项（bvid/aid/bvid-file/mode/sort/max-pages/max-floor-pages/refresh-roots/max-requests/page-interval-ms/batch-size/dry-run/cookie-file）', async () => {
  const r = await cli(await collectArgs(['comments', 'collect', '--help']));
  assert.equal(r.code, 0);
  for (const flag of ['--bvid', '--aid', '--bvid-file', '--mode', '--sort', '--max-pages', '--max-floor-pages', '--refresh-roots', '--max-requests', '--page-interval-ms', '--batch-size', '--dry-run', '--cookie-file']) {
    assert.ok(r.out.includes(flag), `help 缺 ${flag}`);
  }
});

test('tree/verify --help 含各自选项（--bvid/--limit 与 --bvid/--stat-reply）', async () => {
  const tree = await cli(await collectArgs(['comments', 'tree', '--help']));
  assert.equal(tree.code, 0);
  assert.ok(tree.out.includes('--bvid') && tree.out.includes('--limit'));
  const verify = await cli(await collectArgs(['comments', 'verify', '--help']));
  assert.equal(verify.code, 0);
  assert.ok(verify.out.includes('--bvid') && verify.out.includes('--stat-reply'));
});

// ── ARGS 退 2 族 ──

test('collect 双缺（无 bvid/aid/bvid-file）→ ARGS 退 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    const ck = writeCookie(dir);
    const r = await cli(await collectArgs(['comments', 'collect', '--cookie-file', ck]));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--bvid 或 --aid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collect --aid 与库内 extra.aid 不一致 → aid_mismatch ARGS 退 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    const ck = writeCookie(dir);
    const r = await cli(await collectArgs(['comments', 'collect', '--bvid', 'BV1', '--aid', '999', '--cookie-file', ck]));
    assert.equal(r.code, 2);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'ARGS');
    assert.equal(body.collect_code, 'aid_mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collect --mode 非法 → ARGS 退 2', async () => {
  const r = await cli(await collectArgs(['comments', 'collect', '--bvid', 'BV1', '--mode', 'bogus']));
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).code, 'ARGS');
  assert.match(r.err, /--mode/);
});

test('collect cookie 缺失（无 --cookie-file 且 env 清空）→ ARGS 退 2 带重取指引', async () => {
  const r = await cli(await collectArgs(['comments', 'collect', '--bvid', 'BV1']));
  assert.equal(r.code, 2);
  assert.match(r.out, /ARGS/);
  assert.match(r.err, /bili-cookie-from-chrome/);
});

// ── collect 端到端（mock B 站 + mock collector 全链路，子进程真跑）──

test('collect 成功回执：mode full / fetched.total 4（含置顶）/ 视频标题 / stderr 采集日志', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    const ck = writeCookie(dir);
    const r = await cli(await collectArgs([
      'comments', 'collect', '--bvid', 'BV1', '--cookie-file', ck, '--page-interval-ms', '0',
    ]));
    assert.equal(r.code, 0);
    const receipt = JSON.parse(r.out) as {
      ok: boolean; mode: string; fetched: { total: number; roots: number; floors: number; pins: number };
      video: { title: string | null }; partial?: boolean; verify: Record<string, unknown> | null;
      missing: { candidates: number; confirmed: number } | null; store: { requests: number };
    };
    assert.equal(receipt.ok, true);
    assert.equal(receipt.mode, 'full');
    assert.equal(receipt.partial, false, '完整轮无 partial 标记');
    assert.equal(receipt.fetched.total, 4, '根 3 + 置顶 1');
    assert.equal(receipt.video.title, 'CLI测试视频');
    assert.ok(receipt.verify != null, '非 dry-run 内嵌 verify');
    assert.ok(receipt.missing != null, '完整轮 missing 对账进回执');
    assert.ok(receipt.store.requests >= 2, '尾批 + full_scan 标记批');
    assert.match(r.err, /\[comments\] BV1/);
    assert.match(r.err, /\[comments\] 完成/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collect --dry-run：dry_run true / store 段 would_requests+rows / 零真实写库（ingest 端点零调用增量）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    collectorState.countCalls.clear(); // count 首查 0 行是 auto→full 的前提,各用例独立起算
    const ck = writeCookie(dir);
    const before = collectorState.ingestBatches;
    const r = await cli(await collectArgs([
      'comments', 'collect', '--bvid', 'BV1', '--cookie-file', ck, '--page-interval-ms', '0', '--dry-run',
    ]));
    assert.equal(r.code, 0);
    const receipt = JSON.parse(r.out) as {
      dry_run: boolean; store: { would_requests: number; rows: number }; partial?: boolean;
    };
    assert.equal(receipt.dry_run, true);
    assert.ok(receipt.store.would_requests >= 1);
    assert.ok(receipt.store.rows >= 4, '解析计数照常');
    assert.equal(collectorState.ingestBatches, before, 'dry-run 不发 ingest 请求');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('批量 --bvid-file：BV1 成功 + BV404 失败不阻断 → batch 回执 succeeded 1 / failed 1（注：含一次真实 5s 视频间隔）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    collectorState.countCalls.clear(); // BV1 首查回 0 行 → auto→full(批量语义与单独跑一致)
    const ck = writeCookie(dir);
    const file = join(dir, 'bvids.txt');
    writeFileSync(file, 'BV1\nBV404\n', 'utf-8');
    const r = await cli(await collectArgs([
      'comments', 'collect', '--bvid-file', file, '--cookie-file', ck, '--page-interval-ms', '0',
    ]));
    assert.equal(r.code, 0, '批量失败不阻断、进程仍正常退 0');
    const receipt = JSON.parse(r.out) as {
      batch: boolean; ok: boolean; total: number; succeeded: number; failed: number;
      results: Array<{ bvid: string; ok: boolean; code?: string }>;
    };
    assert.equal(receipt.batch, true);
    assert.equal(receipt.total, 2);
    assert.equal(receipt.succeeded, 1);
    assert.equal(receipt.failed, 1);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.results[1].bvid, 'BV404');
    assert.equal(receipt.results[1].code, 'video_not_found');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collect 单视频 BV404（库无此视频）→ NOT_FOUND 退 5', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    const ck = writeCookie(dir);
    const r = await cli(await collectArgs(['comments', 'collect', '--bvid', 'BV404', '--cookie-file', ck]));
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
    assert.match(r.err, /先采视频再谈评论/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collect server 不可达（getVideo 连接拒绝）→ SERVER_UNREACHABLE 退 3（通路错误不被包成 RUNTIME）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    const ck = writeCookie(dir);
    const r = await cli(['--db', join(tmpdir(), 'unused.db'), '--server', 'http://127.0.0.1:1', '--token', 't',
      'comments', 'collect', '--bvid', 'BV1', '--cookie-file', ck]);
    assert.equal(r.code, 3, 'ExitCodes.SERVER_UNREACHABLE');
    assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collect nav -101（cookie 失效,BVNAVFAIL 预置）→ RUNTIME 退 1 带重取指引', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    const ck = writeCookie(dir);
    const r = await cli(await collectArgs(['comments', 'collect', '--bvid', 'BVNAVFAIL', '--cookie-file', ck]));
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out) as { code: string; reason?: string };
    assert.equal(body.code, 'RUNTIME');
    assert.equal(body.reason, 'need_login');
    assert.match(r.err, /重取 cookie/);
    assert.match(r.err, /bili-cookie-from-chrome/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collect nav 其他失败（BVNAV400 预置 -400）→ RUNTIME 退 1 且不带 cookie 指引', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    const ck = writeCookie(dir);
    const r = await cli(await collectArgs(['comments', 'collect', '--bvid', 'BVNAV400', '--cookie-file', ck]));
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).code, 'RUNTIME');
    assert.match(r.err, /nav 失败/);
    assert.ok(!r.err.includes('重取 cookie:'), '-400 非 cookie 失效,不挂重取指引');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── tree / verify（纯本地 --db 只读；显式 --server 触发忽略警告）──

// 样本库：BV1 → 根 101/102 + 楼 201-204（含二层三层/对象已删/折叠/仅自己可见）+ 孤儿楼 301 + 置顶 101
function seedDb(dir: string): { dbPath: string } {
  const dbPath = join(dir, 'test.db');
  const db: Database.Database = openDb(dbPath);
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '树视频', creator: { source_uid: '1', name: 'UP酱' }, extra: {}, duration: 60, published_at: 1_700_000_000_000 },
    tracks: [],
  });
  const videoId = (db.prepare('SELECT id FROM videos WHERE source_vid = ?').get('BV1') as { id: number }).id;
  const up = (o: Partial<CommentUpsertRow> & { rpid_str: string }): CommentUpsertRow => ({
    root_rpid: '0', parent_rpid: '0', dialog_rpid: '0', mid_str: null, uname: null, member: null,
    message: null, content: null, like_count: 0, rcount: 0, reply_total: 0, ctime_s: null,
    ip_location: null, state: 0, invisible: 0, folded: 0, up_like: 0, up_reply: 0, parent_reply_name: null, ...o,
  });
  upsertComments(db, {
    videoId, upperMid: '9001', fetchedAt: 1_700_000_000_000, batchId: 'b1', page: 1, sort: 'time',
    replies: [
      up({ rpid_str: '101', mid_str: '9001', uname: 'UP酱', message: '根评论UP', like_count: 20, ctime_s: 1_700_000_000, ip_location: '上海', up_reply: 1, rcount: 3 }),
      up({ rpid_str: '102', mid_str: '8002', uname: '张三', message: '根评论张三', like_count: 10, ctime_s: 1_700_000_100, state: 5 }),
      up({ rpid_str: '201', root_rpid: '101', parent_rpid: '101', dialog_rpid: '101', mid_str: '8003', uname: '李四', message: '楼1 回复根', like_count: 3, ctime_s: 1_700_000_200 }),
      up({ rpid_str: '202', root_rpid: '101', parent_rpid: '999', dialog_rpid: '101', mid_str: '8004', uname: '王五', message: '楼2 对象已删', ctime_s: 1_700_000_300 }),
      up({ rpid_str: '203', root_rpid: '101', parent_rpid: '201', dialog_rpid: '201', mid_str: '8005', uname: '赵六', message: '楼3 二层', state: 17, ctime_s: 1_700_000_400 }),
      up({ rpid_str: '204', root_rpid: '101', parent_rpid: '202', dialog_rpid: '203', mid_str: '8006', uname: '钱七', message: '楼4 三层拍平', folded: 1, ctime_s: 1_700_000_500 }),
      up({ rpid_str: '301', root_rpid: '777', parent_rpid: '777', dialog_rpid: '777', mid_str: '8007', uname: '孤儿', message: '根已删的楼', ctime_s: 1_700_000_600 }),
    ],
  });
  clearAndSetPins(db, videoId, [{ rpid_str: '101', kind: 'upper' }]);
  db.close();
  return { dbPath };
}

test('tree：显式 --server 触发只读警告 + 缩进文本含树头/置顶/回复指向/孤儿组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    const { dbPath } = seedDb(dir);
    const r = await cli(['--db', dbPath, '--server', 'http://127.0.0.1:1', '--token', 't', 'comments', 'tree', '--bvid', 'BV1']);
    assert.equal(r.code, 0);
    assert.match(r.err, /只读本地 --db/, 'DB-only 组 --server 忽略警告');
    assert.ok(r.out.includes('评论区树:共 7 条(根 2 / 楼中楼 5)'));
    assert.ok(r.out.includes('【赞 20】@UP酱(UP主)'), '置顶根头');
    assert.ok(r.out.includes('回复 @UP酱'), '楼中楼回复指向');
    assert.ok(r.out.includes('根已删除的楼层(1 条)'), '孤儿组');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify：JSON 回执 counts（根 2 / 楼 5）+ --stat-reply 1 启 R9 root_count_gap；--server 警告同样出现', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    const { dbPath } = seedDb(dir);
    const r = await cli(['--db', dbPath, '--server', 'http://127.0.0.1:1', '--token', 't', 'comments', 'verify', '--bvid', 'BV1', '--stat-reply', '1']);
    assert.equal(r.code, 0);
    assert.match(r.err, /只读本地 --db/);
    const body = JSON.parse(r.out) as {
      ok: boolean; bvid: string; counts: { roots: number; floors: number; total: number };
      integrity: { root_count_gap: number };
    };
    assert.equal(body.ok, true);
    assert.equal(body.bvid, 'BV1');
    assert.equal(body.counts.roots, 2);
    assert.equal(body.counts.floors, 5);
    assert.equal(body.counts.total, 7);
    assert.equal(body.integrity.root_count_gap, 1, '库内 7 行 vs 外部哨兵 1 → 偏差 >10% → R9 报缺口');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify 未知视频 → NOT_FOUND 退 5', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-cli-'));
  try {
    const { dbPath } = seedDb(dir);
    const r = await cli(['--db', dbPath, '--token', 't', 'comments', 'verify', '--bvid', 'BVNOPE']);
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.out).code, 'NOT_FOUND');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

after(async () => {
  biliServer.close();
  collectorServer.close();
});
