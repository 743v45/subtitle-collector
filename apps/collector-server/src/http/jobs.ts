// HTTP handler：jobs 任务台账端点（CLI 全功能 web 化 Phase 4）——asr-backfill / collect-find
// 两类长任务的提交/查询/取消，web 免经 CLI：
//   POST   /api/jobs        —— 提交任务（dry_run=true 的 asr-backfill 走同步圈定直答，不建 job）
//   GET    /api/jobs        —— 列表（type/status/limit 过滤，created_at DESC 最新在前）
//   GET    /api/jobs/:id    —— 单行详情（含 progress_json/result_json，前端轮询进度用）
//   DELETE /api/jobs/:id    —— 取消语义（非物理删除，台账保留）：pending → cancelled 200；
//                              running 不可取消 409；已终态 409。
// 执行：enqueueJob 落 pending 后由 src/jobs/runner.ts 的串行执行器消费（main.ts attachJobsWorker）。
// 依赖注入：createJobsHandler(deps) 对齐 collect-proxy 先例——store 函数与圈定/cookie 判定可注入
// （测试免 attach 执行器、免真环境变量）；缺省真实现导出 handleJobsHttp 供 main.ts。
// 措辞：字幕（subtitle），非弹幕。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import {
  enqueueJob, getJob, listJobs, cancelJob,
  type JobListFilter, type CancelResult,
} from '../jobs/runner.js';
import { dryRunCircle, biliCookieConfigured, type AsrBackfillParams } from '../jobs/asr-worker.js';
import { json, readJsonBody } from './http-util.js';

export interface JobsHandlerDeps {
  enqueueJob: typeof enqueueJob;
  getJob: typeof getJob;
  listJobs: typeof listJobs;
  cancelJob: typeof cancelJob;
  dryRunCircle: typeof dryRunCircle;
  biliCookieConfigured: typeof biliCookieConfigured;
}

// handler 工厂：deps 缺省用真实现（main.ts 用法）；测试传 mock 得独立 handler
export function createJobsHandler(
  deps: JobsHandlerDeps = {
    enqueueJob, getJob, listJobs, cancelJob, dryRunCircle, biliCookieConfigured,
  },
) {
  return async function handleJobsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/api/jobs' && req.method === 'POST') {
      await handlePostJobs(res, db, deps, await readJsonBody(req));
      return;
    }
    if (pathname === '/api/jobs' && req.method === 'GET') {
      handleListJobs(res, db, deps, url);
      return;
    }
    const idMatch = pathname.match(/^\/api\/jobs\/(\d+)$/);
    if (idMatch) {
      const id = Number(idMatch[1]);
      if (req.method === 'GET') {
        const job = deps.getJob(db, id);
        if (!job) { json(res, 404, { ok: false, error: `job not found: ${id}` }); return; }
        json(res, 200, { ok: true, job });
        return;
      }
      if (req.method === 'DELETE') {
        handleCancel(res, db, deps, id);
        return;
      }
    }
    json(res, 404, { ok: false, error: 'not found' });
  };
}

// main.ts 注册用缺省 handler（真 store + 真环境判定）
export const handleJobsHttp = createJobsHandler();

// ── POST /api/jobs ──

const JOB_TYPES = ['asr-backfill', 'collect-find'] as const;

async function handlePostJobs(res: ServerResponse, db: Database.Database, deps: JobsHandlerDeps, body: unknown): Promise<void> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.type !== 'string' || !(JOB_TYPES as readonly string[]).includes(b.type)) {
    json(res, 400, { ok: false, error: `type must be one of ${JOB_TYPES.join('|')}` });
    return;
  }
  const params = (b.params ?? {}) as Record<string, unknown>;
  if (typeof params !== 'object' || Array.isArray(params)) {
    json(res, 400, { ok: false, error: 'params: object required' });
    return;
  }
  if (b.type === 'asr-backfill') {
    await postAsrBackfill(res, db, deps, params);
    return;
  }
  await postCollectFind(res, db, deps, params);
}

// 可选正整数参数（undefined/null 豁免=缺省；给了非正整数 → error 文案）
function intParam(v: unknown, name: string, min: number, max: number): { value?: number; error?: string } {
  if (v === undefined || v === null) return { value: undefined };
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return { error: `${name} must be an integer in ${min}..${max}: ${String(v)}` };
  }
  return { value: v };
}

// POST type=asr-backfill：dry_run=true → 同步圈定直答（不建 job 不下载）；否则建 job。
// bilibili + 未配置 COLLECTOR_BILI_COOKIE_FILE → 提交回包带 warning（不硬拦：douyin 零 cookie，
// B 站转写会在任务里以 need_login 失败归因，进度可见）。
async function postAsrBackfill(res: ServerResponse, db: Database.Database, deps: JobsHandlerDeps, params: Record<string, unknown>): Promise<void> {
  const parsed = parseAsrParams(params);
  if (!parsed.ok) { json(res, 400, { ok: false, error: parsed.error }); return; }
  const p = parsed.params;
  if (p.dry_run) {
    const items = deps.dryRunCircle(db, p);
    console.log(`[http:jobs] asr-backfill dry-run: 圈定 ${items.length}（source=${p.source ?? 'bilibili'} page=${p.page ?? 1} size=${p.size ?? 5}）`);
    json(res, 200, { ok: true, dry_run: true, items });
    return;
  }
  const warning = p.source !== 'douyin' && !deps.biliCookieConfigured()
    ? '未配置 COLLECTOR_BILI_COOKIE_FILE，B 站转写将因登录态失败'
    : undefined;
  const { dry_run: _dropDryRun, ...jobParams } = p; // dry_run=true 已在上方直答，入队的任务不带该键
  const job = deps.enqueueJob(db, 'asr-backfill', jobParams);
  json(res, 200, { ok: true, job, ...(warning ? { warning } : {}) });
}

function parseAsrParams(params: Record<string, unknown>): { ok: true; params: AsrBackfillParams } | { ok: false; error: string } {
  const source = params.source ?? 'bilibili';
  if (source !== 'bilibili' && source !== 'douyin') {
    return { ok: false, error: "source must be 'bilibili'|'douyin'" };
  }
  const size = intParam(params.size, 'size', 1, 50);
  if (size.error) return { ok: false, error: size.error };
  const page = intParam(params.page, 'page', 1, Number.MAX_SAFE_INTEGER);
  if (page.error) return { ok: false, error: page.error };
  const maxDuration = intParam(params.max_duration, 'max_duration', 1, Number.MAX_SAFE_INTEGER);
  if (maxDuration.error) return { ok: false, error: maxDuration.error };
  if (params.dry_run !== undefined && typeof params.dry_run !== 'boolean') {
    return { ok: false, error: 'dry_run must be a boolean' };
  }
  return {
    ok: true,
    params: {
      source,
      ...(size.value !== undefined ? { size: size.value } : {}),
      ...(page.value !== undefined ? { page: page.value } : {}),
      ...(maxDuration.value !== undefined ? { max_duration: maxDuration.value } : {}),
      ...(params.dry_run !== undefined ? { dry_run: params.dry_run } : {}),
    },
  };
}

// POST type=collect-find：keyword 必填 ≤100；数值旋钮越界 400（不做静默忽略——「以为筛了其实没筛」是暗坑）
async function postCollectFind(res: ServerResponse, db: Database.Database, deps: JobsHandlerDeps, params: Record<string, unknown>): Promise<void> {
  const parsed = parseFindParams(params);
  if (!parsed.ok) { json(res, 400, { ok: false, error: parsed.error }); return; }
  const job = deps.enqueueJob(db, 'collect-find', parsed.params);
  json(res, 200, { ok: true, job });
}

const MAX_FIND_KEYWORD_LEN = 100;

// collect-find 数值旋钮批量校验表（key → [min, max]；校验顺序 = 表顺序 = 错误归因优先级）
const FIND_INT_PARAMS: Array<{ key: string; min: number; max: number }> = [
  { key: 'pages', min: 1, max: 5 },
  { key: 'min_fans', min: 0, max: Number.MAX_SAFE_INTEGER },
  { key: 'max_fans', min: 0, max: Number.MAX_SAFE_INTEGER },
  { key: 'since_days', min: 1, max: 365 },
  { key: 'tid', min: 1, max: Number.MAX_SAFE_INTEGER },
];

function parseFindParams(params: Record<string, unknown>): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const keyword = params.keyword;
  if (typeof keyword !== 'string' || !keyword) return { ok: false, error: 'keyword: non-empty string required' };
  if (keyword.length > MAX_FIND_KEYWORD_LEN) return { ok: false, error: `keyword too long: ${keyword.length} > ${MAX_FIND_KEYWORD_LEN}` };
  const out: Record<string, unknown> = { keyword };
  for (const { key, min, max } of FIND_INT_PARAMS) {
    const r = intParam(params[key], key, min, max);
    if (r.error) return { ok: false, error: r.error };
    if (r.value !== undefined) out[key] = r.value;
  }
  if (params.collect !== undefined) {
    if (typeof params.collect !== 'boolean') return { ok: false, error: 'collect must be a boolean' };
    out.collect = params.collect;
  }
  if (params.client_id !== undefined) {
    if (typeof params.client_id !== 'string' || !params.client_id) return { ok: false, error: 'client_id must be a non-empty string' };
    out.client_id = params.client_id;
  }
  return { ok: true, params: out };
}

// ── GET /api/jobs?type=&status=&limit= ──

function handleListJobs(res: ServerResponse, db: Database.Database, deps: JobsHandlerDeps, url: URL): void {
  const type = url.searchParams.get('type') ?? undefined;
  if (type !== undefined && !(JOB_TYPES as readonly string[]).includes(type)) {
    json(res, 400, { ok: false, error: `type must be one of ${JOB_TYPES.join('|')}` });
    return;
  }
  const status = url.searchParams.get('status') ?? undefined;
  if (status !== undefined && !['pending', 'running', 'done', 'failed', 'cancelled'].includes(status)) {
    json(res, 400, { ok: false, error: 'status must be one of pending|running|done|failed|cancelled' });
    return;
  }
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw != null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined;
  if (limitRaw != null && (limit === undefined || limit < 1)) {
    json(res, 400, { ok: false, error: 'limit must be a positive integer' });
    return;
  }
  const filter: JobListFilter = { ...(type ? { type } : {}), ...(status ? { status } : {}), ...(limit !== undefined ? { limit } : {}) };
  const items = deps.listJobs(db, filter);
  json(res, 200, { ok: true, items });
}

// ── DELETE /api/jobs/:id（取消语义，不物理删除）──

function handleCancel(res: ServerResponse, db: Database.Database, deps: JobsHandlerDeps, id: number): void {
  const r = deps.cancelJob(db, id);
  if (r.ok) { json(res, 200, { ok: true, job: r.job }); return; }
  if (r.code === 'not_found') { json(res, 404, { ok: false, error: r.error }); return; }
  console.warn(`[http:jobs] cancel job=${id} 被拒（${r.code}）: ${r.error}`);
  json(res, 409, { ok: false, error: r.error });
}
