// api-jobs.ts 单测：jobs 端点封装（POST /api/jobs、dry_run 直答、列表 query、单取、取消）
// + 存储形态归一（progress_json/result_json 为 JSON 字符串 → 对象；坏 JSON → null 不炸行）。
// 不 mock api-jobs 本身——stubGlobal fetch 后调真实函数，锁住请求形状与解析行为。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | createJob/dryRun/listJobs/getJob/cancelJob 请求形状 + JSON 字符串归一 + 404/409 透出 | 通过 | 2026-10 Phase 4 |
import { test, expect, vi, afterEach } from 'vitest';
import { cancelJob, createJob, dryRunAsrCircle, getJob, listJobs } from './api-jobs';
import type { JobRow } from './api-jobs';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}
function httpErr(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => {
  fetchMock.mockReset();
});

function callAt(i: number): { url: string; init?: RequestInit } {
  const c = fetchMock.mock.calls[i]!;
  return { url: String(c[0]), init: c[1] as RequestInit | undefined };
}

// server 侧行（runner.ts 直回 DB 行：*_json 是字符串）——归一测试的原料
function serverRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 3, type: 'asr-backfill', status: 'running',
    params_json: '{"source":"douyin","size":5}',
    progress_json: '{"done":1,"total":5,"failed":{"need_login":1}}',
    result_json: null,
    error: null,
    created_at: 1000, updated_at: 2000, started_at: 1500, finished_at: null,
    ...over,
  };
}

// ── createJob ──

test('createJob：POST /api/jobs body {type,params}，回包 job 的 *_json 字符串归一为对象', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: true, job: serverRow() }));
  const r = await createJob('asr-backfill', { source: 'douyin', size: 5 });
  const c = callAt(0);
  expect(c.url).toBe('/api/jobs');
  expect(c.init?.method).toBe('POST');
  expect(JSON.parse(String(c.init?.body))).toEqual({ type: 'asr-backfill', params: { source: 'douyin', size: 5 } });
  // 归一断言：页面拿到的是对象不是字符串
  expect(r.job.params).toEqual({ source: 'douyin', size: 5 });
  expect(r.job.progress).toEqual({ done: 1, total: 5, failed: { need_login: 1 } });
  expect(r.job.result).toBe(null);
  expect(r.job.status).toBe('running');
});

test('createJob：回包带 warning 透传（bilibili 未配 cookie 口径），无 warning 不出该键', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: true, job: serverRow(), warning: '未配置 B 站 cookie，转写将 need_login' }));
  const withW = await createJob('asr-backfill', { source: 'bilibili' });
  expect(withW.warning).toBe('未配置 B 站 cookie，转写将 need_login');

  fetchMock.mockResolvedValueOnce(ok({ ok: true, job: serverRow() }));
  const noW = await createJob('asr-backfill', { source: 'bilibili' });
  expect('warning' in noW).toBe(false);
});

test('createJob：非 2xx 错误透出（ensureOk 口径「HTTP 状态：error」）', async () => {
  fetchMock.mockResolvedValueOnce(httpErr(400, { ok: false, error: 'params.size: 1..50 required' }));
  await expect(createJob('asr-backfill', { size: 999 })).rejects.toThrow('HTTP 400：params.size: 1..50 required');
});

// ── dryRunAsrCircle（预览圈定：dry_run 同步直答，不建 job）──

test('dryRunAsrCircle：body 强制带 dry_run:true，回 items 数组；items 缺失回落空数组', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: true, dry_run: true, items: [{ source_vid: 'BV1x', title: 't', duration: 61 }] }));
  const items = await dryRunAsrCircle({ source: 'bilibili', size: 5 });
  const c = callAt(0);
  expect(JSON.parse(String(c.init?.body))).toEqual({
    type: 'asr-backfill', params: { source: 'bilibili', size: 5, dry_run: true },
  });
  expect(items).toEqual([{ source_vid: 'BV1x', title: 't', duration: 61 }]);

  fetchMock.mockResolvedValueOnce(ok({ ok: true, dry_run: true })); // 异常形态：无 items
  expect(await dryRunAsrCircle({})).toEqual([]);
});

// ── listJobs / getJob / cancelJob ──

test('listJobs：query 只带显式项（type/status/limit），items 逐行归一', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: true, items: [serverRow(), serverRow({ id: 4, type: 'collect-find', status: 'done', result_json: '{"candidates":7,"collected":{"created":2,"skipped":1}}' })] }));
  const rows = await listJobs({ type: 'asr-backfill', status: 'running', limit: 10 });
  expect(callAt(0).url).toBe('/api/jobs?type=asr-backfill&status=running&limit=10');
  expect(rows).toHaveLength(2);
  expect(rows[1]!.result).toEqual({ candidates: 7, collected: { created: 2, skipped: 1 } });

  fetchMock.mockResolvedValueOnce(ok({ ok: true, items: [] }));
  expect(await listJobs()).toEqual([]);
  expect(callAt(1)!.url).toBe('/api/jobs'); // 缺省无 query string

  fetchMock.mockResolvedValueOnce(ok({ ok: true })); // 异常形态：无 items 键
  expect(await listJobs({ type: 'asr-backfill' })).toEqual([]);
  expect(callAt(2)!.url).toBe('/api/jobs?type=asr-backfill');
});

test('getJob：GET /api/jobs/:id 解 job；404 透出 server 文案', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: true, job: serverRow() }));
  const job: JobRow = await getJob(3);
  expect(callAt(0).url).toBe('/api/jobs/3');
  expect(job.id).toBe(3);

  fetchMock.mockResolvedValueOnce(httpErr(404, { ok: false, error: 'job not found' }));
  await expect(getJob(404)).rejects.toThrow('HTTP 404：job not found');
});

test('cancelJob：DELETE /api/jobs/:id，pending 回 cancelled 行；running 409 透出「不可取消」文案', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: true, job: serverRow({ status: 'cancelled', progress_json: null }) }));
  const job = await cancelJob(3);
  expect(callAt(0).url).toBe('/api/jobs/3');
  expect(callAt(0).init?.method).toBe('DELETE');
  expect(job.status).toBe('cancelled');

  fetchMock.mockResolvedValueOnce(httpErr(409, { ok: false, error: 'running 任务不可取消' }));
  await expect(cancelJob(3)).rejects.toThrow('HTTP 409：running 任务不可取消');
});

// ── 归一边界 ──

test('归一：坏 JSON / 空串 / 非字符串 的 *_json 字段容错为 null，不炸整行', async () => {
  fetchMock.mockResolvedValueOnce(ok({
    ok: true,
    job: serverRow({
      params_json: '{broken',           // 坏 JSON
      progress_json: '',                // 空串
      result_json: 42,                  // 非字符串
    }),
  }));
  const job = await getJob(3);
  expect(job.params).toBe(null);
  expect(job.progress).toBe(null);
  expect(job.result).toBe(null);
});
