// ── 任务完成通知纯函数（2026-08-22）──
// terminalTransitions：轮询前后两次任务列表的「进行中→终态」转移检测
// （被删除的任务不算完成——id 在 next 消失即出局）；notifyText：终态汇总文案。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActiveStatus, notifyText, terminalTransitions } from './taskNotify.ts';
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
