// popup「已采」刷新触发器(collected-refresh.mjs)纯逻辑的测试。
// 背景:2026-08-24 用户报告「popup 已采 没同步」——useCreatorCollected 原只在 popup
// 打开时拉一次已采集合,popup 开着时单视频上报(INGEST_RESULT)或批量任务终态
// (TASK_UPDATE 推送)后,列表绿点与「已采 N」不刷新。本模块把「哪些消息触发重拉、
// 如何去抖」固化为可测纯逻辑;hook 侧只做 chrome 消息接线(接线由 useLocalCollected /
// useCollectTasks 同款 onMessage 模式覆盖,不在 node:test 范围)。
// 验证:触发条件(上报 ok / 任务 succeeded/limited 终态)、非触发(失败上报 / 非终态 /
// failed)、去抖窗口内合并为一次、窗口后新消息再触发、dispose 后不再触发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollectedRefresh } from '../collected-refresh.mjs';

// 异步等到去抖计时器到期(delay 后再留一点余量),避免测试对真实计时精度敏感
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('INGEST_RESULT ok=true → 触发一次重拉;ok=false 不触发', async () => {
  let n = 0;
  const c = createCollectedRefresh({ delay: 10, onRefresh: () => n++ });
  c.notify({ type: 'INGEST_RESULT', ok: true, source_vid: 'BV1x' });
  c.notify({ type: 'INGEST_RESULT', ok: false, source_vid: 'BV1y' });
  await settle();
  assert.equal(n, 1); // 失败上报未入库,不追加触发;成功那条触发一次
  c.dispose();
});

test('TASK_UPDATE 终态 succeeded/limited → 触发;failed/pending/dispatched 不触发', async () => {
  let n = 0;
  const c = createCollectedRefresh({ delay: 10, onRefresh: () => n++ });
  // 非终态与 failed 先喂(均不应安排触发;failed 通常未入库)
  c.notify({ type: 'TASK_UPDATE', task: { id: 1, status: 'pending' } });
  c.notify({ type: 'TASK_UPDATE', task: { id: 1, status: 'dispatched' } });
  c.notify({ type: 'TASK_UPDATE', task: { id: 1, status: 'failed' } });
  await settle();
  assert.equal(n, 0);
  // succeeded(limited=0 轨入库但元信息已入库)与 limited 均有库变更 → 触发
  c.notify({ type: 'TASK_UPDATE', task: { id: 1, status: 'succeeded' } });
  await settle();
  assert.equal(n, 1);
  c.notify({ type: 'TASK_UPDATE', task: { id: 2, status: 'limited' } });
  await settle();
  assert.equal(n, 2);
  c.dispose();
});

test('去抖合并:窗口内连发多条终态只触发一次(批量任务串行完成的常态)', async () => {
  let n = 0;
  const c = createCollectedRefresh({ delay: 30, onRefresh: () => n++ });
  c.notify({ type: 'TASK_UPDATE', task: { id: 1, status: 'succeeded' } });
  c.notify({ type: 'TASK_UPDATE', task: { id: 2, status: 'succeeded' } });
  c.notify({ type: 'INGEST_RESULT', ok: true });
  c.notify({ type: 'TASK_UPDATE', task: { id: 3, status: 'limited' } });
  await settle(80);
  assert.equal(n, 1); // 全部落在同一去抖窗口 → 合并为一次重拉
  c.dispose();
});

test('窗口结束后新消息再开新窗口(串行批量约 8s 间隔,逐批落地逐次刷新)', async () => {
  let n = 0;
  const c = createCollectedRefresh({ delay: 10, onRefresh: () => n++ });
  c.notify({ type: 'TASK_UPDATE', task: { id: 1, status: 'succeeded' } });
  await settle(); // 第一窗触发完毕
  c.notify({ type: 'TASK_UPDATE', task: { id: 2, status: 'succeeded' } });
  await settle();
  assert.equal(n, 2);
  c.dispose();
});

test('dispose 清掉未触发的计时器:卸载后不再回调', async () => {
  let n = 0;
  const c = createCollectedRefresh({ delay: 20, onRefresh: () => n++ });
  c.notify({ type: 'INGEST_RESULT', ok: true });
  c.dispose(); // 窗口内卸载(popup 关闭)
  await settle(60);
  assert.equal(n, 0);
});

test('无关消息类型与非对象输入不触发、不抛错', async () => {
  let n = 0;
  const c = createCollectedRefresh({ delay: 10, onRefresh: () => n++ });
  c.notify(null);
  c.notify(undefined);
  c.notify('TASK_UPDATE');
  c.notify({ type: 'TASK_UPDATE' }); // 无 task 字段
  c.notify({ type: 'SOMETHING_ELSE', task: { status: 'succeeded' } });
  await settle();
  assert.equal(n, 0);
  c.dispose();
});

test('onRefresh 缺失 → 构造即抛(接线错误 fail-fast)', () => {
  assert.throws(() => createCollectedRefresh({}), /onRefresh/);
  assert.throws(() => createCollectedRefresh(), /onRefresh/);
});
