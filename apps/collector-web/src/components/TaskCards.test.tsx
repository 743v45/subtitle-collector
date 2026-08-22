// TaskCards 组件单测：TaskRow（状态徽章/标题回落/重试/删除/详情跳转/就地预览）、BatchTaskCard
// （徽章派生/展开子任务/整批删除/重试）、纯函数（retryable/resultSummary/retrySummary/formatTs）、
// resubmitTasks（retry 端点契约）。
// 跑法：npx vitest run src/components/TaskCards.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 纯函数：retryable/formatTs/resultSummary/retrySummary 全分支 | 通过 | resultSummary 覆盖 reason×3/captured/tracks/坏 JSON |
// | R2 | TaskRow：标题/回落、重试·删除·详情按钮、展开预览（getVideo+getVersion） | 通过 | fetch stub 按 URL 路由 |
// | R3 | TaskRow 预览失败路径：getVideo 500、getVersion 500+重试 | 通过 | |
// | R4 | BatchTaskCard：五类徽章派生、展开子行、重试/删除/聚焦回调 | 通过 | |
// | R5 | resubmitTasks：无可重试不发请求；retry 端点 alreadyOk 拆分 | 通过 | |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  TaskRow, BatchTaskCard, retryable, resubmitTasks, retrySummary, formatTs, resultSummary,
} from './TaskCards';
import type { CollectTask, CollectTaskStatus } from '../types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

// ── fixtures ──

function task(p: Partial<CollectTask> & { id: number }): CollectTask {
  return {
    source: 'bilibili',
    source_vid: `BV1xx41${p.id}`,
    url: `https://www.bilibili.com/video/BV1xx41${p.id}`,
    status: 'succeeded',
    client_id: null,
    batch_id: null,
    error: null,
    result: null,
    title: null,
    creator_name: null,
    created_at: 1_700_000_000_000,
    finished_at: null,
    ...p,
  };
}

const ok = jsonResponse({ ok: true });
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const r = handler(url, init);
    return r instanceof Response ? r : jsonResponse(r ?? { ok: true });
  }));
}

const detailPayload = {
  ok: true,
  video: {
    title: '示例视频', creator_name: 'UP主', duration: 120, extra: JSON.stringify({ tname: '生活' }),
  },
  tracks: [
    {
      id: 11, lan: 'zh-CN', lan_doc: '中文（简体）', track_type: 1, is_default: true,
      versions: [{ id: 111, origin: 'external', is_default: true }],
    },
    { id: 12, lan: 'ai-ZH', lan_doc: '中文（自动）', track_type: 2, versions: [{ id: 121, origin: 'asr' }] },
  ],
  tag_details: [],
};

// ── 纯函数 ──

test('retryable：failed/limited 可重试，其余不可', () => {
  const cases: Array<[CollectTaskStatus, boolean]> = [
    ['pending', false], ['dispatched', false], ['succeeded', false], ['failed', true], ['limited', true],
  ];
  for (const [s, want] of cases) expect(retryable(task({ id: 1, status: s }))).toBe(want);
});

test('formatTs：null/0 → 空串；有值 → HH:MM（本地时区）', () => {
  expect(formatTs(null)).toBe('');
  expect(formatTs(0)).toBe('');
  expect(formatTs(1_700_000_000_000)).toMatch(/^\d{2}:\d{2}$/);
});

test('resultSummary 全分支', () => {
  const t = (p: Partial<CollectTask>) => task({ id: 9, ...p });
  expect(resultSummary(t({ status: 'failed', error: '扩展离线' }))).toBe('扩展离线');
  expect(resultSummary(t({ status: 'failed', error: null }))).toBe('采集失败');
  expect(resultSummary(t({ status: 'limited' }))).toContain('字幕受限（pot）');
  expect(resultSummary(t({ status: 'pending' }))).toContain('等待派发');
  expect(resultSummary(t({ status: 'dispatched', result: null }))).toBe('已下发到扩展…');
  expect(resultSummary(t({ status: 'succeeded', result: null }))).toBe('');
  expect(resultSummary(t({ status: 'succeeded', result: JSON.stringify({ reason: 'no_subtitle' }) }))).toBe('视频无字幕轨');
  expect(resultSummary(t({ status: 'succeeded', result: JSON.stringify({ reason: 'pot_limited' }) }))).toContain('字幕受限');
  expect(resultSummary(t({ status: 'succeeded', result: JSON.stringify({ reason: 'already_collected', tracks: 2 }) }))).toBe('库内已有字幕（2 轨），重试免重采');
  expect(resultSummary(t({ status: 'succeeded', result: JSON.stringify({ captured: 3 }) }))).toBe('采到 3 轨字幕');
  expect(resultSummary(t({ status: 'succeeded', result: JSON.stringify({ tracks: 1 }) }))).toBe('采到 1 轨字幕');
  expect(resultSummary(t({ status: 'succeeded', result: 'not-json{' }))).toBe('');
});

test('retrySummary 四分支', () => {
  expect(retrySummary({ dispatched: 2, alreadyOk: 1 })).toBe('已重新下发 2 个任务；1 个库内已有字幕，直接标记成功');
  expect(retrySummary({ dispatched: 0, alreadyOk: 1 })).toContain('直接标记成功');
  expect(retrySummary({ dispatched: 2, alreadyOk: 0 })).toBe('已重试 2 个任务（扩展在线即开始采集）');
  expect(retrySummary({ dispatched: 0, alreadyOk: 0 })).toBe('没有可重试的任务（可能已在队列中）');
});

// ── resubmitTasks ──

test('resubmitTasks：无可重试行 → 不发请求，全 0', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const r = await resubmitTasks([task({ id: 1, status: 'succeeded' }), task({ id: 2, status: 'pending' })]);
  expect(r).toEqual({ dispatched: 0, alreadyOk: 0 });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('resubmitTasks：retry 端点 POST ids，retried - alreadyOk = dispatched', async () => {
  stubFetch((url, init) => {
    if (url.includes('/api/collect-tasks/retry')) {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ ids: [1, 3] });
      return {
        ok: true, retried: 2,
        tasks: [task({ id: 1, status: 'pending' }), task({ id: 3, status: 'succeeded' })],
      };
    }
  });
  const r = await resubmitTasks([
    task({ id: 1, status: 'failed' }), task({ id: 2, status: 'succeeded' }), task({ id: 3, status: 'limited' }),
  ]);
  expect(r).toEqual({ dispatched: 1, alreadyOk: 1 });
});

// ── TaskRow ──

test('TaskRow：状态徽章 + 标题直出（含 UP 名外链）+ 时间 + 删除回调', () => {
  const onDelete = vi.fn();
  render(
    <TaskRow
      task={task({ id: 1, status: 'failed', error: '扩展离线', title: '失败的视频', creator_name: '某UP', creator_source_uid: '42' })}
      onDelete={onDelete}
    />,
  );
  expect(screen.getByText('失败')).toBeInTheDocument();
  expect(screen.getByText('失败的视频')).toBeInTheDocument();
  expect(screen.getByText('扩展离线')).toBeInTheDocument();
  // 次行：平台 · BV号 · UP名（带空间外链）
  expect(screen.getByLabelText('在原站打开 某UP 的空间').getAttribute('href')).toBe('https://space.bilibili.com/42');
  fireEvent.click(screen.getByRole('button', { name: '删除任务' }));
  expect(onDelete).toHaveBeenCalledWith(1);
});

test('TaskRow：无标题回落 平台·BV号；YouTube 平台标签', () => {
  render(
    <TaskRow
      task={task({ id: 2, source: 'youtube', source_vid: 'abc123', url: 'https://youtu.be/abc123', status: 'pending', title: null })}
      onDelete={() => {}}
    />,
  );
  expect(screen.getByText('YouTube · abc123')).toBeInTheDocument();
  expect(screen.getByText('排队中')).toBeInTheDocument();
  expect(screen.getByText('等待派发（扩展上线后自动开始）')).toBeInTheDocument();
});

test('TaskRow：有标题 + creator_name 但无 uid → 次行纯文本 UP 名（不外链）', () => {
  render(
    <TaskRow task={task({ id: 3, title: '有标题', creator_name: '纯名UP', creator_source_uid: null })} onDelete={() => {}} />,
  );
  expect(screen.getByText(/· 纯名UP ·/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/空间/)).toBe(null);
});

test('TaskRow：failed 有 onRetry → 重试按钮触发回调；无 onRetry 不渲染', () => {
  const onRetry = vi.fn();
  const t = task({ id: 3, status: 'failed' });
  const { unmount } = render(<TaskRow task={t} onDelete={() => {}} onRetry={onRetry} />);
  fireEvent.click(screen.getByRole('button', { name: '重试采集' }));
  expect(onRetry).toHaveBeenCalledWith(t);
  unmount();

  render(<TaskRow task={t} onDelete={() => {}} />);
  expect(screen.queryByRole('button', { name: '重试采集' })).toBe(null);
});

test('TaskRow：succeeded → 详情跳转 + 展开预览（轨列表 + 默认版正文 + 完整字幕跳转）', async () => {
  stubFetch((url) => {
    if (url.includes('/api/videos/bilibili/')) return detailPayload;
    if (url.includes('/api/versions/111')) {
      return { ok: true, version: { id: 111, origin: 'external', captured_at: 0, payload: { body: [{ from: 1, to: 2, content: '预览第一行' }] } } };
    }
  });
  render(<TaskRow task={task({ id: 4, status: 'succeeded', title: '完成的视频' })} onDelete={() => {}} />);

  // 详情跳转按钮
  fireEvent.click(screen.getByRole('button', { name: '查看视频详情' }));
  expect(window.location.hash).toBe('#/videos/bilibili/BV1xx414');

  // 展开预览
  fireEvent.click(screen.getByRole('button', { name: '展开预览' }));
  expect(await screen.findByText(/中文（简体） · 1 版/)).toBeInTheDocument();
  expect(await screen.findByText('预览第一行')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查看完整字幕' }));
  expect(window.location.hash).toBe('#/videos/bilibili/BV1xx414');
});

test('TaskRow 预览：视频无字幕轨（仅元信息入库）', async () => {
  stubFetch((url) => {
    if (url.includes('/api/videos/')) return { ok: true, video: { title: 'x', creator_name: null, duration: null }, tracks: [] };
  });
  render(<TaskRow task={task({ id: 5, status: 'succeeded' })} onDelete={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '展开预览' }));
  expect(await screen.findByText('视频无字幕轨（仅元信息入库）')).toBeInTheDocument();
});

test('TaskRow 预览：getVideo 失败 → 预览加载失败', async () => {
  stubFetch(() => jsonResponse({ ok: false, error: 'nope' }, 500));
  render(<TaskRow task={task({ id: 6, status: 'succeeded' })} onDelete={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '展开预览' }));
  expect(await screen.findByText(/预览加载失败:/)).toBeInTheDocument();
});

test('TaskRow 预览：getVersion 失败 → 字幕加载失败 + 重试按钮', async () => {
  let fail = true;
  stubFetch((url) => {
    if (url.includes('/api/videos/')) return detailPayload;
    if (url.includes('/api/versions/')) {
      return fail ? jsonResponse({ ok: false, error: 'gone' }, 500) : ok;
    }
  });
  render(<TaskRow task={task({ id: 7, status: 'succeeded' })} onDelete={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '展开预览' }));
  expect(await screen.findByText(/字幕加载失败:/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  fail = false;
  expect(await screen.findByText(/中文（简体） · 1 版/)).toBeInTheDocument();
});

test('TaskRow 预览：字幕体为空', async () => {
  stubFetch((url) => {
    if (url.includes('/api/videos/')) return detailPayload;
    if (url.includes('/api/versions/')) return { ok: true, version: { id: 111, origin: 'external', captured_at: 0, payload: { body: [] } } };
  });
  render(<TaskRow task={task({ id: 8, status: 'succeeded' })} onDelete={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '展开预览' }));
  expect(await screen.findByText('（字幕体为空）')).toBeInTheDocument();
});

// ── BatchTaskCard ──

function batch(items: Array<Partial<CollectTask> & { id: number; status: CollectTaskStatus }>) {
  return items.map((p, i) => task({ batch_id: 'batch-abcdef01', created_at: 1000 + i, ...p }));
}

test('BatchTaskCard 徽章派生：进行中（dispatched → 采集中 / 仅 pending → 排队中）', () => {
  const { unmount } = render(
    <BatchTaskCard items={batch([{ id: 1, status: 'dispatched' }, { id: 2, status: 'pending' }])} onDelete={() => {}} onDeleteBatch={() => {}} />,
  );
  expect(screen.getByText('采集中')).toBeInTheDocument();
  unmount();

  render(
    <BatchTaskCard items={batch([{ id: 1, status: 'pending' }, { id: 2, status: 'pending' }])} onDelete={() => {}} onDeleteBatch={() => {}} />,
  );
  expect(screen.getByText('排队中')).toBeInTheDocument();
});

test('BatchTaskCard 徽章派生：完成 N 失败 M / 失败 M / 受限 N / 已完成 N', () => {
  const cases: Array<[CollectTaskStatus[], string]> = [
    [[ 'succeeded', 'failed' ], '完成 1 失败 1'],
    [[ 'failed', 'failed' ], '失败 2'],
    [[ 'succeeded', 'limited' ], '受限 1'],
    [[ 'succeeded', 'succeeded' ], '已完成 2'],
  ];
  for (const [statuses, label] of cases) {
    const { unmount } = render(
      <BatchTaskCard
        items={batch(statuses.map((s, i) => ({ id: i + 1, status: s })))}
        onDelete={() => {}} onDeleteBatch={() => {}}
      />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
    unmount();
  }
});

test('BatchTaskCard：平台并集、ok/total、最早时间；展开子行（外链/摘要/子重试/子删除）', () => {
  const onDelete = vi.fn();
  const onRetryTask = vi.fn();
  const onDeleteBatch = vi.fn();
  const items = batch([
    { id: 1, status: 'succeeded', title: '批量A', result: JSON.stringify({ tracks: 2 }) },
    { id: 2, source: 'youtube', source_vid: 'yt1', url: 'https://youtu.be/yt1', status: 'failed', error: 'boom' },
  ]);
  render(
    <BatchTaskCard items={items} onDelete={onDelete} onDeleteBatch={onDeleteBatch} onRetryTask={onRetryTask} />,
  );
  expect(screen.getByText(/批量采集 · 2 个视频/)).toBeInTheDocument();
  expect(screen.getByText('B站/YouTube')).toBeInTheDocument();
  expect(screen.getByText('1/2')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '展开子任务' }));
  expect(screen.getByText('批量A')).toBeInTheDocument();
  expect(screen.getByText('YouTube · yt1')).toBeInTheDocument();
  expect(screen.getByText('boom')).toBeInTheDocument();
  expect(screen.getAllByLabelText('在原站打开视频').length).toBe(2); // 卡头无外链，仅子行 2 个
  fireEvent.click(screen.getByRole('button', { name: '重试子任务' }));
  expect(onRetryTask).toHaveBeenCalledWith(items[1]);
  fireEvent.click(screen.getAllByRole('button', { name: '删除子任务' })[1]); // 第二子行（yt1/failed）
  expect(onDelete).toHaveBeenCalledWith(2);
  fireEvent.click(screen.getByRole('button', { name: '删除整个批次' }));
  expect(onDeleteBatch).toHaveBeenCalledWith('batch-abcdef01');
});

test('BatchTaskCard：整批重试（失败+受限过滤）与聚焦跳转；无 onRetry 不渲染重试按钮', () => {
  const onRetry = vi.fn();
  const items = batch([
    { id: 1, status: 'succeeded' },
    { id: 2, status: 'failed' },
    { id: 3, status: 'limited' },
  ]);
  const { unmount } = render(
    <BatchTaskCard items={items} onDelete={() => {}} onDeleteBatch={() => {}} onRetry={onRetry} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '重试 2 个未成功' }));
  expect(onRetry).toHaveBeenCalledWith([items[1], items[2]]);
  // 聚焦：跳历史页 batch_id
  fireEvent.click(screen.getByRole('button', { name: '在历史页查看整批' }));
  expect(window.location.hash).toBe('#/history?batch_id=batch-abcdef01');
  unmount();

  render(<BatchTaskCard items={items} onDelete={() => {}} onDeleteBatch={() => {}} />);
  expect(screen.queryByRole('button', { name: '重试 2 个未成功' })).toBe(null);
});

test('BatchTaskCard：子行标题回落 title 属性（未入库）', () => {
  render(
    <BatchTaskCard
      items={batch([{ id: 1, status: 'pending', title: null }])}
      onDelete={() => {}} onDeleteBatch={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '展开子任务' }));
  expect(screen.getByTitle('B站 · BV1xx411')).toBeInTheDocument();
});
