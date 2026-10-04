// tags.ts commander 装配层测试：子进程跑真 CLI；list 直读临时 DB（applyVideoTags 种子），
// apply/remove 走本地 mock HTTP server。覆盖三 action 成功 + --source/--names 校验 + HTTP 错误归一化。
// 纯函数（tagsList/tagsApply/tagsRemove）见 tags.test.ts。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | list（默认/--source ai/--q）+ apply/remove 成功（断言请求体）+ ARGS ×2 + SERVER_UNREACHABLE + 5xx RUNTIME | 通过 | |
// | R2 | 排序：list --sort name 升降 + 非法 --sort ARGS 退 2 | 通过 | 2026-08-25 全端点排序；pnpm qa 全绿 |
// | R3 | --source douyin 合法化（原「非法平台」样本换 bogus；文案加 douyin） | 通过 | 2026-08-29 S2 抖音平台化 |

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
import { applyVideoTags } from '../../db/tags.js';

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

interface SrvReq { method: string; path: string; body: Record<string, unknown> | null }
interface SrvRes { status: number; json?: unknown }
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

const DEAD = 'http://127.0.0.1:1';
const args = (dbPath: string, serverUrl: string, rest: string[]): string[] =>
  ['--db', dbPath, '--server', serverUrl, '--token', 'tok-1', ...rest];

function setup(): { db: Database.Database; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-tags-cli-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '甲', creator: { source_uid: '1', name: 'UP' }, extra: {}, duration: 60, published_at: 1 },
    tracks: [],
  });
  // 种子标签：BV1 打 ai 档「面试题」+ manual 档「精选」
  applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV1' }], ['面试题'], 'ai');
  applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV1' }], ['精选'], 'manual');
  return { db, dbPath: join(dir, 'test.db'), dir };
}

// ── tags list（直读 DB）──

test('tags list：返回 {items,total}，含各档计数，退 0', async () => {
  const { db, dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['tags', 'list']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.equal(data.total, 2);
    const byName = Object.fromEntries(data.items.map((t: { name: string }) => [t.name, t]));
    assert.deepEqual(byName['面试题'].counts, { manual: 0, batch: 0, ai: 1, system: 0, total: 1 });
    assert.deepEqual(byName['精选'].counts, { manual: 1, batch: 0, ai: 0, system: 0, total: 1 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags list --scope ai：只列该档 >0 的标签', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['tags', 'list', '--scope', 'ai']));
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.deepEqual(data.items.map((t: { name: string }) => t.name), ['面试题']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tags list --q：名称模糊过滤', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['tags', 'list', '--q', '精选']));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).total, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tags list --scope 非法 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['tags', 'list', '--scope', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--scope 必须是 manual\/batch\/ai/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tags list --source 非法平台 → ARGS 退 2；合法平台（含 douyin）透传退 0', async () => {
  const { dir, dbPath } = setup();
  try {
    const bad = await cli(args(dbPath, DEAD, ['tags', 'list', '--source', 'bogus']));
    assert.equal(bad.code, 2);
    assert.equal(JSON.parse(bad.out).code, 'ARGS');
    assert.match(bad.err, /--source 必须是 bilibili\/youtube\/douyin/);
    // douyin 是合法平台（2026-08-29 S2 平台化）：透传退 0，0 使用标签按平台收窄计数后仍列出
    const dy = await cli(args(dbPath, DEAD, ['tags', 'list', '--source', 'douyin']));
    assert.equal(dy.code, 0);
    const okRun = await cli(args(dbPath, DEAD, ['tags', 'list', '--source', 'youtube']));
    assert.equal(okRun.code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tags list：DB 缺失 → DB_UNREADABLE 退 4', async () => {
  const r = await cli(args(join(tmpdir(), 'cli-tags-no-such.db'), DEAD, ['tags', 'list']));
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.out).code, 'DB_UNREADABLE');
});

// ── tags apply（走 server）──

test('tags apply：POST /api/tags/apply body 形状正确，透传回执，退 0', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { applied: 1, missing: [] } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'apply', 'BV1', 'BV2', '--names', 'ai, 面试题', '--scope', 'batch']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { applied: 1, missing: [] });
    assert.equal(srv.reqs[0]!.path, '/api/tags/apply');
    // names 逗号拆分 + trim；items 逐 vid 映射 source=bilibili（--source 缺省）；scope 档位透传
    assert.deepEqual(srv.reqs[0]!.body, {
      items: [{ source: 'bilibili', source_vid: 'BV1' }, { source: 'bilibili', source_vid: 'BV2' }],
      names: ['ai', '面试题'],
      scope: 'batch',
    });
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags apply --source youtube：items source 跟随平台（YouTube 打标通道）', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { inserted: 1, missing: [] } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'apply', 'ytvid00001', '--names', 'ai', '--scope', 'ai', '--source', 'youtube']));
    assert.equal(r.code, 0);
    assert.deepEqual(srv.reqs[0]!.body, {
      items: [{ source: 'youtube', source_vid: 'ytvid00001' }],
      names: ['ai'],
      scope: 'ai',
    });
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags apply：--scope 非法 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'apply', 'BV1', '--names', 'a', '--scope', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags apply：--source 平台非法 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    // douyin 已是合法平台（2026-08-29 S2），非法值换 bogus
    const r = await cli(args(dbPath, srv.url, ['tags', 'apply', 'BV1', '--names', 'a', '--source', 'bogus']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags apply：--names 全空白 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'apply', 'BV1', '--names', ' , ']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.match(r.err, /--names 不能为空/);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags apply：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['tags', 'apply', 'BV1', '--names', 'a']));
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
    assert.match(r.err, /COLLECTOR_SERVER 指对了吗/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tags apply：server 409 → RUNTIME 退 1（server 拒绝）', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 409, json: { error: 'dup' } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'apply', 'BV1', '--names', 'a']));
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).code, 'RUNTIME');
    assert.match(r.err, /server 拒绝/);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── tags remove（走 server）──

test('tags remove：省略 --scope → body 不含 scope 键（删全档），退 0', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { removed: 2 } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'remove', 'BV1', '--names', 'ai']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { removed: 2 });
    assert.equal(srv.reqs[0]!.path, '/api/tags/remove');
    const body = srv.reqs[0]!.body as Record<string, unknown>;
    assert.deepEqual(body, { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['ai'] });
    assert.ok(!('scope' in body), '省略 --scope 时 body 不含 scope 键');
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags remove --scope manual：档位透传', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { removed: 1 } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'remove', 'BV1', '--names', '精选', '--scope', 'manual']));
    assert.equal(r.code, 0);
    assert.deepEqual(srv.reqs[0]!.body, { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['精选'], scope: 'manual' });
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags remove：--scope 非法 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'remove', 'BV1', '--names', 'a', '--scope', 'x']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags remove：--names 全空白 → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'remove', 'BV1', '--names', ' ']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags remove：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['tags', 'remove', 'BV1', '--names', 'a']));
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tags remove：server 500 → RUNTIME 退 1', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 500, json: { error: 'db busy' } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'remove', 'BV1', '--names', 'a']));
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).code, 'RUNTIME');
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 2026-08-25 全端点排序：list --sort/--desc 透传 + 非法 --sort ARGS ──
test('tags list：--sort name 升降 + 非法 --sort → ARGS 退 2', async () => {
  const { dir, dbPath } = setup();
  try {
    // 种子用 setup 自带：精选(manual) + 面试题(ai)——字典序 精(U+7CBE) < 面(U+9762)
    // --sort name --desc=false：字典序升序
    const r = await cli(args(dbPath, DEAD, ['tags', 'list', '--sort', 'name', '--desc=false']));
    assert.equal(r.code, 0);
    assert.deepEqual((JSON.parse(r.out).items as Array<{ name: string }>).map((t) => t.name), ['精选', '面试题']);
    // --sort name（缺省 desc）：降序
    const r2 = await cli(args(dbPath, DEAD, ['tags', 'list', '--sort', 'name']));
    assert.deepEqual((JSON.parse(r2.out).items as Array<{ name: string }>).map((t) => t.name), ['面试题', '精选']);
    // 非法 --sort → ARGS 退 2
    const bad = await cli(args(dbPath, DEAD, ['tags', 'list', '--sort', 'bogus']));
    assert.equal(bad.code, 2);
    assert.match(bad.err, /非法 --sort: bogus（可选: count\|name\|created_at）/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 2026-10-05 P1-8 标签库纠错：tags rename / delete（走 server PATCH/DELETE /api/tags/:id）──
// 红灯轮：子命令未实现 → commander unknown action 全红；实现后转绿。

test('tags rename：PATCH /api/tags/:id body {name} 形状正确，透传回执，退 0', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, tag: { id: 7, name: '面试真题', created_at: 1 } } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'rename', '7', '--name', '面试真题']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, tag: { id: 7, name: '面试真题', created_at: 1 } });
    assert.equal(srv.reqs[0]!.method, 'PATCH');
    assert.equal(srv.reqs[0]!.path, '/api/tags/7');
    assert.deepEqual(srv.reqs[0]!.body, { name: '面试真题' });
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags rename：--name 首尾空白 → trim 后透传', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true, tag: { id: 7, name: '面试真题', created_at: 1 } } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'rename', '7', '--name', ' 面试真题 ']));
    assert.equal(r.code, 0);
    assert.deepEqual(srv.reqs[0]!.body, { name: '面试真题' });
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags rename：id 不存在 server 404 → NOT_FOUND 退 5', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 404, json: { ok: false, error: 'not found' } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'rename', '999', '--name', '新名']));
    assert.equal(r.code, 5);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(body.status, 404);
    assert.match(r.err, /404/);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags rename：撞已有名 server 409 → RUNTIME 退 1（改名冲突带 status/body）', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 409, json: { ok: false, error: 'tag name already exists' } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'rename', '7', '--name', '已存在名']));
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'RUNTIME');
    assert.equal(body.status, 409);
    assert.match(r.err, /409/);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags rename：--name 全空白 → ARGS 退 2，不发请求', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'rename', '7', '--name', '   ']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags rename：id 非整数 → ARGS 退 2，不发请求', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'rename', 'abc', '--name', '新名']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags rename：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['tags', 'rename', '7', '--name', '新名']));
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tags delete：DELETE /api/tags/:id，透传 {ok:true}，退 0', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'delete', '7']));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true });
    assert.equal(srv.reqs[0]!.method, 'DELETE');
    assert.equal(srv.reqs[0]!.path, '/api/tags/7');
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags delete：id 不存在 server 404 → NOT_FOUND 退 5', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 404, json: { ok: false, error: 'not found' } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'delete', '999']));
    assert.equal(r.code, 5);
    const body = JSON.parse(r.out);
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(body.status, 404);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags delete：id 非整数 → ARGS 退 2，不发请求', async () => {
  const { dir, dbPath } = setup();
  const srv = await startMockServer(() => ({ status: 200, json: { ok: true } }));
  try {
    const r = await cli(args(dbPath, srv.url, ['tags', 'delete', 'x7']));
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).code, 'ARGS');
    assert.equal(srv.reqs.length, 0);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('tags delete：server 不可达 → SERVER_UNREACHABLE 退 3', async () => {
  const { dir, dbPath } = setup();
  try {
    const r = await cli(args(dbPath, DEAD, ['tags', 'delete', '7']));
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.out).code, 'SERVER_UNREACHABLE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
