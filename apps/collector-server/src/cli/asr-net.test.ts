// asr-net / asr-transcribe 组件级测试（编排层行为在 [commands/asr.test.ts](./commands/asr.test.ts)）。
// 覆盖：依赖缺省侧（?? 全局 fetch/sleep/log——globalThis.fetch 临时替换，真缺省会发真请求）；
// withRiskRetry 退避节奏；downloadAudio 非 412 不重试。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 缺省依赖路径 + 退避节奏 + 下载分类 | 通过 | 2026-08-26 复杂度拆分后补 |
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRiskRetry, fetchBiliJson, downloadAudio, biliHeaders } from './asr-net.js';
import { transcribeAt } from './asr-transcribe.js';

const BILI = 'http://bili.mock';
const ASR = 'http://asr.mock';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

test('依赖缺省侧：不注入 fetchImpl/sleep/log，走 globalThis.fetch（临时替换）与 defaultSleep', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/x/web-interface/view')) return json({ code: 0, data: { cid: 1, duration: 1, pages: [{}] } });
    if (url === `${ASR}/v1/tasks`) return json({ task_id: 't9', status: 'queued' });
    if (url === `${ASR}/v1/tasks/t9`) return json({ status: 'done', segments: [{ id: 1, start: 0, end: 1, text: 'x' }] });
    return json({ code: -999, message: 'unmocked' }, 500);
  }) as typeof fetch;
  try {
    const view = await fetchBiliJson({ cookie: 'SESSDATA=x' }, `${BILI}/x/web-interface/view?bvid=BV1`);
    assert.equal(view.ok, true, '缺省 fetch 路径的 view 成功');
    // 轮询 sleep 走 defaultSleep 真等 2s → done 返回（缺省路径完成一轮）
    const t = await transcribeAt({ asrApi: ASR }, { buf: Buffer.from([1]), filename: 'a.mp4' });
    assert.equal(t.ok, true, '缺省 sleep 路径轮询到 done');
    if (t.ok) assert.equal(Array.isArray(t.segments), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('withRiskRetry：风控退避三档后放弃；非风控一次即返', async () => {
  const sleeps: number[] = [];
  let hits = 0;
  const r = await withRiskRetry(
    { sleep: async (ms) => { sleeps.push(ms); }, log: () => {} },
    async () => { hits++; return { risk: true, ok: false as const, code: 'risk_control', message: 'x' }; },
  );
  assert.equal(hits, 4, '初次 + 三档重试');
  assert.deepEqual(sleeps, [30_000, 120_000, 300_000]);
  assert.equal(r.risk, true, '退避穷尽后仍风控，返回末次结果');

  let once = 0;
  const r2 = await withRiskRetry({ sleep: async () => {} }, async () => { once++; return { risk: false, ok: true as const }; });
  assert.equal(once, 1, '非风控不重试');
  assert.equal(r2.risk, false);
});

test('downloadAudio：非 412 HTTP 失败/网络异常直接分类不重试；412 三档退避', async () => {
  let calls = 0;
  let fetchImpl = (async () => { calls++; return new Response('denied', { status: 403 }); }) as unknown as typeof fetch;
  let r = await downloadAudio({ fetchImpl, sleep: async () => {}, log: () => {} }, 'http://x/a');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'download_http_403');
  assert.equal(calls, 1, '403 不重试');

  calls = 0;
  fetchImpl = (async () => { calls++; throw new Error('net'); }) as unknown as typeof fetch;
  r = await downloadAudio({ fetchImpl, sleep: async () => {}, log: () => {} }, 'http://x/a');
  assert.equal((r as { code: string }).code, 'download_error');
  assert.equal(calls, 1);

  calls = 0;
  fetchImpl = (async () => { calls++; return new Response('blocked', { status: 412 }); }) as unknown as typeof fetch;
  r = await downloadAudio({ fetchImpl, sleep: async () => {}, log: () => {} }, 'http://x/a');
  assert.equal((r as { code: string }).code, 'risk_control', '三档退避后仍 412');
  assert.equal(calls, 4);
});

test('biliHeaders：cookie 有无两态', () => {
  assert.equal(biliHeaders('SESSDATA=abc').Cookie, 'SESSDATA=abc');
  assert.equal('Cookie' in biliHeaders(undefined), false);
});
