// ── 任务完成通知纯函数（2026-08-22）──
// terminalTransitions：轮询前后两次任务列表的「进行中→终态」转移检测
// （被删除的任务不算完成——id 在 next 消失即出局）；notifyText：终态汇总文案。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isActiveStatus, notifyText, terminalTransitions, sendTaskDoneNotification, requestTaskNotifyPermission } from './taskNotify.ts';
import type { CollectTask, CollectTaskStatus } from '../types';

function task(id: number, status: CollectTaskStatus): CollectTask {
  return {
    id,
    source: 'youtube',
    source_vid: `vid${id}`,
    url: `https://www.youtube.com/watch?v=vid${id}`,
    status,
    client_id: null,
    batch_id: null,
    error: null,
    result: null,
    title: null,
    creator_name: null,
    created_at: 0,
    finished_at: null,
  };
}

test('isActiveStatus：pending/dispatched 为进行中，三个终态不是', () => {
  assert.equal(isActiveStatus('pending'), true);
  assert.equal(isActiveStatus('dispatched'), true);
  assert.equal(isActiveStatus('succeeded'), false);
  assert.equal(isActiveStatus('failed'), false);
  assert.equal(isActiveStatus('limited'), false);
});

test('terminalTransitions：检出进行中→终态转移（pending→succeeded、dispatched→failed）', () => {
  const prev = [task(1, 'pending'), task(2, 'dispatched'), task(3, 'succeeded')];
  const next = [task(1, 'succeeded'), task(2, 'failed'), task(3, 'succeeded')];
  const moved = terminalTransitions(prev, next);
  assert.deepEqual(moved.map((t) => t.id), [1, 2]);
  assert.deepEqual(moved.map((t) => t.status), ['succeeded', 'failed']);
});

test('terminalTransitions：prev 已是终态的不计（无转移可言）', () => {
  const prev = [task(1, 'succeeded'), task(2, 'failed')];
  const next = [task(1, 'succeeded'), task(2, 'limited')];
  assert.deepEqual(terminalTransitions(prev, next), []);
});

test('terminalTransitions：prev 进行中但 next 中被删除 → 不算完成', () => {
  const prev = [task(1, 'dispatched'), task(2, 'pending')];
  const next = [task(2, 'succeeded')]; // 1 被删（乐观删除/他处删除）
  const moved = terminalTransitions(prev, next);
  assert.deepEqual(moved.map((t) => t.id), [2]);
});

test('terminalTransitions：next 新出现即为终态的不计（首见无转移）', () => {
  const prev = [task(1, 'pending')];
  const next = [task(1, 'succeeded'), task(9, 'failed')]; // 9 是新行（如重试并入原批次）
  const moved = terminalTransitions(prev, next);
  assert.deepEqual(moved.map((t) => t.id), [1]);
});

test('terminalTransitions：空 prev（首拉）零转移——首屏不误报', () => {
  assert.deepEqual(terminalTransitions([], [task(1, 'succeeded'), task(2, 'pending')]), []);
});

test('notifyText：成功/受限/失败计数，零档省略', () => {
  assert.equal(notifyText([task(1, 'succeeded'), task(2, 'succeeded')]), '成功 2');
  assert.equal(
    notifyText([task(1, 'succeeded'), task(2, 'limited'), task(3, 'failed')]),
    '成功 1 · 受限 1 · 失败 1',
  );
  assert.equal(notifyText([task(1, 'failed'), task(2, 'failed')]), '成功 0 · 失败 2');
  assert.equal(notifyText([task(1, 'limited')]), '成功 0 · 受限 1');
});

// ── sendTaskDoneNotification / requestTaskNotifyPermission（Node 下 stub globalThis.Notification）──

interface NotificationCall { title: string; options: unknown }

function stubNotification(opts: {
  permission?: string;
  ctorThrows?: boolean;
  requestImpl?: () => unknown;
}): { calls: NotificationCall[]; state: { requested: number }; restore: () => void } {
  const calls: NotificationCall[] = [];
  const state = { requested: 0 };
  const g = globalThis as any;
  const prev = g.Notification;
  g.Notification = class FakeNotification {
    static permission = opts.permission ?? 'granted';
    static requestPermission(): unknown {
      state.requested++;
      return opts.requestImpl ? opts.requestImpl() : 'granted';
    }
    constructor(title: string, options: unknown) {
      if (opts.ctorThrows) throw new Error('policy blocked');
      calls.push({ title, options });
    }
  };
  return {
    calls, state,
    restore: () => {
      if (prev === undefined) delete g.Notification;
      else g.Notification = prev;
    },
  };
}

test('sendTaskDoneNotification：空完成列表不发（无转移不误弹）', () => {
  const n = stubNotification({ permission: 'granted' });
  try {
    sendTaskDoneNotification([]);
    assert.equal(n.calls.length, 0);
  } finally { n.restore(); }
});

test('sendTaskDoneNotification：granted → 一条汇总通知（title 固定 / body 汇总 / tag 替换式不堆叠）', () => {
  const n = stubNotification({ permission: 'granted' });
  try {
    sendTaskDoneNotification([task(1, 'succeeded'), task(2, 'limited'), task(3, 'failed')]);
    assert.equal(n.calls.length, 1);
    assert.equal(n.calls[0]!.title, '采集任务已全部完成');
    assert.deepEqual(n.calls[0]!.options, { body: '成功 1 · 受限 1 · 失败 1', tag: 'collect-done' });
  } finally { n.restore(); }
});

test('sendTaskDoneNotification：未授权（denied）静默跳过', () => {
  const n = stubNotification({ permission: 'denied' });
  try {
    sendTaskDoneNotification([task(1, 'succeeded')]);
    assert.equal(n.calls.length, 0);
  } finally { n.restore(); }
});

test('sendTaskDoneNotification：API 不可用（非安全上下文）静默跳过', () => {
  const g = globalThis as any;
  const prev = g.Notification;
  delete g.Notification;
  try {
    sendTaskDoneNotification([task(1, 'succeeded')]); // 不抛即过
    requestTaskNotifyPermission();
  } finally {
    if (prev !== undefined) g.Notification = prev;
  }
});

test('sendTaskDoneNotification：构造抛错被吞（策略拦截/老环境不冒泡）', () => {
  const n = stubNotification({ permission: 'granted', ctorThrows: true });
  try {
    sendTaskDoneNotification([task(1, 'succeeded')]); // 不抛即过
  } finally { n.restore(); }
});

test('requestTaskNotifyPermission：default 才发起请求；非 default 是 no-op', () => {
  const d = stubNotification({ permission: 'default' });
  try {
    requestTaskNotifyPermission();
    assert.equal(d.state.requested, 1);
  } finally { d.restore(); }

  const g1 = stubNotification({ permission: 'granted' });
  try {
    requestTaskNotifyPermission();
    assert.equal(g1.state.requested, 0);
  } finally { g1.restore(); }

  const g2 = stubNotification({ permission: 'denied' });
  try {
    requestTaskNotifyPermission();
    assert.equal(g2.state.requested, 0);
  } finally { g2.restore(); }
});

test('requestTaskNotifyPermission：requestPermission 拒绝（rejected）与同步抛错都不冒泡', async () => {
  const rej = stubNotification({ permission: 'default', requestImpl: () => Promise.reject(new Error('denied')) });
  try {
    requestTaskNotifyPermission();
    // 等微任务落定：无 catch 的话这里会变成 unhandled rejection
    await new Promise((r) => setTimeout(r, 0));
  } finally { rej.restore(); }

  const sync = stubNotification({ permission: 'default', requestImpl: () => { throw new Error('legacy callback form'); } });
  try {
    requestTaskNotifyPermission(); // 不抛即过
  } finally { sync.restore(); }
});
