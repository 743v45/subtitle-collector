// jobs 通用任务台账 + 进程内串行执行器（CLI 全功能 web 化 Phase 4）。
// 解决的问题：asr-backfill / collect-find 这类长任务此前只能在 CLI 会话内跑（易失编排），
// web 免经 CLI → server 收任务（POST /api/jobs）落 jobs 表，本执行器串行消费。
// 串行而非并发：批量下载/转写是本机重负载（音视频 + ASR 推理），并发只会互相拖慢且放大风控面。
// 生命周期：pending → running → done | failed；pending 可取消 → cancelled（running 不可取消，
// 批任务中途取消的语义成本 > 收益——进度可见 + 重跑天然跳过已完成项即断点续跑）。
// 启动恢复：server 重启时 pending/running 一律置 cancelled（不自动重跑——批下载重启后环境
// 可能已变，由用户重新提交）。行只增不删：DELETE = cancel，台账保留。
// 分层：jobs 是 tasks 的同层（src/jobs/），可 import db / cli 纯函数 / ws/server / workers，
// 无任何模块反向 import jobs（仅 main.ts 与 http/jobs.ts 消费），无循环。
import type Database from 'better-sqlite3';
import { broadcastEvent } from '../ws/server.js';
import { runAsrBackfillJob } from './asr-worker.js';
import { runCollectFindJob } from './collect-find-worker.js';

// ── 台账行与查询（http/jobs.ts 与本执行器共用）──

export interface JobRow {
  id: number;
  type: string;
  params_json: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  progress_json: string | null;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export function getJob(db: Database.Database, id: number): JobRow | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ?? null;
}

export interface JobListFilter {
  type?: string;
  status?: string;
  limit?: number; // 默认 20，夹 1..100（created_at DESC 最新在前）
}

export function listJobs(db: Database.Database, f: JobListFilter): JobRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.type) { where.push('type = ?'); args.push(f.type); }
  if (f.status) { where.push('status = ?'); args.push(f.status); }
  const limit = Math.min(100, Math.max(1, Math.floor(f.limit ?? 20)));
  const sql = `SELECT * FROM jobs${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return db.prepare(sql).all(...args) as JobRow[];
}

// 入队（pending）+ 立即 kick 执行器。返回完整行（handler 直接回给前端）。
export function enqueueJob(db: Database.Database, type: string, params: Record<string, unknown>): JobRow {
  const nowMs = Date.now();
  const info = db.prepare(
    'INSERT INTO jobs (type, params_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(type, JSON.stringify(params), 'pending', nowMs, nowMs);
  const id = Number(info.lastInsertRowid);
  console.log(`[jobs] enqueue job=${id} type=${type} params=${JSON.stringify(params)}`);
  kickJobsWorker();
  return getJob(db, id)!;
}

// 进度更新（执行器经 ctx.onProgress 回调走这里）：写 progress_json + 广播 job-update。
// 前端轮询 GET /api/jobs/:id 为主，广播只做扩展侧实时提醒（对齐 task-update 先例）。
export function updateJobProgress(db: Database.Database, id: number, progress: Record<string, unknown>): void {
  db.prepare('UPDATE jobs SET progress_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(progress), Date.now(), id);
  broadcastEvent({ type: 'job-update', job_id: id, progress });
}

// ── 取消（DELETE /api/jobs/:id 的语义 = cancel，不物理删除）──

export type CancelResult =
  | { ok: true; job: JobRow }
  | { ok: false; code: 'not_found' | 'running' | 'terminal'; job: JobRow | null; error: string };

export function cancelJob(db: Database.Database, id: number): CancelResult {
  const job = getJob(db, id);
  if (!job) return { ok: false, code: 'not_found', job: null, error: `job not found: ${id}` };
  if (job.status === 'pending') {
    db.prepare("UPDATE jobs SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run('用户取消', Date.now(), id);
    console.log(`[jobs] job=${id} pending → cancelled（用户取消）`);
    broadcastEvent({ type: 'job-update', job_id: id, status: 'cancelled' });
    return { ok: true, job: getJob(db, id)! };
  }
  if (job.status === 'running') return { ok: false, code: 'running', job, error: 'running 任务不可取消' };
  return { ok: false, code: 'terminal', job, error: `任务已终态（${job.status}），不可取消` };
}

// ── 串行执行器 ──

// worker 统一入口形态：拿 ctx（db + 进度回调），返回值序列化进 result_json；抛错 → failed（error 归因）。
// 返回 unknown（各 worker 自带类型，如 BackfillSummary——接口类型无隐式索引签名，不宜写 Record）。
export interface JobCtx {
  db: Database.Database;
  jobId: number;
  onProgress: (progress: Record<string, unknown>) => void;
}
export type JobRunner = (ctx: JobCtx, params: Record<string, unknown>) => Promise<unknown>;

export interface JobsWorkerOpts {
  asrRunner?: JobRunner;   // 测试注入 mock；缺省 = 真 asr worker
  findRunner?: JobRunner;  // 同上
}

// 模块级 kick 引用（enqueueJob → kickJobsWorker 单进程单执行器，对齐 taskSchedulerKick 先例）
let jobsKick: (() => void) | null = null;
export function kickJobsWorker(): void {
  jobsKick?.();
}

// 单任务执行：条件置 running（取消竞态防护）→ 分派 → done/failed 落终态。
// 任何 runner 抛错都进 failed 分支——执行器自身不因任务失败退出，drain 循环继续下一个。
async function runOneJob(db: Database.Database, job: JobRow, opts: JobsWorkerOpts): Promise<void> {
  const claim = db.prepare(
    "UPDATE jobs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
  ).run(Date.now(), Date.now(), job.id);
  if (claim.changes === 0) {
    console.log(`[jobs] job=${job.id} 拾起时已非 pending（取消竞态），跳过`);
    return;
  }
  console.log(`[jobs] job=${job.id} type=${job.type} 开始 params=${job.params_json}`);
  const startedMs = Date.now();
  let params: Record<string, unknown> = {};
  try { params = JSON.parse(job.params_json) as Record<string, unknown>; } catch {
    console.warn(`[jobs] job=${job.id} params_json 非法 JSON，按空对象执行`);
  }
  const runner: JobRunner | null =
    job.type === 'asr-backfill' ? (opts.asrRunner ?? runAsrBackfillJob)
    : job.type === 'collect-find' ? (opts.findRunner ?? runCollectFindJob)
    : null;
  const ctx: JobCtx = { db, jobId: job.id, onProgress: (p) => updateJobProgress(db, job.id, p) };
  try {
    if (!runner) throw new Error(`未知任务类型: ${job.type}`);
    const result = await runner(ctx, params);
    db.prepare("UPDATE jobs SET status = 'done', result_json = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(JSON.stringify(result ?? {}), Date.now(), Date.now(), job.id);
    console.log(`[jobs] job=${job.id} type=${job.type} 完成 (${Date.now() - startedMs}ms)`);
    broadcastEvent({ type: 'job-update', job_id: job.id, status: 'done' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(msg, Date.now(), Date.now(), job.id);
    console.error(`[jobs] job=${job.id} type=${job.type} 失败 (${Date.now() - startedMs}ms): ${msg}`);
    broadcastEvent({ type: 'job-update', job_id: job.id, status: 'failed', error: msg });
  }
}

export function attachJobsWorker(db: Database.Database, opts: JobsWorkerOpts = {}): void {
  // 启动恢复：重启前的 pending/running 一律作废（批下载不自动重跑，用户重新提交）
  const stale = db.prepare(
    "UPDATE jobs SET status = 'cancelled', error = ?, updated_at = ? WHERE status IN ('pending','running')",
  ).run('server 重启，任务作废，请重新提交', Date.now());
  if (stale.changes > 0) console.log(`[jobs] 启动恢复：${stale.changes} 个在途任务置 cancelled`);

  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return; // 串行闸门：正在消费时 kick 是 no-op（跑完循环自会看下一个 pending）
    draining = true;
    try {
      for (;;) {
        const row = db.prepare(
          "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1",
        ).get() as JobRow | undefined;
        if (!row) break;
        await runOneJob(db, row, opts);
      }
    } finally {
      draining = false;
    }
  };
  jobsKick = () => { void drain().catch((e) => console.error('[jobs] drain 循环异常:', e)); };
}
