// JobCard 单测：自取模式轮询链（挂载即取、2s 节拍、终态停、取数失败续链、卸载清理）、
// 「进行中→done」转移系统通知（挂载即 done 不发）、asr/find 两型进度与汇总渲染、
// 取消按钮（pending 成功 / running 409 文案透出）、受控模式零取数。
// 轮询用 vi.useFakeTimers + advanceTimersByTimeAsync（冲刷定时器与微任务，断言不竞态）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 轮询/通知/取消/受控/卸载 九例 | 失败 5 例 | fixture 误用归一形态，getJob 链路需 server 原始形态（*_json 字符串） |
// | R2 | fixture 改原始形态 + 未知类型/进度未落防御分支 + 取消断言收窄 | 通过 | 2026-10 Phase 4 |
// | R3 | 补 coverage：onChanged 逐轮回调 / 无 props 加载态 / 未知 status 回落 / failed 无 error / done 无 result / 受控取消 / 卸载后 reject | 通过 | 2026-10 Phase 4 收尾 |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { JobCard } from './JobCard';
import type { JobRow, JobStatus } from '../api-jobs';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

// fetch mock 用原始形态：server 直回 DB 行（*_json 是 JSON 字符串），api 层 parseJobRow 负责归一
function row(over: Partial<JobRow> = {}): Record<string, unknown> {
  const merged = {
    id: 7, type: 'asr-backfill', status: 'running',
    params: { source: 'bilibili', size: 5 }, progress: null, result: null, error: null,
    created_at: new Date('2026-10-04T08:00:00').getTime(), updated_at: 0,
    started_at: new Date('2026-10-04T08:00:01').getTime(), finished_at: null,
    ...over,
  };
  const { params, progress, result, ...rest } = merged;
  return {
    ...rest,
    params_json: JSON.stringify(params),
    progress_json: progress == null ? null : JSON.stringify(progress),
    result_json: result == null ? null : JSON.stringify(result),
  };
}

// 受控模式直渲用归一形态（不经 api 层：父组件持有的已是解析后的对象）
function normRow(over: Partial<JobRow>): JobRow {
  return {
    id: 7, type: 'asr-backfill', status: 'running',
    params: { source: 'bilibili', size: 5 }, progress: null, result: null, error: null,
    created_at: new Date('2026-10-04T08:00:00').getTime(), updated_at: 0,
    started_at: new Date('2026-10-04T08:00:01').getTime(), finished_at: null,
    ...over,
  } as JobRow;
}

function stubFetch(handler: () => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => handler());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubNotification(permission: string): {
  calls: Array<{ title: string; options: unknown }>;
  restore: () => void;
} {
  const calls: Array<{ title: string; options: unknown }> = [];
  const g = globalThis as any;
  const prev = g.Notification;
  g.Notification = class {
    static permission = permission;
    constructor(title: string, options: unknown) {
      calls.push({ title, options });
    }
  };
  return {
    calls,
    restore: () => {
      if (prev === undefined) delete g.Notification;
      else g.Notification = prev;
    },
  };
}

// 假计时器下推进：冲刷定时器 + await 化微任务（fetch promise 链），再出断言
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// ── 轮询链与通知 ──

test('轮询推进：挂载即取 → 2s 节拍逐轮刷新进度 → done 汇总 + 转移通知 + 停轮', async () => {
  vi.useFakeTimers();
  const rows = [
    row({ progress: null }), // 首轮 progress 未落 = 还在圈定
    row({ progress: { done: 1, total: 5, failed: { need_login: 1 } } }),
    row({ progress: { done: 2, total: 5, failed: { need_login: 1 } } }),
    row({
      status: 'done', finished_at: new Date('2026-10-04T08:00:31').getTime(),
      result: { circled: 5, done: 4, failed: { need_login: 1 }, samples: { need_login: ['BV1q'] } },
    }),
  ];
  let n = 0;
  const fetchMock = stubFetch(() => ok({ ok: true, job: rows[Math.min(n++, rows.length - 1)] }));
  const note = stubNotification('granted');
  const onChanged = vi.fn();
  try {
    render(<JobCard jobId={7} onChanged={onChanged} />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('ASR 转写')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('圈定中…')).toBeInTheDocument(); // total 未落

    await flush(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('转写中 1/5')).toBeInTheDocument();
    expect(screen.getByText('need_login ×1')).toBeInTheDocument(); // 运行中失败计数（无样例）

    await flush(2000);
    expect(screen.getByText('转写中 2/5')).toBeInTheDocument();

    await flush(2000);
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('圈定 5 · 成功 4 · 失败 need_login 1')).toBeInTheDocument();
    expect(screen.getByText('need_login ×1 · BV1q')).toBeInTheDocument(); // done 后带样例 vid
    // 「进行中→done」转移：恰好一条通知（title 类型中文+#id，body 与卡内汇总同口径）
    expect(note.calls).toHaveLength(1);
    expect(note.calls[0]!.title).toBe('ASR 转写完成（#7）');
    expect(note.calls[0]!.options).toMatchObject({ body: '圈定 5 · 成功 4 · 失败 need_login 1', tag: 'job-done-7' });
    // onChanged 每轮取数后回调（latest-ref），末次为 done 行——父组件据此跟进（如刷新台账）
    expect(onChanged).toHaveBeenCalledTimes(4);
    expect(onChanged.mock.calls[3]![0]).toMatchObject({ id: 7, status: 'done' });

    const polled = fetchMock.mock.calls.length;
    await flush(6000); // 终态后不再排下一轮
    expect(fetchMock.mock.calls.length).toBe(polled);
    // 终态后取消按钮消失
    expect(screen.queryByRole('button', { name: '取消' })).toBe(null);
  } finally { note.restore(); }
});

test('挂载即 done：不通知（无转移可言），取一次即停', async () => {
  vi.useFakeTimers();
  const fetchMock = stubFetch(() => ok({ ok: true, job: row({ status: 'done', result: { circled: 2, done: 2 } }) }));
  const note = stubNotification('granted');
  try {
    render(<JobCard jobId={7} />);
    await flush();
    expect(screen.getByText('圈定 2 · 成功 2')).toBeInTheDocument();
    expect(note.calls).toHaveLength(0);
    await flush(6000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { note.restore(); }
});

test('find 型运行中：progress 未落「启动中」→ search 阶段文案；done 后候选汇总（含建任务档）', async () => {
  vi.useFakeTimers();
  const rows = [
    row({ type: 'collect-find', progress: null }), // 首轮 progress 未落 = 等扩展执行
    row({ type: 'collect-find', progress: { stage: 'search', pages_fetched: 1, candidates: 12 } }),
    row({
      type: 'collect-find', status: 'done',
      finished_at: 1,
      result: { keyword: '加息', candidates: 30, filtered_since: 5, filtered_fans: 8, unknown_fans: 2, collected: { created: 9, skipped: 3 } },
    }),
  ];
  let n = 0;
  stubFetch(() => ok({ ok: true, job: rows[Math.min(n++, rows.length - 1)] }));
  render(<JobCard jobId={7} />);
  await flush();
  expect(screen.getByText('启动中（等待在线扩展执行搜索）…')).toBeInTheDocument();
  await flush(2000);
  expect(screen.getByText('搜索中：已抓 1 页 · 候选 12 条')).toBeInTheDocument();
  await flush(2000);
  expect(screen.getByText('候选 30 · 粉丝过滤剔除 8 · 粉丝未知 2 · 建任务 9（跳过 3）')).toBeInTheDocument();
});

// ── 失败与容错 ──

test('未知类型 running：正文留空（分派无命中），标题/徽章仍出，轮询照常', async () => {
  vi.useFakeTimers();
  const fetchMock = stubFetch(() => ok({ ok: true, job: row({ type: 'future-job' }) }));
  render(<JobCard jobId={7} />);
  await flush();
  expect(screen.getByText('运行中')).toBeInTheDocument();
  expect(screen.queryByText('圈定中…')).toBe(null);
  expect(screen.queryByText('启动中（等待在线扩展执行搜索）…')).toBe(null);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('failed 行：红字透出 server error，终态停轮', async () => {
  vi.useFakeTimers();
  const fetchMock = stubFetch(() => ok({ ok: true, job: row({ status: 'failed', error: 'no online client（扩展未连接）' }) }));
  render(<JobCard jobId={7} />);
  await flush();
  expect(screen.getByText('失败')).toBeInTheDocument();
  expect(screen.getByText('no online client（扩展未连接）')).toBeInTheDocument();
  await flush(6000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('单轮取数失败：红字提示 + 保留旧状态 + 按节拍续链重试，成功后提示清除', async () => {
  vi.useFakeTimers();
  let n = 0;
  const fetchMock = vi.fn(async () => {
    n++;
    if (n === 2) throw new Error('network down');
    return ok({ ok: true, job: row(n === 1
      ? { progress: { done: 1, total: 5 } }
      : { status: 'done', finished_at: 1, result: { circled: 5, done: 5 } }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<JobCard jobId={7} />);
  await flush();
  expect(screen.getByText('转写中 1/5')).toBeInTheDocument();
  await flush(2000); // 第 2 轮抛错
  expect(screen.getByText('刷新失败：network down（将继续重试）')).toBeInTheDocument();
  expect(screen.getByText('转写中 1/5')).toBeInTheDocument(); // 旧状态不清
  await flush(2000); // 续链第 3 轮成功
  expect(screen.getByText('圈定 5 · 成功 5')).toBeInTheDocument();
  expect(screen.queryByText('刷新失败：network down（将继续重试）')).toBe(null);
});

test('卸载清理：卸载后不再排下一轮（无定时器泄漏、无额外取数）', async () => {
  vi.useFakeTimers();
  const fetchMock = stubFetch(() => ok({ ok: true, job: row({ progress: { done: 1, total: 5 } }) }));
  const { unmount } = render(<JobCard jobId={7} />);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  unmount();
  await flush(10000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

// ── 取消 ──

test('取消成功（pending）：DELETE 后就地切「已取消」，不再轮询', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = String((init as RequestInit | undefined)?.method ?? 'GET');
    return ok({ ok: true, job: row({ status: method === 'DELETE' ? 'cancelled' : 'pending' }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<JobCard jobId={7} />);
  await flush();
  expect(screen.getByText('排队中')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await flush();
  expect(screen.getByText('已取消')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '取消' })).toBe(null);
  await flush(6000); // cancelled 终态：轮询链不再续
  expect(fetchMock.mock.calls.filter((c) => String((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'DELETE')).toHaveLength(1);
});

test('取消失败（running 409）：红字透出 server 文案，任务保持运行中', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = String((init as RequestInit | undefined)?.method ?? 'GET');
    if (method === 'DELETE') {
      return new Response(JSON.stringify({ ok: false, error: 'running 任务不可取消' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    return ok({ ok: true, job: row({ progress: { done: 2, total: 5 } }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<JobCard jobId={7} />);
  await flush();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await flush();
  expect(screen.getByText('取消失败：HTTP 409：running 任务不可取消')).toBeInTheDocument();
  expect(screen.getByText('运行中')).toBeInTheDocument();
});

// ── 受控模式 ──

test('受控 job：直渲不取数不通知（父组件持有数据的用法）', async () => {
  vi.useFakeTimers();
  const fetchMock = stubFetch(() => ok({ ok: true, job: row() }));
  const note = stubNotification('granted');
  try {
    render(<JobCard job={normRow({ status: 'done', finished_at: 1, result: { circled: 3, done: 3 } })} />);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(note.calls).toHaveLength(0);
    expect(screen.getByText('圈定 3 · 成功 3')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    await flush(6000);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { note.restore(); }
});

// ── 防御分支（coverage 收尾）──

test('无 props：加载占位「加载任务…」，不发请求也不排轮询（既非自取也非受控）', async () => {
  vi.useFakeTimers();
  const fetchMock = stubFetch(() => ok({ ok: true, job: row() }));
  render(<JobCard />);
  await flush();
  expect(screen.getByText('加载任务…')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
  await flush(6000);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('受控未知 status：徽章回落排队中档（JOB_STATUS_META 缺键防御），正文按类型照常分派', () => {
  render(<JobCard job={normRow({ status: 'weird' as JobStatus })} />);
  expect(screen.getByText('排队中')).toBeInTheDocument(); // 徽章 fallback
  expect(screen.getByText('圈定中…')).toBeInTheDocument(); // 非 failed/done/cancelled/pending → running 分派 → asr 进度
});

test('受控 failed 无 error：兜底文案「任务失败（无错误详情）」，终态不出取消按钮', () => {
  render(<JobCard job={normRow({ status: 'failed', error: null })} />);
  expect(screen.getByText('任务失败（无错误详情）')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '取消' })).toBe(null);
});

test('受控 done 无 result：汇总不炸全部按 0（圈定 0 · 成功 0）', () => {
  render(<JobCard job={normRow({ status: 'done', finished_at: 1, result: null })} />);
  expect(screen.getByText('圈定 0 · 成功 0')).toBeInTheDocument();
});

test('受控模式取消（pending）：DELETE 一发 + onChanged 回调 cancelled 行（就地换状态是父组件职责），无 GET 无轮询', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const method = String((init as RequestInit | undefined)?.method ?? 'GET');
    return ok({ ok: true, job: normRow({ status: method === 'DELETE' ? 'cancelled' : 'pending' }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  render(<JobCard job={normRow({ status: 'pending' })} onChanged={onChanged} />);
  await flush();
  expect(screen.getByText('排队中')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await flush();
  // 受控契约：卡不自带 setFetched（L161 仅自取模式），UI 维持 prop 旧状态；cancelled 行经 onChanged 交父组件换 prop
  expect(screen.getByText('排队中')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1); // 仅 DELETE 一发：受控模式无轮询链
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(onChanged.mock.calls[0]![0]).toMatchObject({ id: 7, status: 'cancelled' });
  await flush(6000);
  expect(fetchMock).toHaveBeenCalledTimes(1); // 取消后也不排任何定时取数
});

test('卸载后在途取数 reject：alive 守卫静默吞掉（无状态更新、无未处理拒绝）', async () => {
  vi.useFakeTimers();
  let rejectFn!: (e: Error) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_res, rej) => { rejectFn = rej; })));
  const { unmount } = render(<JobCard jobId={7} />);
  await flush(); // 首轮取数挂起中
  unmount();
  await act(async () => { rejectFn(new Error('gone')); }); // 卸载后承诺才落定 → catch 命中 alive 守卫
  expect(screen.queryByText('加载任务…')).toBe(null); // 已卸载无残留渲染
});
