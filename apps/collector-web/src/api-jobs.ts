// CLI 全功能 web 化 Phase 4：jobs 任务台账端点封装（api-extra 的兄弟模块——api-extra 已 234 行，
// jobs 类型+5 端点再并入会逼近 maxLines 台账线，对齐 Phase 1「api.ts 拆 api-core/api-extra」的分层先例另立）。
// 复用 api-core 的 BASE/ensureOk；契约以 server 实码为准：
//   POST   /api/jobs        {type,params} → {ok, job, warning?}（asr-backfill dry_run=true 同步直答 items，不建 job）
//   GET    /api/jobs?type=&status=&limit= → {ok, items:[job...]}
//   GET    /api/jobs/:id    → {ok, job}；404
//   DELETE /api/jobs/:id    → pending 取消 200；running 409 {error:'running 任务不可取消'}；终态 409
// 存储形态：JobRow 的 params_json/progress_json/result_json 在 HTTP 响应里是 JSON 字符串
// （runner.ts 直回 DB 行），本层统一 parse 归一为对象（坏 JSON try/catch 容错 → null），页面零感知。
import { BASE, apiFetch, ensureOk } from './apiCore';

export type JobType = 'asr-backfill' | 'collect-find';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

// asr-backfill 提交参数（http/jobs.ts parseAsrParams 口径：size 1..50 默认5、page ≥1、dry_run 同步直答）
export interface AsrBackfillParams {
  source?: 'bilibili' | 'douyin';
  size?: number;
  page?: number;
  max_duration?: number;
}

// collect-find 提交参数（keyword 必填 ≤100；数值旋钮越界 server 400 不静默）
export interface CollectFindParams {
  keyword: string;
  pages?: number;
  min_fans?: number;
  max_fans?: number;
  since_days?: number;
  tid?: number;
  collect?: boolean;
}

// 进度：asr 型 {done,total,failed:{分类码:计数}}；find 型带 stage（search|filter）+ 阶段计数
export interface JobProgress {
  done?: number;
  total?: number;
  failed?: Record<string, number>;
  stage?: string;
  pages_fetched?: number;
  candidates?: number;
  filtered_since?: number;
  filtered_fans?: number;
  unknown_fans?: number;
  after_fans?: number;
}

// 结果：asr 型 = BackfillSummary；find 型 = CollectFindResult（items 截前 100 带标注）
export interface AsrJobResult {
  source?: string;
  circled?: number;
  done?: number;
  dry_run?: boolean;
  failed?: Record<string, number>;
  samples?: Record<string, string[]>;
}

export interface FindJobResult {
  keyword?: string;
  pages_fetched?: number;
  raw_total?: number;
  candidates?: number;
  filtered_since?: number;
  filtered_fans?: number;
  unknown_fans?: number;
  collected?: { created: number; skipped: number };
  items?: Array<Record<string, unknown>>;
}

// 归一后的 job 行（页面只看这里的 params/progress/result 对象，不碰 *_json 字符串）
export interface JobRow {
  id: number;
  type: string;
  status: JobStatus;
  params: AsrBackfillParams & CollectFindParams | null;
  progress: JobProgress | null;
  result: AsrJobResult & FindJobResult | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

// JSON 字符串字段归一：非字符串/空串 → null；坏 JSON 容错 → null（不因单字段坏值炸整个 job 行）
function parseJsonField(s: unknown): unknown {
  if (typeof s !== 'string' || s === '') return null;
  try { return JSON.parse(s) as unknown; } catch { return null; }
}

// server DB 行（*_json 字符串）→ 归一 JobRow（响应形状的单一适配点）
function parseJobRow(j: any): JobRow {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    params: (parseJsonField(j.params_json) ?? null) as JobRow['params'],
    progress: (parseJsonField(j.progress_json) ?? null) as JobRow['progress'],
    result: (parseJsonField(j.result_json) ?? null) as JobRow['result'],
    error: j.error ?? null,
    created_at: j.created_at,
    updated_at: j.updated_at,
    started_at: j.started_at ?? null,
    finished_at: j.finished_at ?? null,
  };
}

export interface CreateJobResult { job: JobRow; warning?: string }

export async function createJob(type: JobType, params: AsrBackfillParams | CollectFindParams): Promise<CreateJobResult> {
  const r = await apiFetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, params }),
  });
  return ensureOk(r, (j) => ({ job: parseJobRow(j.job), ...(j.warning ? { warning: j.warning as string } : {}) }));
}

// dry_run 同步圈定直答（server 不建 job 不下载；items: {source_vid,title,duration}）
export interface AsrDryRunItem { source_vid: string; title: string | null; duration: number | null }

export async function dryRunAsrCircle(params: AsrBackfillParams): Promise<AsrDryRunItem[]> {
  const r = await apiFetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'asr-backfill', params: { ...params, dry_run: true } }),
  });
  return ensureOk(r, (j) => (Array.isArray(j.items) ? j.items : []) as AsrDryRunItem[]);
}

export interface JobListQuery { type?: JobType; status?: JobStatus; limit?: number }

export async function listJobs(query: JobListQuery = {}): Promise<JobRow[]> {
  const q = new URLSearchParams();
  if (query.type) q.set('type', query.type);
  if (query.status) q.set('status', query.status);
  if (query.limit != null) q.set('limit', String(query.limit));
  const qs = q.toString();
  const r = await apiFetch(`${BASE}/api/jobs${qs ? `?${qs}` : ''}`);
  return ensureOk(r, (j) => (Array.isArray(j.items) ? j.items : []).map(parseJobRow));
}

export async function getJob(id: number): Promise<JobRow> {
  const r = await apiFetch(`${BASE}/api/jobs/${id}`);
  return ensureOk(r, (j) => parseJobRow(j.job));
}

// 取消：pending → 200 回 cancelled 行；running/终态 → 409（ensureOk 抛「HTTP 409：<server 文案>」）
export async function cancelJob(id: number): Promise<JobRow> {
  const r = await apiFetch(`${BASE}/api/jobs/${id}`, { method: 'DELETE' });
  return ensureOk(r, (j) => parseJobRow(j.job));
}
