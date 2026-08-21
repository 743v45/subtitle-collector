// 采集历史页筛选 ↔ URLSearchParams 序列化纯函数测试（node 内建 TS type-stripping）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskHistoryFromQuery, taskHistoryToQuery, isMidLike, TASK_HISTORY_DEFAULTS, type TaskHistoryQueryState } from './taskHistoryFilterUrl.ts';

const DEFAULTS: TaskHistoryQueryState = TASK_HISTORY_DEFAULTS;

test('taskHistoryFromQuery：空 query → 全默认', () => {
  assert.deepEqual(taskHistoryFromQuery(new URLSearchParams('')), DEFAULTS);
});

test('taskHistoryToQuery：默认值 → 空串（空值省略，URL 干净）', () => {
  assert.equal(taskHistoryToQuery(DEFAULTS).toString(), '');
});

test('roundtrip：全量非默认值 → query → 还原相等', () => {
  const s: TaskHistoryQueryState = {
    status: 'failed,limited', source: 'youtube', creator: '张三', q: '关键词',
    range: 'custom', sinceDate: '2026-01-01', untilDate: '2026-02-01',
    batchId: 'b-123', page: 3,
  };
  assert.deepEqual(taskHistoryFromQuery(taskHistoryToQuery(s)), s);
});

test('creator 判别：纯数字写 creator_uid（无 creator），文本写 creator', () => {
  const byUid = taskHistoryToQuery({ ...DEFAULTS, creator: '296399504' });
  assert.equal(byUid.get('creator_uid'), '296399504');
  assert.equal(byUid.get('creator'), null);

  const byName = taskHistoryToQuery({ ...DEFAULTS, creator: '张三' });
  assert.equal(byName.get('creator'), '张三');
  assert.equal(byName.get('creator_uid'), null);

  // fromQuery 还原：uid 优先（手输 URL 两种参数都能回到 state.creator）
  assert.equal(taskHistoryFromQuery(new URLSearchParams('creator_uid=1')).creator, '1');
  assert.equal(taskHistoryFromQuery(new URLSearchParams('creator=李四')).creator, '李四');
  assert.equal(isMidLike('123'), true);
  assert.equal(isMidLike('12a3'), false);
});

test('range 互斥：preset 激活不写日期串；custom 只写日期串；非法值回落', () => {
  const preset = taskHistoryToQuery({ ...DEFAULTS, range: '7d', sinceDate: '2026-01-01' });
  assert.equal(preset.get('range'), '7d');
  assert.equal(preset.get('since_date'), null); // preset 态日期串不进 URL（单一真相）

  const custom = taskHistoryToQuery({ ...DEFAULTS, range: 'custom', sinceDate: '2026-01-01', untilDate: '2026-02-01' });
  assert.equal(custom.get('range'), null);
  assert.equal(custom.get('since_date'), '2026-01-01');
  assert.equal(custom.get('until_date'), '2026-02-01');

  assert.equal(taskHistoryFromQuery(new URLSearchParams('range=bogus')).range, '');
  assert.equal(taskHistoryFromQuery(new URLSearchParams('range=bogus&since_date=2026-01-01')).range, 'custom');
  assert.equal(taskHistoryFromQuery(new URLSearchParams('range=today')).range, 'today');
});

test('page 容错：非数字 / <=1 → 1；status/source/batch_id 透传与省略', () => {
  assert.equal(taskHistoryFromQuery(new URLSearchParams('page=abc')).page, 1);
  assert.equal(taskHistoryFromQuery(new URLSearchParams('page=0')).page, 1);
  assert.equal(taskHistoryFromQuery(new URLSearchParams('page=5')).page, 5);

  const u = taskHistoryToQuery({ ...DEFAULTS, status: 'failed', source: 'bilibili', batchId: 'b-9', page: 2 });
  assert.equal(u.get('status'), 'failed');
  assert.equal(u.get('source'), 'bilibili');
  assert.equal(u.get('batch_id'), 'b-9');
  assert.equal(u.get('page'), '2');
});
