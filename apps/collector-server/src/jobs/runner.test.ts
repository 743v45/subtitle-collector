// jobs/runner.ts 串行执行器测试：enqueue → pending → 串行消费 → done/failed 终态、启动恢复
// （重启前在途任务一律 cancelled）、取消语义（pending 可取消 / running 不可 / 终态不可 / 不存在）
// 与取消竞态（拾起时已非 pending → 跳过不执行）、未知类型失败不崩执行器、listJobs 过滤排序。
// mock runner 经 attachJobsWorker(db, { asrRunner, findRunner }) 注入，deferred promise 精确控制
// 任务内挂起点：JS 单线程下 kick → drain 同步跑到第一个 await（runner 挂起），因此全部断言都是
// 同步态检查 + setImmediate flush，无轮询等待，无 flake。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 入队/完成落库/串行闸门/取消竞态/失败续跑/启动恢复/取消语义/未知类型/进度落库/列表过滤 | 通过 | Phase 4 web 化 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import {
  attachJobsWorker, enqueueJob, getJob, listJobs, cancelJob, updateJobProgress,
} from './runner.js';

function setup(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

// 微任务清空：drain/runner 的完成落库都在微任务里，一个 setImmediate 足够排干
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

// 纯台账播种（不经 enqueueJob）：避免触发上一测试 attach 留下的模块级 kick（指向已关闭的库，噪声）
function insertJob(db: Database.Database, type: string, params = '{}'): number {
  const info = db.prepare(
    "INSERT INTO jobs (type, params_json, status, created_at, updated_at) VALUES (?, ?, 'pending', 1, 1)",
  ).run(type, params);
  return Number(info.lastInsertRowid);
}

test('enqueue → 执行器拾起 → done + result_json/started_at/finished_at 落库；onProgress 写 progress_json', async () => {
  const db = setup();
  const seen: Array<{ jobId: number; params: Record<string, unknown> }> = [];
  attachJobsWorker(db, {
    asrRunner: async (ctx, params) => {
      seen.push({ jobId: ctx.jobId, params });
      ctx.onProgress({ done: 1, total: 2, failed: {} });
      return { circled: 2, done: 1 };
    },
  });
  const job = enqueueJob(db, 'asr-backfill', { source: 'bilibili', size: 3 });
  // kick 同步跑到第一个 await：enqueueJob 返回前 claim 已发生——pending 只在串行闸门场景可观察（见下一用例）
  assert.equal(job.status, 'running', '同步拾起：条件 claim 先于任何 await');
  await flush();
  assert.deepEqual(seen, [{ jobId: job.id, params: { source: 'bilibili', size: 3 } }], 'runner 收到 ctx.jobId + params');
  const row = getJob(db, job.id)!;
  assert.equal(row.status, 'done');
  assert.deepEqual(JSON.parse(row.result_json!), { circled: 2, done: 1 }, '返回值序列化进 result_json');
  assert.deepEqual(JSON.parse(row.progress_json!), { done: 1, total: 2, failed: {} }, 'onProgress 写 progress_json');
  assert.ok(row.started_at != null && row.finished_at != null, '起止时间戳落库');
  assert.ok(row.finished_at! >= row.started_at!);
  db.close();
});

test('串行闸门：前一任务未完，后一任务保持 pending；pending 期被取消 → 拾起时跳过（取消竞态）', async () => {
  const db = setup();
  const gate = deferred();
  const started: number[] = [];
  attachJobsWorker(db, {
    asrRunner: async (ctx, params) => {
      started.push(ctx.jobId);
      if (params.first === true) await gate.promise; // 只有第一个任务挂起
      return {};
    },
  });
  const a = enqueueJob(db, 'asr-backfill', { first: true });
  await flush(); // a 已同步进入 runner 并挂起在 gate
  const b = enqueueJob(db, 'asr-backfill', { first: false });
  assert.equal(getJob(db, b.id)!.status, 'pending', 'a 未完成时 b 保持 pending（串行不并发）');

  // b 在 pending 期被取消 → a 完成后 drain 拾起 b，条件 claim（WHERE status='pending'）落空 → 跳过
  const c = cancelJob(db, b.id);
  assert.ok(c.ok, 'pending 可取消');
  gate.resolve();
  await flush();
  await flush();
  assert.deepEqual(started, [a.id], '被取消的 b 不执行');
  assert.equal(getJob(db, a.id)!.status, 'done');
  assert.equal(getJob(db, b.id)!.status, 'cancelled');
  db.close();
});

test('runner 抛错 → failed + error 归因；drain 不中断继续跑下一任务', async () => {
  const db = setup();
  attachJobsWorker(db, {
    asrRunner: async (_ctx, params) => {
      if (params.boom === true) throw new Error('kaboom');
      return { fine: true };
    },
  });
  const bad = enqueueJob(db, 'asr-backfill', { boom: true });
  const good = enqueueJob(db, 'asr-backfill', {});
  await flush();
  await flush();
  const rBad = getJob(db, bad.id)!;
  assert.equal(rBad.status, 'failed');
  assert.equal(rBad.error, 'kaboom', '错误消息归因进 error 列');
  assert.ok(rBad.finished_at != null);
  assert.equal(getJob(db, good.id)!.status, 'done', '失败不崩执行器，下一任务照常完成');
  db.close();
});

test('attach 启动恢复：重启前 pending/running 一律置 cancelled（error 注明重新提交）', () => {
  const db = setup();
  const a = insertJob(db, 'asr-backfill');
  const b = insertJob(db, 'collect-find', '{"keyword":"x"}');
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(a); // 造一个 running 存量
  attachJobsWorker(db, {});
  for (const id of [a, b]) {
    const row = getJob(db, id)!;
    assert.equal(row.status, 'cancelled', `job=${id} 在途任务应被作废`);
    assert.match(row.error!, /server 重启，任务作废，请重新提交/);
  }
  db.close();
});

test('cancelJob：pending → cancelled（用户取消）；running / 终态 / 不存在 → 各自 code 拒绝', () => {
  const db = setup();
  const miss = cancelJob(db, 999);
  assert.equal(miss.ok, false);
  assert.equal(miss.code, 'not_found');

  const a = insertJob(db, 'asr-backfill');
  const pend = cancelJob(db, a);
  assert.ok(pend.ok);
  assert.equal(pend.job.status, 'cancelled');

  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(a);
  const run = cancelJob(db, a);
  assert.equal(run.ok, false);
  assert.equal(run.code, 'running');
  assert.equal(getJob(db, a)!.status, 'running', 'running 不可取消（状态不被改动）');

  db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(a);
  const term = cancelJob(db, a);
  assert.equal(term.ok, false);
  assert.equal(term.code, 'terminal');
  assert.match(term.error, /已终态（done）/);
  db.close();
});

test('未知任务类型 → failed（error 归因），执行器存活可继续接活', async () => {
  const db = setup();
  attachJobsWorker(db, {});
  const bad = enqueueJob(db, 'mystery', {});
  await flush();
  await flush();
  const row = getJob(db, bad.id)!;
  assert.equal(row.status, 'failed');
  assert.match(row.error!, /未知任务类型: mystery/);
  const next = enqueueJob(db, 'asr-backfill', {}); // 缺省真 runner：空库圈定 0，零网络直达 done
  await flush();
  await flush();
  assert.equal(getJob(db, next.id)!.status, 'done', '执行器未因未知类型退出');
  db.close();
});

test('listJobs：type/status 过滤 + created_at DESC, id DESC 排序 + limit 夹取（<1 → 1，>100 → 100）', () => {
  const db = setup();
  const j1 = insertJob(db, 'asr-backfill');
  const j2 = insertJob(db, 'collect-find', '{"keyword":"x"}');
  const j3 = insertJob(db, 'asr-backfill', '{"keyword":"y"}');
  assert.deepEqual(listJobs(db, {}).map((r) => r.id), [j3, j2, j1], '默认最新在前（created_at 同毫秒由 id DESC 兜底）');
  assert.deepEqual(listJobs(db, { type: 'asr-backfill' }).map((r) => r.id), [j3, j1]);
  db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(j1);
  assert.deepEqual(listJobs(db, { status: 'done' }).map((r) => r.id), [j1]);
  assert.equal(listJobs(db, { limit: 2 }).length, 2);
  assert.equal(listJobs(db, { limit: 0 }).length, 1, 'limit<1 夹为 1');
  assert.equal(listJobs(db, { limit: 999 }).length, 3, 'limit>100 夹为 100（存量不足时即全量）');
  db.close();
});

test('updateJobProgress：写 progress_json + updated_at（广播走 ws 无连接时 no-op 不抛错）', () => {
  const db = setup();
  const j = insertJob(db, 'asr-backfill');
  const before = getJob(db, j)!;
  updateJobProgress(db, j, { stage: 'search', candidates: 7 });
  const row = getJob(db, j)!;
  assert.deepEqual(JSON.parse(row.progress_json!), { stage: 'search', candidates: 7 });
  assert.ok(row.updated_at >= before.updated_at);
  db.close();
});
