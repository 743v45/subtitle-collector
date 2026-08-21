// apps/subtitle-collector/pending-ingests.mjs
// INGEST 离线队列：WS 断开期间暂存 payload，重连后补发（不依赖 chrome.*，storage 经参数注入便于 node:test）。
//
// 存储格式：每条一个独立键 `pendingIngests:<n>`，n 来自自增计数器（存 `pendingIngestSeq`）。
// 不再用整表数组 `pendingIngests: []`：数组式 get→append→set 在两条 INGEST 先后到达时互相
// 覆盖（get 都读到旧值，后 set 冲掉先 set），与 flush 的整表清空并发时也会清掉后写入的
// payload——队列存在的唯一目的是「断线不丢」，自身却先丢。逐键追加让每次入队只写自己的键，
// 天然免覆盖。

export const PENDING_SEQ_KEY = "pendingIngestSeq";
export const PENDING_KEY_PREFIX = "pendingIngests:";
export const LEGACY_PENDING_KEY = "pendingIngests"; // 旧版整表数组键（无冒号），启动时迁移

/** seq → 队列项键 */
export function pendingItemKey(seq) {
  return PENDING_KEY_PREFIX + seq;
}

/** 队列项键 → seq；非本队列的键返回 null */
export function pendingSeqOfKey(key) {
  if (!key.startsWith(PENDING_KEY_PREFIX)) return null;
  const n = Number(key.slice(PENDING_KEY_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 从 storage 全量快照按入队序（seq 升序）取待发键 */
export function pendingKeysInOrder(all) {
  return Object.keys(all)
    .map((key) => ({ key, seq: pendingSeqOfKey(key) }))
    .filter((e) => e.seq !== null)
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.key);
}

/**
 * 构造离线队列。storage 需满足 chrome.storage.local 的 Promise 语义：
 * get(string|string[]|null) / set(obj) / remove(string|string[])，均返回 Promise。
 * chrome.storage.local 本身可直接传入；测试传内存 mock。
 *
 * @returns {{ enqueue(payload): Promise<void>, flush(send): Promise<void>, clear(): Promise<void>, migrateLegacy(): Promise<void> }}
 *   enqueue —— 原子追加：seq 读取与写入在同一次 set 里成对提交，跨 SW 重启不撞键。
 *              同一 SW 内并发 enqueue 由内存 promise 链串行化（chrome.storage 无自增原子操作）。
 *   flush(send) —— 逐条 send、成功一条删一条；send(payload) 返回 false 或抛错即停，
 *              剩余键原样保留，下次 flush 续发（不整表清空，断线不再丢）。
 *   clear —— 删全部队列项（切 server / 切 standalone 时弃掉对旧连接的暂存）；seq 不归零，防键复用。
 *   migrateLegacy —— 旧版整表数组迁入逐键队列并删旧键，升级瞬间不丢已暂存的 payload。
 */
export function createPendingQueue(storage) {
  let enqueueChain = Promise.resolve(); // enqueue 串行链：并发调用依次拿到不同 seq
  let flushing = false;                 // flush 单飞：并发 flush（两次 hello-ack）只跑一轮，避免重发

  const enqueue = (payload) => {
    const run = enqueueChain.then(async () => {
      const { [PENDING_SEQ_KEY]: seq = 0 } = await storage.get(PENDING_SEQ_KEY);
      await storage.set({ [PENDING_SEQ_KEY]: seq + 1, [pendingItemKey(seq)]: payload });
    });
    enqueueChain = run.catch(() => {}); // 前一条失败不断链；错误仍抛给本次调用方
    return run;
  };

  const flush = async (send) => {
    if (flushing) return;
    flushing = true;
    try {
      const all = await storage.get(null);
      for (const key of pendingKeysInOrder(all)) {
        const sent = await send(all[key]); // 调用方逐条判定（连接状态）；false = 未发，立即停
        if (!sent) break;
        await storage.remove(key); // 发一条删一条：中途断线剩余保留
      }
    } finally {
      flushing = false;
    }
  };

  const clear = async () => {
    const all = await storage.get(null);
    const keys = pendingKeysInOrder(all);
    if (keys.length) await storage.remove(keys);
  };

  const migrateLegacy = async () => {
    const { [LEGACY_PENDING_KEY]: legacy } = await storage.get(LEGACY_PENDING_KEY);
    if (!Array.isArray(legacy)) return;
    for (const payload of legacy) await enqueue(payload); // 按原顺序排入，保持补发 FIFO
    await storage.remove(LEGACY_PENDING_KEY);
  };

  return { enqueue, flush, clear, migrateLegacy };
}
