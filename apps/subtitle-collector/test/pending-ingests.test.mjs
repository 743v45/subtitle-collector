import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPendingQueue, pendingItemKey, pendingSeqOfKey, pendingKeysInOrder,
  PENDING_SEQ_KEY, PENDING_KEY_PREFIX, LEGACY_PENDING_KEY,
} from '../pending-ingests.mjs';

// 内存版 chrome.storage.local（MV3 Promise 语义）：get(string|string[]|null) / set(obj) / remove(string|string[])
function mockStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries(data);
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k); },
  };
}

test('键工具：pendingItemKey/pendingSeqOfKey 互逆，非队列键返回 null', () => {
  assert.equal(pendingItemKey(3), 'pendingIngests:3');
  assert.equal(pendingSeqOfKey('pendingIngests:3'), 3);
  assert.equal(pendingSeqOfKey('pendingIngests:0'), 0);
  // 旧版整表键（无冒号）与无关键不是队列项
  assert.equal(pendingSeqOfKey(LEGACY_PENDING_KEY), null);
  assert.equal(pendingSeqOfKey('pendingIngests:abc'), null);
  assert.equal(pendingSeqOfKey('upperAllVideos:123'), null);
});

test('enqueue：并发追加各写各的键，不互相覆盖（旧整表数组的丢数据竞态）', async () => {
  const st = mockStorage();
  const q = createPendingQueue(st);
  await Promise.all([q.enqueue({ v: 'a' }), q.enqueue({ v: 'b' }), q.enqueue({ v: 'c' })]);
  assert.deepEqual(
    [...st.data.entries()].filter(([k]) => k.startsWith(PENDING_KEY_PREFIX)).map(([, v]) => v.v).sort(),
    ['a', 'b', 'c'],
    '三条 payload 全部落盘'
  );
  assert.equal(st.data.get(PENDING_SEQ_KEY), 3, 'seq 自增到 3');
});

test('enqueue：seq 持久推进，SW 重启后（新队列实例）不撞键', async () => {
  const st = mockStorage({ [PENDING_SEQ_KEY]: 7 });
  const q = createPendingQueue(st);
  await q.enqueue({ v: 'x' });
  assert.ok(st.data.has('pendingIngests:7'), '从持久 seq 续排');
  assert.equal(st.data.get(PENDING_SEQ_KEY), 8);
});

test('flush：按入队序发送，发送成功即删自己的键', async () => {
  const st = mockStorage();
  const q = createPendingQueue(st);
  await q.enqueue('p0'); await q.enqueue('p1'); await q.enqueue('p2');
  const sent = [];
  await q.flush(async (payload) => { sent.push(payload); return true; });
  assert.deepEqual(sent, ['p0', 'p1', 'p2'], 'FIFO 按入队序补发');
  assert.equal(pendingKeysInOrder(Object.fromEntries(st.data)).length, 0, '队列清空');
});

test('flush：send 拒绝（false）即停，剩余键保留待下次补发', async () => {
  const st = mockStorage();
  const q = createPendingQueue(st);
  await q.enqueue('p0'); await q.enqueue('p1'); await q.enqueue('p2');
  await q.flush(async (payload) => payload === 'p0'); // p1 起拒发（模拟断线）
  const rest = pendingKeysInOrder(Object.fromEntries(st.data));
  assert.deepEqual(rest.map((k) => st.data.get(k)), ['p1', 'p2'], '未发项保留');
});

test('flush：send 抛错按未发处理，队列保留', async () => {
  const st = mockStorage();
  const q = createPendingQueue(st);
  await q.enqueue('p0');
  await assert.rejects(
    () => q.flush(async () => { throw new Error('InvalidStateError'); }),
    /InvalidStateError/
  );
  assert.equal(pendingKeysInOrder(Object.fromEntries(st.data)).length, 1);
});

test('flush：并发调用只跑一轮，不重发（两次 hello-ack 竞态）', async () => {
  const st = mockStorage();
  const q = createPendingQueue(st);
  await q.enqueue('p0'); await q.enqueue('p1');
  const sent = [];
  const slowSend = async (p) => { sent.push(p); return true; };
  await Promise.all([q.flush(slowSend), q.flush(slowSend)]);
  assert.deepEqual(sent, ['p0', 'p1'], '每条只发一次');
});

test('flush：flush 期间新入队的项本轮不带走（快照后入队，留下次补发）', async () => {
  const st = mockStorage();
  const q = createPendingQueue(st);
  await q.enqueue('p0');
  let afterSnapshot;
  await q.flush(async (p) => { if (p === 'p0') afterSnapshot = q.enqueue('late'); return true; });
  await afterSnapshot;
  assert.equal(st.data.get('pendingIngests:1'), 'late', '迟到的项留在队列');
});

test('flush：空队列零发送', async () => {
  const st = mockStorage();
  const q = createPendingQueue(st);
  let sends = 0;
  await q.flush(async () => { sends++; return true; });
  assert.equal(sends, 0);
});

test('clear：只删队列项与旧整表键，不动无关键；seq 不归零', async () => {
  const st = mockStorage({ clientId: 'abc123', 'upperAllVideos:42': {}, [LEGACY_PENDING_KEY]: [] });
  const q = createPendingQueue(st);
  await q.enqueue('p0');
  await q.clear();
  assert.ok(st.data.has('clientId'), '无关键保留');
  assert.ok(!st.data.has('pendingIngests:0'), '队列项删除');
  assert.equal(st.data.get(PENDING_SEQ_KEY), 1, 'seq 保持单调（防键复用覆盖）');
});

test('migrateLegacy：旧整表数组迁移为逐键队列并删旧键', async () => {
  const st = mockStorage({ [LEGACY_PENDING_KEY]: ['old0', 'old1'], clientId: 'abc123' });
  const q = createPendingQueue(st);
  await q.migrateLegacy();
  assert.deepEqual(
    pendingKeysInOrder(Object.fromEntries(st.data)).map((k) => st.data.get(k)),
    ['old0', 'old1'],
    '旧 payload 按原顺序进新队列'
  );
  assert.ok(!st.data.has(LEGACY_PENDING_KEY), '旧键删除');
  assert.ok(st.data.has('clientId'));
});

test('migrateLegacy：无旧键 / 空数组 no-op 不炸', async () => {
  const st1 = mockStorage();
  await createPendingQueue(st1).migrateLegacy();
  assert.equal(st1.data.size, 0);
  const st2 = mockStorage({ [LEGACY_PENDING_KEY]: [] });
  await createPendingQueue(st2).migrateLegacy();
  assert.ok(!st2.data.has(LEGACY_PENDING_KEY), '空数组旧键仍删除');
});
