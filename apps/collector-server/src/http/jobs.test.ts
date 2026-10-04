// http/jobs.ts 端点测试：POST /api/jobs（asr-backfill dry_run 同步直答 / 入队参数归一 + cookie warning、
// collect-find 校验矩阵）、GET 列表（type/status/limit 校验与过滤）、GET 单行（404）、
// DELETE 取消语义（pending 200 / running 409 / 终态 409 / 不存在 404，不物理删除）。
// deps 注入真 store（内存库）+ 真 dryRunCircle + mock biliCookieConfigured——端到端覆盖 handler 与
// store 契约，mock 面只留环境判定（对齐 createJobsHandler 工厂口径）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 四方法全路由 + 校验矩阵 + dry_run 直答 + warning + 取消语义 + 404 兜底 | 通过 | Phase 4 web 化 |

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
import { enqueueJob, getJob, listJobs, cancelJob } from '../jobs/runner.js';
import { dryRunCircle, biliCookieConfigured } from '../jobs/asr-worker.js';
import { createJobsHandler } from './jobs.js';
import { runHandler } from './http-util.js';

function setup(opts: { cookieConfigured?: boolean } = {}): Promise<{
  port: number; db: Database.Database; cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-jobs-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const handler = createJobsHandler({
    enqueueJob, getJob, listJobs, cancelJob,
    dryRunCircle,
    biliCookieConfigured: () => opts.cookieConfigured ?? false,
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void runHandler(res, () => handler(req, res, db)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port, db,
        cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
      });
    });
  });
}

async function call(port: number, path: string, body?: unknown, method = 'POST'): Promise<{ status: number; json: any }> {
  const hasBody = body !== undefined && method !== 'GET' && method !== 'DELETE';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// 播种 3 条 no-subtitle（bilibili×2 时长 60/600 + douyin×1）供 dry_run 圈定
function seedNoSub(db: Database.Database): void {
  for (const [source, vid, dur] of [['bilibili', 'BV1aaaaaaaa1', 60], ['bilibili', 'BV2bbbbbbbb2', 600], ['douyin', 'dy0001', 90]] as const) {
    ingestVideo(db, {
      source,
      video: { source_vid: vid, title: `t-${vid}`, creator: { source_uid: '1', name: 'up' }, duration: dur },
      tracks: [],
    });
    markNoSubtitle(db, { source, source_vid: vid });
  }
}

// ── POST /api/jobs：type=asr-backfill ──

test('POST asr-backfill dry_run=true → 同步圈定直答（不建 job），source/max_duration 过滤生效', async () => {
  const s = await setup();
  try {
    seedNoSub(s.db);
    const r = await call(s.port, '/api/jobs', { type: 'asr-backfill', params: { source: 'bilibili', dry_run: true } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.dry_run, true);
    assert.deepEqual(r.json.items.map((i: { source_vid: string }) => i.source_vid), ['BV2bbbbbbbb2', 'BV1aaaaaaaa1']);
    assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n, 0, 'dry-run 不落 job 行');
  } finally { s.cleanup(); }
});

test('POST asr-backfill 正式提交 → job 落 pending；params 不带 dry_run 键；未配置 cookie 且 bilibili → warning', async () => {
  const s = await setup({ cookieConfigured: false });
  try {
    const r = await call(s.port, '/api/jobs', { type: 'asr-backfill', params: { source: 'bilibili', size: 3, dry_run: false } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.match(r.json.warning, /未配置 COLLECTOR_BILI_COOKIE_FILE/);
    const job = r.json.job;
    assert.equal(job.status, 'pending');
    assert.equal(job.type, 'asr-backfill');
    const params = JSON.parse(job.params_json);
    assert.equal(params.dry_run, undefined, 'dry_run 键不入队（执行器不感知）');
    assert.equal(params.size, 3);
    assert.equal(params.source, 'bilibili');
  } finally { s.cleanup(); }
});

test('POST asr-backfill：douyin 零 cookie 依赖无 warning；cookie 已配置无 warning', async () => {
  const s1 = await setup({ cookieConfigured: false });
  try {
    const r1 = await call(s1.port, '/api/jobs', { type: 'asr-backfill', params: { source: 'douyin' } });
    assert.equal(r1.json.warning, undefined);
  } finally { s1.cleanup(); }
  const s2 = await setup({ cookieConfigured: true });
  try {
    const r2 = await call(s2.port, '/api/jobs', { type: 'asr-backfill', params: {} });
    assert.equal(r2.json.warning, undefined, '缺省 bilibili + 已配置 cookie → 无 warning');
  } finally { s2.cleanup(); }
});

test('POST asr-backfill 参数校验：type 非法 / source 非法 / size 越界 / page<1 / max_duration<1 / dry_run 非布尔 → 400', async () => {
  const s = await setup();
  try {
    const bodies: Array<[Record<string, unknown>, RegExp]> = [
      [{ type: 'nope' }, /type must be one of/],
      [{ type: 'asr-backfill', params: { source: 'youtube' } }, /source must be/],
      [{ type: 'asr-backfill', params: { size: 0 } }, /size must be an integer in 1\.\.50/],
      [{ type: 'asr-backfill', params: { size: 51 } }, /size must be an integer in 1\.\.50/],
      [{ type: 'asr-backfill', params: { page: 0 } }, /page must be an integer in 1\.\./],
      [{ type: 'asr-backfill', params: { max_duration: 0 } }, /max_duration must be an integer in 1\.\./],
      [{ type: 'asr-backfill', params: { dry_run: 'yes' } }, /dry_run must be a boolean/],
    ];
    for (const [body, match] of bodies) {
      const r = await call(s.port, '/api/jobs', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, match);
    }
    assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n, 0, '校验失败不建 job');
  } finally { s.cleanup(); }
});

// ── POST /api/jobs：type=collect-find ──

test('POST collect-find：成功入队（params 归一保留显式值）；校验矩阵逐项 400', async () => {
  const s = await setup();
  try {
    const ok = await call(s.port, '/api/jobs', { type: 'collect-find', params: { keyword: '字幕', pages: 2, min_fans: 100, since_days: 7, tid: 171, collect: false } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.json.job.params_json), {
      keyword: '字幕', pages: 2, min_fans: 100, since_days: 7, tid: 171, collect: false,
    }, '显式参数逐键保留');

    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ keyword: '' }, /non-empty string required/],
      [{ keyword: 'x'.repeat(101) }, /keyword too long/],
      [{ keyword: 'kw', pages: 0 }, /pages must be an integer in 1\.\.5/],
      [{ keyword: 'kw', pages: 6 }, /pages must be an integer in 1\.\.5/],
      [{ keyword: 'kw', min_fans: -1 }, /min_fans must be an integer in 0\.\./],
      [{ keyword: 'kw', max_fans: -1 }, /max_fans must be an integer in 0\.\./],
      [{ keyword: 'kw', since_days: 0 }, /since_days must be an integer in 1\.\.365/],
      [{ keyword: 'kw', since_days: 366 }, /since_days must be an integer in 1\.\.365/],
      [{ keyword: 'kw', tid: 0 }, /tid must be an integer in 1\.\./],
      [{ keyword: 'kw', collect: 'yes' }, /collect must be a boolean/],
      [{ keyword: 'kw', client_id: '' }, /client_id must be a non-empty string/],
      [{}, /non-empty string required/],
    ];
    for (const [params, match] of bad) {
      const r = await call(s.port, '/api/jobs', { type: 'collect-find', params });
      assert.equal(r.status, 400, JSON.stringify(params));
      assert.match(r.json.error, match);
    }
  } finally { s.cleanup(); }
});

// ── GET /api/jobs（列表）──

test('GET /api/jobs：type/status 过滤 + created_at DESC 排序 + limit；非法 query → 400', async () => {
  const s = await setup();
  try {
    const a = enqueueJob(s.db, 'asr-backfill', {});
    const b = enqueueJob(s.db, 'collect-find', { keyword: 'x' });
    const c = enqueueJob(s.db, 'asr-backfill', {});
    s.db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(a.id);

    const all = await call(s.port, '/api/jobs', undefined, 'GET');
    assert.deepEqual(all.json.items.map((i: { id: number }) => i.id), [c.id, b.id, a.id], '最新在前');
    const byType = await call(s.port, '/api/jobs?type=asr-backfill', undefined, 'GET');
    assert.deepEqual(byType.json.items.map((i: { id: number }) => i.id), [c.id, a.id]);
    const byStatus = await call(s.port, '/api/jobs?status=done', undefined, 'GET');
    assert.deepEqual(byStatus.json.items.map((i: { id: number }) => i.id), [a.id]);
    const limited = await call(s.port, '/api/jobs?limit=2', undefined, 'GET');
    assert.equal(limited.json.items.length, 2);

    for (const q of ['?type=nope', '?status=wat', '?limit=abc', '?limit=0']) {
      const r = await call(s.port, `/api/jobs${q}`, undefined, 'GET');
      assert.equal(r.status, 400, q);
    }
  } finally { s.cleanup(); }
});

// ── GET /api/jobs/:id 与 DELETE /api/jobs/:id ──

test('GET /api/jobs/:id：存在回完整行；不存在 404', async () => {
  const s = await setup();
  try {
    const j = enqueueJob(s.db, 'asr-backfill', { size: 2 });
    const r = await call(s.port, `/api/jobs/${j.id}`, undefined, 'GET');
    assert.equal(r.status, 200);
    assert.equal(r.json.job.id, j.id);
    assert.equal(r.json.job.params_json, '{"size":2}');
    const miss = await call(s.port, '/api/jobs/999', undefined, 'GET');
    assert.equal(miss.status, 404);
    assert.match(miss.json.error, /job not found: 999/);
  } finally { s.cleanup(); }
});

test('DELETE /api/jobs/:id = 取消语义：pending → 200 cancelled；running → 409；终态 → 409；不存在 → 404；行不物理删', async () => {
  const s = await setup();
  try {
    const j = enqueueJob(s.db, 'asr-backfill', {});
    const ok = await call(s.port, `/api/jobs/${j.id}`, undefined, 'DELETE');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.job.status, 'cancelled');

    s.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(j.id);
    const run = await call(s.port, `/api/jobs/${j.id}`, undefined, 'DELETE');
    assert.equal(run.status, 409);
    assert.match(run.json.error, /running 任务不可取消/);

    s.db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(j.id);
    const term = await call(s.port, `/api/jobs/${j.id}`, undefined, 'DELETE');
    assert.equal(term.status, 409);
    assert.match(term.json.error, /已终态（done）/);

    const miss = await call(s.port, '/api/jobs/999', undefined, 'DELETE');
    assert.equal(miss.status, 404);

    assert.ok(getJob(s.db, j.id), '台账保留（不物理删除）');
  } finally { s.cleanup(); }
});

test('未知路径 / 非 id 段路径 → 404 兜底', async () => {
  const s = await setup();
  try {
    const r1 = await call(s.port, '/api/jobs/abc', undefined, 'GET');
    assert.equal(r1.status, 404);
    const r2 = await call(s.port, '/api/jobs/1/sub', undefined, 'GET');
    assert.equal(r2.status, 404);
  } finally { s.cleanup(); }
});
