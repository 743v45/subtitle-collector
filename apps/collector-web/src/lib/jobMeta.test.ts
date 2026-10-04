// lib/jobMeta.ts 单测：jobs 展示元数据与轮询纯逻辑（无 React 依赖，直测纯函数）。
// 覆盖：类型中文标签映射+未知回落、五态徽章、终态判据/轮询节拍、进度条档位取宽、
// 耗时格式化、失败分布收窄、done 汇总文案（asr/find 两型）、运行中进度文案（两 stage）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 上述九个纯函数全分支 | 通过 | 2026-10 Phase 4 |
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  JOB_POLL_MS, barWidthClass, failedEntries, formatElapsed, formatJobTime,
  isTerminalStatus, jobProgressText, jobResultSummary, jobTypeLabel, nextPollDelay,
} from './jobMeta.ts';
import type { JobRow } from '../api-jobs';

function job(over: Partial<JobRow>): JobRow {
  return {
    id: 1, type: 'asr-backfill', status: 'running',
    params: null, progress: null, result: null, error: null,
    created_at: 0, updated_at: 0, started_at: null, finished_at: null,
    ...over,
  } as JobRow;
}

test('jobTypeLabel：两类型中文标签映射；未知类型回落原值', () => {
  assert.equal(jobTypeLabel('asr-backfill'), 'ASR 转写');
  assert.equal(jobTypeLabel('collect-find'), '搜索采集');
  assert.equal(jobTypeLabel('future-thing'), 'future-thing');
});

test('isTerminalStatus / nextPollDelay：终态三态节拍 0，pending/running 节拍 JOB_POLL_MS', () => {
  assert.equal(JOB_POLL_MS, 2000);
  assert.deepEqual(
    (['done', 'failed', 'cancelled'] as const).map(isTerminalStatus),
    [true, true, true],
  );
  assert.equal(isTerminalStatus('pending'), false);
  assert.equal(isTerminalStatus('running'), false);
  assert.equal(nextPollDelay('running'), JOB_POLL_MS);
  assert.equal(nextPollDelay('pending'), JOB_POLL_MS);
  assert.equal(nextPollDelay('done'), 0);
  assert.equal(nextPollDelay('failed'), 0);
  assert.equal(nextPollDelay('cancelled'), 0);
});

test('barWidthClass：10% 步进取档，0/负/非有限/total<=0 回落 w-0，≥100% 封顶 w-full', () => {
  assert.equal(barWidthClass(0, 5), 'w-0');
  assert.equal(barWidthClass(-1, 5), 'w-0');
  assert.equal(barWidthClass(NaN, 5), 'w-0');
  assert.equal(barWidthClass(3, 0), 'w-0');
  assert.equal(barWidthClass(1, 3), 'w-[30%]');   // 33.3% → floor(33/10)=3 档
  assert.equal(barWidthClass(1, 2), 'w-[50%]');
  assert.equal(barWidthClass(5, 5), 'w-full');
  assert.equal(barWidthClass(9, 5), 'w-full');    // 超额封顶
  assert.equal(barWidthClass(Infinity, 5), 'w-0'); // 非有限值走防御回落（与标题口径一致）
});

test('formatJobTime：ms → MM/DD HH:mm；空值回落空串', () => {
  assert.ok(/^\d{2}\/\d{2} \d{2}:\d{2}$/.test(formatJobTime(new Date('2026-10-04T08:05:00').getTime())));
  assert.equal(formatJobTime(null), '');
  assert.equal(formatJobTime(undefined), '');
  assert.equal(formatJobTime(0), '');
});

test('formatElapsed：<60s 为 Ns；≥60s 为 NmNs；未 started 回空；终态无 finished_at 回落 started_at', () => {
  const t0 = 1_000_000;
  assert.equal(formatElapsed({ status: 'running', started_at: null, finished_at: null }), '');
  assert.equal(
    formatElapsed({ status: 'running', started_at: t0, finished_at: null }, t0 + 45_000),
    '45s',
  );
  assert.equal(
    formatElapsed({ status: 'running', started_at: t0, finished_at: null }, t0 + 65_000),
    '1m5s',
  );
  // done 但 finished_at 缺（历史行）→ 用 started_at 兜底，耗时 0s 而非 NaN/负
  assert.equal(formatElapsed({ status: 'done', started_at: t0, finished_at: null }, t0 + 999_999), '0s');
  assert.equal(
    formatElapsed({ status: 'done', started_at: t0, finished_at: t0 + 130_000 }, t0),
    '2m10s',
  );
});

test('failedEntries：滤零项 + 计数降序；空/缺回落空数组', () => {
  assert.deepEqual(failedEntries({ need_login: 2, no_audio: 5, other: 0 }), [['no_audio', 5], ['need_login', 2]]);
  assert.deepEqual(failedEntries({}), []);
  assert.deepEqual(failedEntries(null), []);
  assert.deepEqual(failedEntries(undefined), []);
});

test('jobResultSummary：asr 型「圈定/成功/失败分布」，无失败省略失败档', () => {
  assert.equal(
    jobResultSummary(job({
      status: 'done',
      result: { source: 'douyin', circled: 5, done: 4, dry_run: false, failed: { need_login: 1 }, samples: {} },
    })),
    '圈定 5 · 成功 4 · 失败 need_login 1',
  );
  assert.equal(
    jobResultSummary(job({ status: 'done', result: { circled: 3, done: 3, failed: {}, samples: {} } })),
    '圈定 3 · 成功 3',
  );
  // result 缺失（异常行）不炸，全部按 0
  assert.equal(jobResultSummary(job({ status: 'done', result: null })), '圈定 0 · 成功 0');
});

test('jobResultSummary：find 型候选/过滤链计数，collected 有无切换建任务档', () => {
  assert.equal(
    jobResultSummary(job({
      type: 'collect-find', status: 'done',
      result: { keyword: 'k', candidates: 20, filtered_since: 5, filtered_fans: 3, unknown_fans: 2 },
    })),
    '候选 20 · 粉丝过滤剔除 3 · 粉丝未知 2',
  );
  assert.equal(
    jobResultSummary(job({
      type: 'collect-find', status: 'done',
      result: { candidates: 20, filtered_since: 0, filtered_fans: 3, unknown_fans: 0, collected: { created: 7, skipped: 2 } },
    })),
    '候选 20 · 粉丝过滤剔除 3 · 粉丝未知 0 · 建任务 7（跳过 2）',
  );
  // result 缺失（异常行）不炸，全部按 0
  assert.equal(jobResultSummary(job({ type: 'collect-find', status: 'done', result: null })), '候选 0 · 粉丝过滤剔除 0 · 粉丝未知 0');
});

test('jobProgressText：search 与 filter 两 stage 各自的计数文案', () => {
  assert.equal(
    jobProgressText({ stage: 'search', pages_fetched: 2, candidates: 37 }),
    '搜索中：已抓 2 页 · 候选 37 条',
  );
  assert.equal(
    jobProgressText({ stage: 'filter', pages_fetched: 3, candidates: 60, filtered_since: 10, filtered_fans: 8, unknown_fans: 4 }),
    '过滤中：已抓 3 页 · 候选 60 · 时间过滤剔除 10 · 粉丝过滤剔除 8 · 粉丝未知 4',
  );
  // 缺字段落 0 不炸
  assert.equal(jobProgressText({}), '搜索中：已抓 0 页 · 候选 0 条');
  assert.equal(jobProgressText({ stage: 'filter' }), '过滤中：已抓 0 页 · 候选 0 · 时间过滤剔除 0 · 粉丝过滤剔除 0 · 粉丝未知 0');
});
