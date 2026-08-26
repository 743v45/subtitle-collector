// asr backfill 编排测试（依赖注入 mock：圈定 client / B 站 nav/playurl/音轨 / 转写服务全 mock）。
// 圈定走 server HTTP（生产库 virtiofs 风险，读写一律经 server）——SQL 层 system 档回归在
// [advanced.test.ts](../../db/advanced.test.ts)，本文件只测编排行为。
// 覆盖：成功全链路（圈定→view→playurl→下载→转写→submit 收到 cues）
// + 失败分类（need_login / no_audio / asr_error）+ dry-run 只圈定不触网不写回。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 成功链路 + dry-run + 失败分类×3 | 通过 | sleep 全注入为立即返回（风控退避不真等） |
// | R2 | 圈定改走 client.listVideos（HTTP 化） | 通过 | 原 db 直读版本重写 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBackfill, defaultSleep, type BackfillClient, type BackfillDeps } from './asr.js';

const BILI = 'http://bili.mock';
const ASR = 'http://asr.mock';
const WBI_IMG = '7cd084941338484aae1ad9425b84077c';
const WBI_SUB = '4932caff0ff746eab6f01bf08b70ac45';

// 圈定 mock：返回固定一条 BV1（模拟 server /api/videos no-subtitle 圈定结果）
function mockClient(submitted: Array<{ vid: string; cues: unknown }>): BackfillClient {
  return {
    listVideos: async () => ({ total: 1, items: [{ source_vid: 'BV1', title: '标题BV1', duration: 60 }] }),
    asrSubmit: async (_s, vid, _e, cues) => { submitted.push({ vid, cues }); return { ok: true, inserted: 1 }; },
  };
}

// mock fetch：按路由分发；viewData/playurlData/taskResult 按需定制失败形态
function mockFetch(opts: { playurlData?: unknown; viewData?: unknown; taskResult?: unknown } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith(`${BILI}/x/web-interface/view`)) return json(opts.viewData ?? { code: 0, data: { cid: 123, duration: 6, pages: [{}] } });
    if (url.startsWith(`${BILI}/x/web-interface/nav`)) {
      return json({ code: 0, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${WBI_IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${WBI_SUB}.png` } } });
    }
    if (url.startsWith(`${BILI}/x/player/wbi/playurl`)) return json(opts.playurlData ?? { code: 0, data: { dash: { audio: [{ baseUrl: `${BILI}/audio.m4s`, id: 30280 }] } } });
    if (url === `${BILI}/audio.m4s`) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    if (url === `${ASR}/v1/tasks` && method === 'POST') return json({ task_id: 't1', status: 'queued' });
    if (url === `${ASR}/v1/tasks/t1` && method === 'GET') {
      return json(opts.taskResult ?? { status: 'done', result: '句一. 句二', segments: [{ id: 1, start: 0, end: 2.5, text: '句一' }, { id: 2, start: 2.6, end: 5, text: '句二' }] });
    }
    if (url === `${ASR}/v1/tasks/t1` && method === 'DELETE') return json({ task_id: 't1', status: 'cancelled' });
    return json({ code: -999, message: `mock 未覆盖: ${method} ${url}` }, 500);
  }) as typeof fetch;
}

function deps(client: BackfillClient, fetchImpl: typeof fetch, submitted: Array<{ vid: string; cues: unknown }>): BackfillDeps {
  return {
    client,
    biliApi: BILI, asrApi: ASR, engine: 'fireredasr-aed-l',
    fetchImpl, sleep: async () => {}, log: () => {},
  };
}

test('asr backfill：成功全链路（圈定→音轨→转写→submit 收到段级 cues）', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  const r = await runBackfill(deps(mockClient(submitted), mockFetch(), submitted), { size: 10, page: 1 });
  assert.equal(r.circled, 1);
  assert.equal(r.done, 1);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].vid, 'BV1');
  assert.deepEqual(submitted[0].cues, [
    { from: 0, to: 2.5, content: '句一' },
    { from: 2.6, to: 5, content: '句二' },
  ], 'verbose_json segments → cues 映射');
});

test('asr backfill：dry-run 只圈定不触网不写回', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  let touched = 0;
  const fetchImpl = (async () => { touched++; return new Response('{}'); }) as unknown as typeof fetch;
  const r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 10, page: 1, dryRun: true });
  assert.equal(r.dry_run, true);
  assert.equal(r.circled, 1);
  assert.equal(r.done, 0);
  assert.equal(touched, 0, 'dry-run 不发任何网络请求');
  assert.equal(submitted.length, 0);
});

test('asr backfill 失败分类：need_login / no_audio / asr_error', async () => {
  const failing: Record<string, typeof fetch> = {
    // 1. view -101（cookie 失效）
    need_login: mockFetch({ viewData: { code: -101, message: '账号未登录' } }),
    // 2. playurl 成功但无音频轨（充电加密墙特征）
    no_audio: mockFetch({ playurlData: { code: 0, data: { dash: { audio: [] } } } }),
    // 3. 转写任务 error
    asr_error: mockFetch({ taskResult: { status: 'error', error: 'boom' } }),
  };
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  for (const [code, fetchImpl] of Object.entries(failing)) {
    const r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 1, page: 1 });
    assert.equal(r.done, 0);
    const codeKey = Object.keys(r.failed)[0];
    assert.equal(codeKey, code, `失败分类应为 ${code}，实得 ${JSON.stringify(r.failed)}`);
    assert.equal(r.samples[codeKey].length, 1);
  }
  assert.equal(submitted.length, 0, '失败链路零写回');
});

test('asr backfill：音轨下载 412 → 退避重试后成功（退避序列 30s/2min）', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  const sleeps: number[] = [];
  // 前 2 次下载 412，第 3 次 200——验证退避节奏与最终成功
  let audioHits = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BILI}/audio.m4s`) {
      audioHits++;
      if (audioHits <= 2) return new Response('blocked', { status: 412 });
      return new Response(new Uint8Array([1]), { status: 200 });
    }
    return mockFetch()(input, init);
  }) as typeof fetch;
  const r = await runBackfill(
    { ...deps(mockClient(submitted), fetchImpl, submitted), sleep: async (ms) => { sleeps.push(ms); } },
    { size: 1, page: 1 },
  );
  assert.equal(r.done, 1, '两次 412 退避后第三次成功');
  assert.deepEqual(sleeps.slice(0, 2), [30_000, 120_000], '退避序列照 verify 先例 30s/2min（后续 2000 为转写轮询间隔）');
  assert.equal(submitted.length, 1);
});

test('asr backfill：下载非 412 的 HTTP 失败不重试（download_http_403）', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input) === `${BILI}/audio.m4s`) return new Response('forbidden', { status: 403 });
    return mockFetch()(input);
  }) as typeof fetch;
  const r = await runBackfill(
    { ...deps(mockClient(submitted), fetchImpl, submitted), sleep: async (ms) => { sleeps.push(ms); } },
    { size: 1, page: 1 },
  );
  assert.equal(r.done, 0);
  assert.equal(r.failed.download_http_403, 1);
  assert.deepEqual(sleeps, [], '非风控失败不退避');
});

test('asr backfill：转写提交 500 → asr_submit；轮询超时 → 取消任务（asr_timeout）', async () => {
  // 1. 提交失败
  let submitted: Array<{ vid: string; cues: unknown }> = [];
  let fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${ASR}/v1/tasks`) return new Response('{"error":"bad"}', { status: 500 });
    return mockFetch()(input);
  }) as typeof fetch;
  let r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 1, page: 1 });
  assert.equal(r.failed.asr_submit, 1);

  // 2. 轮询超时（pollDeadlineMs=0 → 首轮即超时；轮询恒 processing 撑到 deadline）→ DELETE 取消
  submitted = [];
  let deleted = false;
  fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ASR}/v1/tasks/t1` && init?.method === 'DELETE') { deleted = true; return new Response('{}'); }
    if (url === `${ASR}/v1/tasks/t1`) return new Response(JSON.stringify({ status: 'processing' })); // 永不 done
    return mockFetch()(input, init);
  }) as typeof fetch;
  r = await runBackfill({ ...deps(mockClient(submitted), fetchImpl, submitted), pollDeadlineMs: 0 }, { size: 1, page: 1 });
  assert.equal(r.failed.asr_timeout, 1);
  assert.equal(deleted, true, '超时应取消任务');
});

test('asr backfill：B 站 API 层 HTTP 412 → 三档退避后放弃（risk_control）；fetch 异常 → fetch_error', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  const sleeps: number[] = [];
  // 1. view 恒 HTTP 412：三档退避（30s/2min/5min）后放弃该视频
  let fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith(`${BILI}/x/web-interface/view`)) return new Response('{"code":-412}', { status: 412 });
    return mockFetch()(input);
  }) as typeof fetch;
  let r = await runBackfill(
    { ...deps(mockClient(submitted), fetchImpl, submitted), sleep: async (ms) => { sleeps.push(ms); } },
    { size: 1, page: 1 },
  );
  assert.equal(r.failed.risk_control, 1);
  assert.deepEqual(sleeps, [30_000, 120_000, 300_000], '三档退避照 verify 先例');

  // 2. view fetch 直接抛异常 → fetch_error（不退避）
  sleeps.length = 0;
  fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith(`${BILI}/x/web-interface/view`)) throw new Error('ECONNREFUSED');
    return mockFetch()(input);
  }) as typeof fetch;
  r = await runBackfill(
    { ...deps(mockClient(submitted), fetchImpl, submitted), sleep: async (ms) => { sleeps.push(ms); } },
    { size: 1, page: 1 },
  );
  assert.equal(r.failed.fetch_error, 1);
  assert.deepEqual(sleeps, []);
});

test('asr backfill：下载 fetch 抛异常 → download_error；三次 412 后仍 412 → risk_control 放弃', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  // 1. 下载 throw
  let fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input) === `${BILI}/audio.m4s`) throw new Error('net down');
    return mockFetch()(input);
  }) as typeof fetch;
  let r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 1, page: 1 });
  assert.equal(r.failed.download_error, 1);

  // 2. 恒 412：下载循环三档退避后 buf 仍空
  const sleeps: number[] = [];
  fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input) === `${BILI}/audio.m4s`) return new Response('blocked', { status: 412 });
    return mockFetch()(input);
  }) as typeof fetch;
  r = await runBackfill(
    { ...deps(mockClient(submitted), fetchImpl, submitted), sleep: async (ms) => { sleeps.push(ms); } },
    { size: 1, page: 1 },
  );
  assert.equal(r.failed.risk_control, 1);
  assert.deepEqual(sleeps, [30_000, 120_000, 300_000]);
});

test('asr backfill：写回抛错 → submit_error 不中断；多 P 视频仍转 P1；maxDuration 透传圈定参数', async () => {
  // 1. submit 抛错
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  const clientFail: BackfillClient = {
    listVideos: async () => ({ total: 1, items: [{ source_vid: 'BV1', title: 't', duration: 60 }] }),
    asrSubmit: async () => { throw new Error('server 500'); },
  };
  let r = await runBackfill(deps(clientFail, mockFetch(), submitted), { size: 1, page: 1 });
  assert.equal(r.failed.submit_error, 1);
  assert.equal(r.done, 0);

  // 2. 多 P（pages×2）→ 日志警告但仍转 P1 成功
  const logs: string[] = [];
  const multiP = mockFetch({ viewData: { code: 0, data: { cid: 123, duration: 6, pages: [{}, {}] } } });
  r = await runBackfill({ ...deps(mockClient(submitted), multiP, submitted), log: (m) => logs.push(m) }, { size: 1, page: 1 });
  assert.equal(r.done, 1);
  assert.ok(logs.some((m) => m.includes('多 P 视频')), '多 P 警告日志');

  // 3. maxDuration 透传到圈定参数
  const seenParams: Array<Record<string, string | number | boolean>> = [];
  const clientSpy: BackfillClient = {
    listVideos: async (p) => { seenParams.push(p); return { total: 0, items: [] }; },
    asrSubmit: async () => ({}),
  };
  r = await runBackfill(deps(clientSpy, mockFetch(), submitted), { size: 7, page: 3, maxDuration: 900 });
  assert.equal(seenParams[0].max_duration, 900);
  assert.equal(seenParams[0].size, 7);
  assert.equal(seenParams[0].page, 3);
  assert.equal(r.circled, 0);
});

test('asr backfill：转写提交 fetch 抛异常 → asr_unreachable（提示 --asr-url）', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input) === `${ASR}/v1/tasks`) throw new Error('connection refused');
    return mockFetch()(input);
  }) as typeof fetch;
  const r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 1, page: 1 });
  assert.equal(r.failed.asr_unreachable, 1);
  assert.equal(submitted.length, 0);
});

test('asr backfill：提交响应畸形体 → asr_submit；done 但零有效段 → asr_empty；超时取消的 DELETE 抛异常也不影响超时回报', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  // 1. 提交 200 但 body 非 JSON → task_id 无从取 → asr_submit
  let fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input) === `${ASR}/v1/tasks`) return new Response('<html>bad gateway</html>', { status: 200 });
    return mockFetch()(input);
  }) as typeof fetch;
  let r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 1, page: 1 });
  assert.equal(r.failed.asr_submit, 1);

  // 2. 转写 done 但 segments 全无效（空数组）→ asr_empty
  fetchImpl = mockFetch({ taskResult: { status: 'done', result: '', segments: [] } });
  r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 1, page: 1 });
  assert.equal(r.failed.asr_empty, 1);

  // 3. 超时 + DELETE 也抛（清理失败不影响超时分类）
  fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ASR}/v1/tasks/t1` && init?.method === 'DELETE') throw new Error('cleanup gone');
    if (url === `${ASR}/v1/tasks/t1`) return new Response(JSON.stringify({ status: 'processing' }));
    return mockFetch()(input, init);
  }) as typeof fetch;
  r = await runBackfill({ ...deps(mockClient(submitted), fetchImpl, submitted), pollDeadlineMs: 0 }, { size: 1, page: 1 });
  assert.equal(r.failed.asr_timeout, 1);
});

test('asr backfill：nav 失败 / nav 缺 wbi_img / playurl 业务码失败 → 分类回报；带 cookie 时请求头带 Cookie', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  // 1. nav 业务码失败（-404 类）
  let fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: -404, message: '啥都木有' }));
    return mockFetch()(input);
  }) as typeof fetch;
  let r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 1, page: 1 });
  assert.equal(r.failed['bili_-404'], 1);

  // 2. nav 200 但缺 wbi_img（风控页特征）→ no_wbi_keys
  fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: {} }));
    return mockFetch()(input);
  }) as typeof fetch;
  r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 1, page: 1 });
  assert.equal(r.failed.no_wbi_keys, 1);

  // 3. playurl 业务码失败（-404）
  fetchImpl = mockFetch({ playurlData: { code: -404, message: '啥都木有' } });
  r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 1, page: 1 });
  assert.equal(r.failed['bili_-404'], 1);

  // 4. 带 cookie：B 站请求头应含 Cookie
  const seenHeaders: Array<Record<string, string>> = [];
  fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith(BILI)) {
      seenHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
    }
    return mockFetch()(input, init);
  }) as typeof fetch;
  r = await runBackfill({ ...deps(mockClient(submitted), fetchImpl, submitted), cookie: 'SESSDATA=abc' }, { size: 1, page: 1 });
  assert.equal(r.done, 1);
  assert.ok(seenHeaders.length > 0 && seenHeaders.every((h) => h.cookie === 'SESSDATA=abc'), 'B 站请求带 Cookie 头');
});

test('asr backfill：依赖缺省走全局实现（不注入 log/biliApi/fetchImpl 拦真域名）+ item 缺 title；view 缺 cid → no_cid', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  // 1. 不注入 log / 不注入 biliApi（走 BILI_API 常量）+ item 无 title：mock fetch 按真域名前缀拦截
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.bilibili.com/')) return new Response('{}', { status: 500 });
    // 视图恒缺 cid → no_cid（顺带覆盖 106 行 error 分支）
    if (url.includes('/x/web-interface/view')) return new Response(JSON.stringify({ code: 0, data: { duration: 60, pages: [{}] } }));
    return mockFetch()(url.replace('https://api.bilibili.com', BILI), init);
  }) as typeof fetch;
  const clientNoTitle: BackfillClient = {
    listVideos: async () => ({ total: 1, items: [{}] }),
    asrSubmit: async (_s, vid, _e, cues) => { submitted.push({ vid, cues }); return { ok: true }; },
  };
  let r = await runBackfill(
    { client: clientNoTitle, asrApi: ASR, engine: 'e', fetchImpl, sleep: async () => {} },
    { size: 1, page: 1 },
  );
  assert.equal(r.failed.no_cid, 1, 'view 缺 cid 分类回报');

  // 2. 同 mock 但 view 正常（补回 cid）→ 全链路成功（覆盖缺省 log/biliApi 路径的成功侧）
  const fetchOk = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(ASR) || url.startsWith(BILI)) return mockFetch()(input, init);
    if (!url.startsWith('https://api.bilibili.com/')) return new Response('{}', { status: 500 });
    return mockFetch()(url.replace('https://api.bilibili.com', BILI), init);
  }) as typeof fetch;
  r = await runBackfill(
    { client: mockClient(submitted), asrApi: ASR, engine: 'e', fetchImpl: fetchOk, sleep: async () => {} },
    { size: 1, page: 1 },
  );
  assert.equal(r.done, 1, '缺省 biliApi（真域名）链路成功');
});

test('asr backfill：转写覆盖远小于视频时长 → truncated 拒入库（30s 试看片段防线）', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  // 2026-08-26 实测踩坑：BV1PmgF6qE4a（604s）playurl 降级给 30s 试看 durl，转写 2 段到 30s——
  // 若入库会摘标固化错误。防线：末段 to < duration × 0.5 → truncated
  const fetchImpl = mockFetch({
    viewData: { code: 0, data: { cid: 123, duration: 604, pages: [{}] } },
    taskResult: { status: 'done', segments: [{ id: 1, start: 0, end: 7.8, text: '句一' }, { id: 2, start: 7.9, end: 30, text: '句二' }] },
  });
  const r = await runBackfill(deps(mockClient(submitted), fetchImpl, submitted), { size: 1, page: 1 });
  assert.equal(r.done, 0);
  assert.equal(r.failed.truncated, 1);
  assert.equal(submitted.length, 0, 'truncated 零写回');
});

test('asr backfill dry-run：圈定项缺 duration 显示 ? 兜底', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  const clientNoDur: BackfillClient = {
    listVideos: async () => ({ total: 1, items: [{ source_vid: 'BV1', title: 't' }] }),
    asrSubmit: async () => ({}),
  };
  const logs: string[] = [];
  const r = await runBackfill({ ...deps(clientNoDur, mockFetch(), submitted), log: (m) => logs.push(m) }, { size: 1, page: 1, dryRun: true });
  assert.equal(r.dry_run, true);
  assert.ok(logs.some((m) => m.includes('时长?s')), `duration 缺省显示 ?：${logs.join(' | ')}`);
});

test('defaultSleep：真等至少指定毫秒（装配缺省路径的存在性锚点）', async () => {
  const t0 = Date.now();
  await defaultSleep(5);
  assert.ok(Date.now() - t0 >= 4);
});

test('asr backfill：轮询瞬时网络异常被吞、下轮恢复 → 成功；wbi keys 跨视频缓存（第二个视频不再调 nav）', async () => {
  const submitted: Array<{ vid: string; cues: unknown }> = [];
  const client2: BackfillClient = {
    listVideos: async () => ({ total: 2, items: [
      { source_vid: 'BV1', title: 't1', duration: 60 },
      { source_vid: 'BV9', title: 't9', duration: 60 },
    ] }),
    asrSubmit: async (_s, vid, _e, cues) => { submitted.push({ vid, cues }); return { ok: true }; },
  };
  let pollHits = 0;
  let navHits = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${BILI}/x/web-interface/nav`)) { navHits++; return mockFetch()(input); }
    // 第一个视频首次轮询抛网络异常（容错分支：吞掉下轮再试）
    if (url === `${ASR}/v1/tasks/t1`) { pollHits++; if (pollHits === 1) throw new Error('ECONNRESET'); }
    // 第二个视频的 view 换 cid（区分 URL 用）
    if (url.startsWith(`${BILI}/x/web-interface/view`)) {
      const vid = new URL(url).searchParams.get('bvid');
      return new Response(JSON.stringify({ code: 0, data: { cid: vid === 'BV9' ? 999 : 123, duration: 6, pages: [{}] } }));
    }
    return mockFetch()(input, init);
  }) as typeof fetch;
  const r = await runBackfill(deps(client2, fetchImpl, submitted), { size: 2, page: 1 });
  assert.equal(r.done, 2, '轮询异常恢复后两视频都成功');
  assert.equal(submitted.length, 2);
  assert.equal(navHits, 1, 'nav→wbi keys 只取一次（跨视频缓存）');
});
