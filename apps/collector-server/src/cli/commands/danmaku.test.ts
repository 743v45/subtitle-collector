// danmaku collect 编排测试（mock 注入,不启子进程）：段循环判停/304 哨兵/预算与上限 partial/
// 攒批冲刷/风控三档退避/dry-run/回执结构。子进程端到端见 danmaku.cli.test.ts。
// mock B 站 fetch 按路由返 Response(seg.so 返回测试专用最小 protobuf 编码器产物,本文件自含、
// 不跨测试文件 import);parseSeg 是生产实现(import bili-danmaku.js),夹具按 PLAN §2.3 字段字典构造。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 多 P 全采+段数积分 / 304 停 / --page 过滤 / segments_cap / request_budget / 批拆分 / 风控三档 / 回执结构 / dry-run / 空段转非空警示 / 匿名 cookie / extra 缺失 view 回查 | 通过 | 2026-10-07 C4;node --test --import tsx;tsc --noEmit 同轮通过 |
// | R2 | 分支补齐:parseCollectOpts·segFailStop·segPatternChanged·segGate·stopTag·selectPages 纯判定矩阵 / view·extra 解析矩阵 / fetchSeg 归一矩阵(-403/-101/http/风控头码/网络异常/空状态头/默认域) / 定位三路失败(server_error·aid_unresolved·不一致警告·--aid 单给) / count·ingest·verify 失败矩阵(3 连败硬停·稀疏响应·空批) / 编排级 -403·-101·seg_fail·parse_fail·未知字段·失败恢复·ingest 3 连败·count 失败·verify 失败·无 title | 通过 | 2026-10-07 R2;c8 全局 branches 门 ≥93% 补齐,四 danmaku 文件定向复核达标签 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCollect } from './danmaku-collect.js';
import {
  parseCollectOpts, newState, viewMetaFromData, extraPagesOf, extraAidOf, titleOf, rowsOf,
  logOf, nowOf, segInterval, stopTag, segFailStop, segPatternChanged, segGate, shouldStopSeg,
  selectPages, DanmakuError,
  type DanmakuClient, type DanmakuDeps, type DanmakuOpts, type DanmakuReceipt, type DmCtx,
} from './danmaku-run.js';
import {
  fetchSeg, fetchViewMeta, resolveByBvid, resolveByAid, resolveVideo, countOrFail,
  ingestBatch, flushBuffer, embeddedVerify, type SegFetch,
} from './danmaku-net.js';
import type { DanmakuItem } from '../bili-danmaku.js';
import { ServerUnreachableError, ServerResponseError } from '../http.js';

// ---- 测试夹具:最小 protobuf 编码器（与 bili-danmaku.test.ts 同款,本文件自含副本,禁跨文件 import）----

function encVarint(n: number | bigint): Uint8Array {
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return new Uint8Array(out);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

const tag = (fieldNo: number, wireType: number): Uint8Array => encVarint((fieldNo << 3) | wireType);
const fStr = (fieldNo: number, s: string): Uint8Array =>
  concat(tag(fieldNo, 2), encVarint(new TextEncoder().encode(s).length), new TextEncoder().encode(s));

/** 单 elem 夹具:field12 id_str(唯一键) + field7 content,够 parseSeg 产条目。 */
const elem = (id: string): Uint8Array => concat(fStr(12, id), fStr(7, `弹幕${id}`));

/** seg.so 顶层:每 elem 包为 length-delimited field1。 */
const segBody = (ids: string[]): Uint8Array => concat(...ids.map((id) => concat(tag(1, 2), encVarint(elem(id).length), elem(id))));

// ---- mock B 站 fetch 与 mock collector client ----

interface BiliRig { segCalls: string[]; viewCalls: number }

/** seg 路由:(cid,seg) → 体;null → 304 越界哨兵;空数组 → 200 空 seg。 */
type SegMap = (cid: number, seg: number) => Uint8Array | string[] | null;

function segRes(body: Uint8Array | string[] | null): Response {
  if (body === null) return new Response(null, { status: 304, headers: { 'bili-status-code': '-304' } });
  const buf = Array.isArray(body) ? segBody(body) : body;
  return new Response(buf as unknown as BodyInit, { status: 200, headers: { 'bili-status-code': '0' } });
}

function makeFetch(segMap: SegMap, over: { view?: unknown; segStatus?: number; segBili?: string } = {}) {
  const rig: BiliRig = { segCalls: [], viewCalls: 0 };
  const fetchImpl: typeof fetch = async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes('/x/v2/dm/web/seg.so')) {
      const q = new URL(u).searchParams;
      const cid = Number(q.get('oid'));
      const seg = Number(q.get('segment_index'));
      rig.segCalls.push(`${cid}#${seg}`);
      if (over.segStatus != null) {
        // segBili 缺省 '0'(无风控码):需要风控/协议码形态的用例显式传 segBili
        return new Response('blocked', { status: over.segStatus, headers: { 'bili-status-code': over.segBili ?? '0' } });
      }
      return segRes(segMap(cid, seg));
    }
    if (u.includes('/x/web-interface/view')) {
      rig.viewCalls++;
      return new Response(JSON.stringify(over.view ?? { code: -400, message: 'view 未配置' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`mock bili 未路由: ${u}`);
  };
  return { fetchImpl, rig };
}

/** 默认段表:P1(456) 两段非空(2+1 条),P2(457) seg1 一条 + seg2 空 200;其余 304。 */
const defaultSegMap: SegMap = (cid, seg) => {
  if (cid === 456) return seg === 1 ? ['a', 'b'] : seg === 2 ? ['c'] : null;
  if (cid === 457) return seg === 1 ? ['d'] : [];
  return null;
};

interface ClientRig { ingests: Array<Record<string, unknown>>; verifyCalls: number; countCalls: number }

function makeClient(over: Partial<DanmakuClient> = {}) {
  const rig: ClientRig = { ingests: [], verifyCalls: 0, countCalls: 0 };
  const videoRow: Record<string, unknown> = {
    id: 11, source: 'bilibili', source_vid: 'BV1dm0001', title: '测试视频', duration: 720,
    extra: JSON.stringify({ aid: 123, cid: 456, pages: [
      { cid: 456, page: 1, part: 'P1', duration: 720 },
      { cid: 457, page: 2, part: 'P2', duration: 400 },
    ] }),
  };
  const totalIngested = (): number => rig.ingests.reduce((s, b) => s + (Array.isArray(b.danmakus) ? b.danmakus.length : 0), 0);
  const client: DanmakuClient = {
    async getVideo() { return videoRow; },
    async danmakuCount() { rig.countCalls++; return { ok: true, rows: rig.countCalls === 1 ? 0 : totalIngested() }; },
    async danmakuIngest(body) {
      rig.ingests.push(body);
      return { ok: true, video_id: 11, inserted: Array.isArray(body.danmakus) ? body.danmakus.length : 0, updated: 0 };
    },
    async danmakuVerify() {
      rig.verifyCalls++;
      return { ok: true, bvid: 'BV1dm0001', counts: { rows: 4, pages: 2, by_page: [{ cid: 456, page: 1, rows: 3 }, { cid: 457, page: 2, rows: 1 }] },
        timeline: { min_progress_ms: 100, max_progress_ms: 900, histogram_60s: [], peak_minute: null },
        integrity: { dup_id: 0, negative_progress: 0 }, mode: { '1': 3 },
        weight: { p50: 9, p90: 9, max: 9 }, ctime: { min_s: 1_593_092_327, max_s: 1_593_092_400 } };
    },
    ...over,
  };
  return { client, rig, videoRow };
}

function makeDeps(client: DanmakuClient, fetchImpl: typeof fetch, over: Partial<DanmakuDeps> = {}) {
  const logs: string[] = [];
  const sleeps: number[] = [];
  let t = 1_000_000;
  const deps: DanmakuDeps = {
    client,
    cookie: 'SESSDATA=mock',
    biliApi: 'https://bili.test',
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    log: (m) => { logs.push(m); },
    now: () => (t += 1000),
    random: () => 0.5,
    ...over,
  };
  return { deps, logs, sleeps };
}

const opts = (over: Record<string, string | boolean> = {}): DanmakuOpts =>
  parseCollectOpts({ bvid: 'BV1dm0001', page: 'all', ...over } as Parameters<typeof parseCollectOpts>[0]);

const run = async (deps: DanmakuDeps, o: DanmakuOpts): Promise<DanmakuReceipt> =>
  await runCollect(deps, o) as DanmakuReceipt;

// ---- 用例 ----

test('多 P 全采:page=all 串行两 P,segmentsForDuration 积分(720s→2 段,400s→2 段),回执 pages 统计对账', async () => {
  const { client, rig } = makeClient();
  const { deps } = makeDeps(client, makeFetch(defaultSegMap).fetchImpl);
  const r = await run(deps, opts());
  assert.equal(r.partial, false, '全段采完非 partial');
  assert.deepEqual(r.pages.map((p) => [p.page, p.cid, p.duration_s, p.segments_expected, p.segments_fetched, p.fetched]),
    [[1, 456, 720, 2, 2, 3], [2, 457, 400, 2, 2, 1]], 'P1 两段 3 条(seg1 双条+seg2 一条) + P2 两段 1 条(seg2 空 200)');
  assert.equal(r.fetched_total, 4, 'P1 三条(seg1 双条 + seg2 一条)+ P2 一条(seg2 空 200)');
  assert.equal(r.bili_requests, 4, '两 P × 2 段,无 view(extra 齐全)');
  assert.equal(rig.ingests.length, 2, 'batchSize 默认 2000:每 P 尾批冲一次');
});

test('304 越界哨兵:整 P 全 304 → 本 P 立即断且非 partial,不浪费预算', async () => {
  const { client, rig } = makeClient();
  const { deps, logs } = makeDeps(client, makeFetch(() => null).fetchImpl);
  const r = await run(deps, opts());
  assert.equal(r.partial, false, '304 是正常终态不置 partial');
  assert.equal(r.pages.length, 0, '无成功解析段 → 无页统计');
  assert.equal(r.bili_requests, 2, '两 P 各 1 段即断(seg1 全 304)');
  assert.equal(r.fetched_total, 0);
  assert.equal(rig.verifyCalls, 1, '内嵌 verify 仍执行');
  assert.ok(logs.some((l) => l.includes('http=304') && l.includes('段越界')), '304 日志带哨兵语义');
});

test('--page 2 过滤:只采第 2 个分 P(段请求仅 cid=457)', async () => {
  const { client } = makeClient();
  const { fetchImpl, rig } = makeFetch(defaultSegMap);
  const { deps } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ page: '2' }));
  assert.equal(r.pages.length, 1);
  assert.equal(r.pages[0].page, 2);
  assert.equal(r.pages[0].fetched, 1);
  assert.ok(rig.segCalls.every((c) => c.startsWith('457#')), '段请求全部命中 P2 cid');
  assert.equal(r.bili_requests, 2);
});

test('--max-segments 1 触顶:P1 采 1 段后 partial segments_cap,后续 P 不再启动', async () => {
  const { client } = makeClient();
  const { fetchImpl, rig } = makeFetch(defaultSegMap);
  const { deps } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ maxSegments: '1' }));
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'segments_cap');
  assert.equal(r.pages.length, 1, 'P1 触顶即终止整轮');
  assert.deepEqual([r.pages[0].segments_expected, r.pages[0].segments_fetched], [2, 1], 'expected 记完整段数,fetched 记实际');
  assert.equal(rig.segCalls.length, 1);
});

test('请求预算 3:P1 采完(2 请求)+P2 采 1 段(第 3 请求)后 partial request_budget', async () => {
  const { client } = makeClient();
  const { fetchImpl, rig } = makeFetch(defaultSegMap);
  const { deps } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ maxRequests: '3' }));
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'request_budget');
  assert.equal(rig.segCalls.length, 3);
  assert.equal(r.pages.length, 2, 'P1 完整 + P2 半途都有页统计');
  assert.equal(r.pages[1].segments_fetched, 1);
});

test('batch-size 1 逐条冲刷:每条弹幕一个 ingest 批,body 带 bvid/cid/page/fetched_at/batch_id', async () => {
  const { client, rig } = makeClient();
  const { deps } = makeDeps(client, makeFetch(defaultSegMap).fetchImpl);
  await run(deps, opts({ batchSize: '1' }));
  assert.equal(rig.ingests.length, 4, 'P1 两段 3 条逐条三批 + P2 seg1 一条一批(seg2 空 0 条不冲)');
  for (const b of rig.ingests) {
    assert.equal(b.bvid, 'BV1dm0001');
    assert.ok(Array.isArray(b.danmakus) && b.danmakus.length === 1);
    assert.ok(typeof b.fetched_at === 'number' && typeof b.batch_id === 'string');
  }
  assert.equal(rig.ingests[0].cid, 456);
  assert.equal(rig.ingests[0].page, 1);
});

test('风控三档退避:seg 恒 412 → sleeps=[30s,120s,300s],4 次尝试后 partial risk_abort', async () => {
  const { client, rig } = makeClient();
  const { fetchImpl } = makeFetch(defaultSegMap, { segStatus: 412, segBili: '-412' });
  const { deps, sleeps, logs } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ page: '1' }));
  assert.deepEqual(sleeps, [30_000, 120_000, 300_000], '三档退避基数(RISK_BACKOFF_MS)');
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'risk_abort');
  assert.equal(r.bili_requests, 4, '首次 + 3 次重试');
  assert.equal(r.pages.length, 0);
  assert.ok(logs.some((l) => l.includes('risk_abort') && l.includes('seg')), '停直线带 risk_abort 与现场');
  assert.equal(rig.ingests.length, 0);
});

test('回执结构:before/after rows 哨兵、store 累计、verify 段嵌入、video 三元组', async () => {
  const { client, rig } = makeClient();
  const { deps } = makeDeps(client, makeFetch(defaultSegMap).fetchImpl);
  const r = await run(deps, opts());
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, false);
  assert.equal(r.before_rows, 0);
  assert.equal(r.after_rows, 4, '复查 count = 已入库行数(mock 按 ingest 累计)');
  assert.deepEqual(r.video, { bvid: 'BV1dm0001', aid: 123, title: '测试视频' });
  assert.deepEqual(r.store, { inserted: 4, updated: 0, requests: 2 });
  assert.deepEqual(r.stat_danmaku, { view: null }, 'extra 路径无 stat 哨兵 → null');
  assert.equal(r.bili_requests, 4);
  assert.ok(r.elapsed_ms >= 0);
  assert.ok(r.verify && r.verify.counts && (r.verify.counts as { rows: number }).rows === 4, 'verify 段透传 server 响应');
  assert.equal(rig.verifyCalls, 1);
});

test('dry-run:fetch/parse 照常,不碰 ingest/verify,store 段为 would_requests/would_rows', async () => {
  const { client, rig } = makeClient();
  const { deps, logs } = makeDeps(client, makeFetch(defaultSegMap).fetchImpl);
  const r = await run(deps, opts({ dryRun: true }));
  assert.equal(r.dry_run, true);
  assert.equal(rig.ingests.length, 0, '零写库请求');
  assert.equal(rig.verifyCalls, 0, 'dry-run 跳过内嵌 verify');
  assert.deepEqual(r.store, { would_requests: 2, would_rows: 4 });
  assert.equal(r.after_rows, 0, '复查 count 仍 0(未入库)');
  assert.ok(logs.some((l) => l.includes('[parse]') && l.includes('elems=')), '解析日志照常');
});

test('空段转非空警示:seg1 空 200 + seg2 非空 → [fetch] 变长分段疑似改版,不中断采完', async () => {
  const { client } = makeClient();
  const segMap: SegMap = (cid, seg) => (cid === 457 && seg === 1 ? [] : cid === 457 && seg === 2 ? ['x'] : null);
  const { fetchImpl } = makeFetch(segMap);
  const { deps, logs } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ page: '2' }));
  assert.equal(r.partial, false, '警示不中断');
  assert.equal(r.pages[0].fetched, 1, '空 seg1 + 非空 seg2 照常入库');
  assert.ok(logs.some((l) => l.includes('变长分段疑似改版')), '警示日志在场');
});

test('匿名采集:cookie=null 请求不带 Cookie 头,全链路无错误', async () => {
  const seen: Array<string | undefined> = [];
  const raw = makeFetch(defaultSegMap);
  const spy: typeof fetch = async (url, init) => {
    seen.push((init as { headers?: Record<string, string> })?.headers?.Cookie);
    return raw.fetchImpl(url as never, init as never);
  };
  const { client } = makeClient();
  const { deps } = makeDeps(client, spy, { cookie: null });
  const r = await run(deps, opts({ page: '1' }));
  assert.equal(r.partial, false);
  assert.equal(r.fetched_total, 3, 'P1:seg1 双条 + seg2 一条');
  assert.ok(seen.length > 0 && seen.every((c) => c === undefined), '匿名 → 无 Cookie 头');
});

test('extra 无分 P 信息 → view 回查补 aid/pages/duration(只读不回写),stat.danmaku 进回执', async () => {
  const { client, rig, videoRow } = makeClient();
  const bare = { ...videoRow, extra: JSON.stringify({ aid: 123 }) }; // 无 cid/duration → extraPages []
  client.getVideo = async () => bare;
  const view = { code: 0, data: {
    aid: 123, bvid: 'BV1dm0001', title: '回查标题', duration: 720, cid: 999,
    pages: [{ cid: 999, page: 1, part: '', duration: 720 }], stat: { danmaku: 4242 },
  } };
  const { fetchImpl, rig: bili } = makeFetch((cid, seg) => (cid === 999 && seg === 1 ? ['v1'] : null), { view });
  const { deps, logs } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ page: '1' }));
  assert.equal(bili.viewCalls, 1, 'view 回查恰好一次');
  assert.equal(r.video.aid, 123);
  assert.deepEqual(r.stat_danmaku, { view: 4242 }, 'stat.danmaku 哨兵进回执');
  assert.equal(r.pages[0].cid, 999, '段请求用回查 cid');
  assert.equal(r.pages[0].fetched, 1);
  assert.equal(r.bili_requests, 3, 'view 1 + seg 2(N=2,seg2 落 304)');
  assert.ok(logs.some((l) => l.includes('view 回查')), '回查日志在场');
  assert.equal(rig.countCalls, 2);
});

// ---- R2:分支补齐（错误/边界路径;纯判定直测 + mock 注入编排）----

test('纯判定:parseCollectOpts 非法值矩阵——负数/非整数选项与 aid 0/非整数均 ARGS,page 缺省回落 all', () => {
  const bad = (raw: Record<string, string>) => parseCollectOpts(raw as Parameters<typeof parseCollectOpts>[0]);
  assert.throws(() => bad({}), (e: DanmakuError) => e.code === 'ARGS', '双缺纯层同款 ARGS');
  assert.throws(() => bad({ bvid: 'BV1', aid: '0' }), /--aid 需正整数/, 'aid 0 非正整数');
  assert.throws(() => bad({ bvid: 'BV1', aid: '1.5' }), /--aid 需正整数/, 'aid 非整数');
  assert.throws(() => bad({ bvid: 'BV1', maxSegments: '-1' }), /--max-segments 需非负整数/, '负数选项');
  assert.throws(() => bad({ bvid: 'BV1', maxRequests: '1.5' }), /--max-requests 需非负整数/, '非整数选项');
  assert.throws(() => bad({ bvid: 'BV1', segmentIntervalMs: 'abc' }), /--segment-interval-ms 需非负整数/, '非数字选项');
  assert.throws(() => bad({ bvid: 'BV1', batchSize: '-2' }), /--batch-size 需非负整数/, '负批大小');
  const d = bad({ bvid: 'BV1' });
  assert.equal(d.page, 'all', 'page 缺省 → all');
  assert.deepEqual(
    [d.maxSegments, d.maxRequests, d.segmentIntervalMs, d.batchSize, d.dryRun],
    [0, 300, 1000, 2000, false], '其余选项缺省值');
});

test('纯判定:segFailStop 判停归一矩阵(风控/-403/-101/连击触顶/未触顶 null/字符串 biliCode 不中)', () => {
  assert.deepEqual(segFailStop('risk_abort', null, 1), { reason: 'risk_abort' }, '风控终态不问连击');
  assert.deepEqual(segFailStop('code', -403, 1), { reason: 'protocol_403' });
  assert.deepEqual(segFailStop('code', -101, 2), { reason: 'need_login' });
  assert.deepEqual(segFailStop('code', -500, 3), { reason: 'seg_fail' }, '连击触顶');
  assert.deepEqual(segFailStop('http', null, 3), { reason: 'seg_fail' }, 'http 形态失败同样计连击');
  assert.equal(segFailStop('code', -500, 2), null, '未触顶 → 继续采');
  assert.equal(segFailStop('network', null, 1), null);
  assert.equal(segFailStop('code', '-403', 0), null, 'http 头形态 bili-status-code 是字符串,=== 数值不中(文档语义)');
});

test('纯判定:segPatternChanged 四边 + segGate 三重前置门次序 + shouldStopSeg 边界', () => {
  const stat = (fetched: number, segs: number) =>
    ({ cid: 1, page: 1, duration_s: 360, segments_expected: 2, segments_fetched: segs, fetched });
  assert.equal(segPatternChanged(3, stat(0, 1)), true, '有前段且前段全空而本段非空 → 警示');
  assert.equal(segPatternChanged(0, stat(0, 1)), false, '本段也空不警示');
  assert.equal(segPatternChanged(3, undefined), false, '首段无统计不警示');
  assert.equal(segPatternChanged(3, stat(0, 0)), false, '无前段不警示');
  assert.equal(segPatternChanged(3, stat(5, 1)), false, '前段已有弹幕不警示');
  assert.deepEqual(segGate(300, 300, false, 1, 2, 0), { stop: true, reason: 'request_budget' }, '预算最先');
  assert.deepEqual(segGate(1, 300, true, 1, 2, 0), { stop: true, reason: 'stopped' }, '已硬停次之(静默断)');
  assert.deepEqual(segGate(1, 300, false, 3, 2, 0), { stop: true, reason: 'segments_done' }, '超 N 正常收口');
  assert.deepEqual(segGate(1, 300, false, 2, 2, 1), { stop: true, reason: 'segments_cap' }, '上限触顶 partial');
  assert.deepEqual(segGate(1, 300, false, 1, 2, 0), { stop: false });
  assert.deepEqual(shouldStopSeg(2, 2, 0), { stop: false }, 'seg=N 本段仍要采,不停');
  assert.deepEqual(shouldStopSeg(1, 2, 1), { stop: false }, '未触上限不停');
});

test('纯判定:stopTag 三态与 selectPages 越界空表(「无」字样)', () => {
  const st = newState();
  assert.equal(stopTag(st), ' [complete]');
  st.stopped = { reason: 'risk_abort', partial: true };
  assert.equal(stopTag(st), ' [partial:risk_abort]');
  assert.throws(() => selectPages([], 2),
    (e: DanmakuError) => e.code === 'ARGS' && /共 0 个分 P: 无/.test(e.message), '空表越界报「无」');
  assert.deepEqual(selectPages([{ cid: 1, page: 3, part: '', duration: 1 }], 3).length, 1, '命中返回单元素');
});

test('纯判定:viewMetaFromData 形态边界——缺 aid/bvid、单 P 兜底(cid+duration)、无可用分 P、title/stat 兜底、page/part 缺省补', () => {
  assert.match((viewMetaFromData({}) as { error: string }).error, /缺 aid\/bvid/);
  assert.match((viewMetaFromData({ aid: 123 }) as { error: string }).error, /缺 aid\/bvid/, '缺 bvid');
  assert.match((viewMetaFromData({ bvid: 'BV1' }) as { error: string }).error, /缺 aid\/bvid/, '缺 aid');
  assert.match((viewMetaFromData({ aid: 0, bvid: 'BV1' }) as { error: string }).error, /缺 aid\/bvid/, 'aid 0 视同缺');
  assert.match((viewMetaFromData({ aid: 123, bvid: '' }) as { error: string }).error, /缺 aid\/bvid/, '空 bvid 视同缺');
  const single = viewMetaFromData({ aid: 123, bvid: 'BV1', cid: 999, duration: 720 });
  assert.equal(single.ok, true);
  if (single.ok) {
    assert.deepEqual(single.pages, [{ cid: 999, page: 1, part: '', duration: 720 }], '无 pages → 根 cid+duration 单 P 兜底');
    assert.equal(single.title, null, 'title 非字符串 → null');
    assert.equal(single.statDanmaku, null, 'stat 缺失 → null');
  }
  assert.match((viewMetaFromData({ aid: 123, bvid: 'BV1', cid: 999, duration: 0 }) as { error: string }).error, /无可用分 P/, 'duration 0 兜底失效');
  assert.match((viewMetaFromData({ aid: 123, bvid: 'BV1' }) as { error: string }).error, /无可用分 P/, 'pages 与 cid+duration 全缺');
  const auto = viewMetaFromData({ aid: 123, bvid: 'BV1', stat: { danmaku: 'x' },
    pages: [{ cid: 1, duration: 10, part: 7, page: -1 }, { cid: 2, duration: 10, page: 2 }] });
  assert.equal(auto.ok, true);
  if (auto.ok) {
    assert.deepEqual(auto.pages.map((p) => [p.page, p.part]), [[1, ''], [2, '']], 'page 非法按序号补,part 非字符串落空');
    assert.equal(auto.statDanmaku, null, 'stat.danmaku 非数字 → null');
  }
});

test('纯判定:extraPagesOf/extraAidOf/titleOf/rowsOf 兜底矩阵(坏 JSON/非对象/缺字段/单 P 兜底)', () => {
  assert.deepEqual(extraPagesOf({ extra: '{bad json' }), [], 'extra 坏 JSON → 空');
  assert.deepEqual(extraPagesOf({ extra: null }), [], 'extra null → 空');
  assert.deepEqual(extraPagesOf({ extra: 42 }), [], 'extra 非对象 → 空');
  assert.deepEqual(extraPagesOf({ extra: '{}' }), [], '无 pages 无 cid → 空');
  assert.deepEqual(extraPagesOf({ extra: JSON.stringify({ cid: 456 }) }), [], '单 P 兜底缺 videos.duration → 空');
  assert.deepEqual(extraPagesOf({ duration: 360, extra: JSON.stringify({ cid: 456 }) }),
    [{ cid: 456, page: 1, part: '', duration: 360 }], 'extra.cid+videos.duration 单 P 兜底');
  assert.deepEqual(extraPagesOf({ extra: JSON.stringify({ pages: [{ cid: 7, duration: 5 }] }) }),
    [{ cid: 7, page: 1, part: '', duration: 5 }], 'pages 条目缺 page/part 按缺省补');
  assert.equal(extraAidOf({ extra: '{bad' }), null, '坏 JSON → null');
  assert.equal(extraAidOf({ extra: null }), null);
  assert.equal(extraAidOf({ extra: 42 }), null);
  assert.equal(extraAidOf({ extra: '{}' }), null, 'extra 无 aid → null');
  assert.equal(extraAidOf({ extra: JSON.stringify({ aid: 123 }) }), '123');
  assert.equal(titleOf({}), null, 'title 非字符串 → null');
  assert.equal(titleOf({ title: 't' }), 't');
  assert.equal(rowsOf({}), 0, 'rows 非数字 → 0');
  assert.equal(rowsOf({ rows: 5 }), 5);
});

test('依赖缺省兜底:logOf/nowOf/segInterval 未注入时走默认通路(不抛错)', async () => {
  const empty = {} as DanmakuDeps;
  assert.doesNotThrow(() => logOf(empty)('x'), 'log 缺省静默');
  assert.equal(typeof nowOf(empty)(), 'number', 'now 缺省 Date.now');
  await segInterval(empty, { segmentIntervalMs: 0 } as DanmakuOpts); // random/sleep 缺省走 Math.random/defaultSleep(0ms 立即返回)
});

/** fetchSeg 直测夹具:按 (status, bili 头, fail) 造一次性 seg 响应;约定结果必为失败归一(否则夹具抛错)。 */
async function segCase(
  over: { status?: number; bili?: string; fail?: string },
  depsOver: Partial<DanmakuDeps> = {},
): Promise<{ r: Extract<SegFetch, { ok: false }>; seen: string[]; logs: string[] }> {
  const { client } = makeClient();
  const { deps, logs } = makeDeps(client, async () => { throw new Error('unused'); }, depsOver);
  const seen: string[] = [];
  deps.fetchImpl = (async (url: unknown) => {
    seen.push(String(url));
    if (over.fail != null) throw new Error(over.fail);
    return new Response(new Uint8Array(0) as unknown as BodyInit, {
      status: over.status ?? 200,
      headers: over.bili === undefined ? {} : { 'bili-status-code': over.bili },
    });
  }) as typeof fetch;
  const r = await fetchSeg(deps, newState(), '123', 456, 1);
  if (r.ok) throw new Error(`segCase 夹具约定失败归一,实际 ok:true status=${r.status}`);
  return { r, seen, logs };
}

test('fetchSeg 归一矩阵:500 无状态头→http / 502+头码-799→风控 / -403 / -101 两种 cookie 提示 / 网络异常 / 空状态头回落 http', async () => {
  const httpCase = await segCase({ status: 500 });
  assert.equal(httpCase.r.kind, 'http', '无 bili-status-code → headNum null → http 归一');
  assert.equal(httpCase.r.biliCode, null);
  assert.ok(httpCase.logs.some((l) => l.includes('失败 http=500') && l.includes('bili_status=-')), 'http 失败日志带状态与空码占位');

  const risk = await segCase({ status: 502, bili: '-799' });
  assert.equal(risk.r.kind, 'risk_abort', '非 412 状态但头码命中风控码 → 风控归一');
  assert.equal(risk.r.biliCode, -799);
  assert.ok(risk.logs.some((l) => l.includes('bili_status=-799')), '非 412 风控日志带头码形态');

  const f403 = await segCase({ status: 403, bili: '-403' });
  assert.equal(f403.r.kind, 'code');
  assert.equal(f403.r.biliCode, -403, '-403 归一 code 携带数值码');

  const f101ck = await segCase({ status: 500, bili: '-101' });
  assert.equal(f101ck.r.kind, 'code');
  assert.ok(f101ck.logs.some((l) => l.includes('cookie 已带,疑似失效→重取')), '带 cookie 的 -101 提示');

  const f101anon = await segCase({ status: 500, bili: '-101' }, { cookie: null });
  assert.equal(f101anon.r.kind, 'code');
  assert.ok(f101anon.logs.some((l) => l.includes('未带 cookie→补 cookie 重跑')), '匿名 -101 提示');

  const net = await segCase({ fail: '连接被重置' });
  assert.equal(net.r.kind, 'network');
  assert.ok(net.logs.some((l) => l.includes('网络异常: 连接被重置')), '网络异常日志');

  const emptyHead = await segCase({ status: 500, bili: '' });
  assert.equal(emptyHead.r.kind, 'http', '空 bili-status-code 头 → 视同无码');
});

test('fetchSeg:deps.biliApi 缺省 → 回落官方 API 域(URL 断言,mock fetch 不打真网)', async () => {
  const { client } = makeClient();
  const { deps } = makeDeps(client, async () => { throw new Error('unused'); });
  delete deps.biliApi;
  const seen: string[] = [];
  deps.fetchImpl = (async (url: unknown) => {
    seen.push(String(url));
    return new Response(null, { status: 304, headers: { 'bili-status-code': '-304' } });
  }) as typeof fetch;
  const r = await fetchSeg(deps, newState(), '123', 456, 1);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.status, 304);
  assert.ok(seen[0].startsWith('https://api.bilibili.com/x/v2/dm/web/seg.so?'), '缺省回落官方域');
});

test('fetchViewMeta 直测:--aid 查询串形态 / 响应 code 非 0 失败归一 / data 形态异常 view_malformed / 预算计数', async () => {
  const { client } = makeClient();
  const { deps } = makeDeps(client, async () => { throw new Error('unused'); }, { cookie: null });
  const st = newState();
  const seen: string[] = [];
  const mk = (body: unknown): typeof fetch => (async (url: unknown) => {
    seen.push(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  deps.fetchImpl = mk({ code: 0, data: { aid: 123, bvid: 'BVaid', title: 't', pages: [{ cid: 9, page: 1, duration: 360 }] } });
  const ok = await fetchViewMeta(deps, st, { aid: 123 });
  assert.equal(ok.ok, true);
  assert.ok(seen[0].includes('aid=123') && !seen[0].includes('bvid='), '--aid 查询串形态');

  deps.fetchImpl = mk({ code: -400, message: '请求被拦截' });
  const fail = await fetchViewMeta(deps, st, { aid: 123 });
  assert.equal(fail.ok, false);
  assert.equal((fail as { code: string }).code, 'bili_-400', 'view 失败 code 经 fetchBiliJson 归一 bili_ 前缀(非风控码)');

  deps.fetchImpl = mk({ code: -412, message: '风控' });
  const risk = await fetchViewMeta(deps, st, { bvid: 'BVx' });
  assert.equal(risk.ok, false);
  assert.equal((risk as { code: string }).code, 'risk_control', '风控码经 fetchBiliJson 归一 risk_control');

  deps.fetchImpl = mk({ code: 0, data: {} });
  const malformed = await fetchViewMeta(deps, st, { bvid: 'BVx' });
  assert.equal(malformed.ok, false);
  assert.equal((malformed as { code: string }).code, 'view_malformed', 'data 缺 aid/bvid → view_malformed');
  assert.equal(st.biliRequests, 4, '每次 view 查询计入请求预算');
  assert.equal(st.reqKinds.view, 4);
});

test('定位直测:getVideoSafe 通路错误原样上抛(Unreachable/Response)/业务错误包装 server_error', async () => {
  const { client } = makeClient();
  const { deps } = makeDeps(client, async () => { throw new Error('unused'); });
  await assert.rejects(
    resolveByBvid({ ...deps, client: { ...client, getVideo: async () => { throw new ServerUnreachableError('server down'); } } }, newState(), 'BV1x'),
    (e: unknown) => e instanceof ServerUnreachableError, '通路层错误原样上抛');
  await assert.rejects(
    resolveByBvid({ ...deps, client: { ...client, getVideo: async () => { throw new ServerResponseError(500, 'boom', '/api/videos'); } } }, newState(), 'BV1x'),
    (e: unknown) => e instanceof ServerResponseError, '通路层错误原样上抛');
  await assert.rejects(
    resolveByBvid({ ...deps, client: { ...client, getVideo: async () => { throw new Error('db locked'); } } }, newState(), 'BV1x'),
    (e: Error & { code?: string }) => e.code === 'server_error' && /视频详情查询失败/.test(e.message), '业务错误包装 server_error');
});

test('定位直测:extra 无分 P + view 回查失败 → aid_unresolved;extra 有分 P 缺 aid → aid_unresolved;extra.aid 与 view 不一致 → 警告以 view 为准', async () => {
  const { client, videoRow } = makeClient();
  const { deps } = makeDeps(client, async () => { throw new Error('unused'); });
  const bare = { ...videoRow, extra: JSON.stringify({ aid: 123 }) };
  const viewFail: DanmakuDeps = { ...deps,
    client: { ...client, getVideo: async () => bare },
    fetchImpl: (async () => new Response(JSON.stringify({ code: -400, message: 'view 不可用' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch };
  await assert.rejects(resolveByBvid(viewFail, newState(), 'BV1dm0001'),
    (e: Error & { code?: string }) => e.code === 'aid_unresolved' && /view 回查失败/.test(e.message), '回查失败无法定段数');

  const pagesNoAid = { ...videoRow, extra: JSON.stringify({ pages: [{ cid: 456, page: 1, duration: 720 }] }) };
  await assert.rejects(
    resolveByBvid({ ...deps, client: { ...client, getVideo: async () => pagesNoAid } }, newState(), 'BV1dm0001'),
    (e: Error & { code?: string }) => e.code === 'aid_unresolved', '分 P 齐而 aid 缺 → 无法定位 pid');

  const viewData = { code: 0, data: { aid: 999, bvid: 'BV1dm0001', title: 'v', duration: 720, cid: 999,
    pages: [{ cid: 999, page: 1, part: '', duration: 720 }] } };
  const { fetchImpl } = makeFetch(() => null, { view: viewData });
  const { deps: d2, logs } = makeDeps({ ...client, getVideo: async () => bare }, fetchImpl);
  const m = await resolveByBvid(d2, newState(), 'BV1dm0001');
  assert.equal(m.aid, '999', '不一致以 view 为准');
  assert.ok(logs.some((l) => l.includes('extra.aid=123 与 view.aid=999 不一致')), '不一致警告日志');
});

test('定位直测:resolveByAid——view 失败 video_not_found;成功但库内无视频 → 标题回落 view+警示;resolveVideo --aid 单给 dispatch', async () => {
  const { client } = makeClient();
  const { deps } = makeDeps(client, async () => { throw new Error('unused'); });
  const viewFail = (async () => new Response(JSON.stringify({ code: -400, message: 'av 无效' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  await assert.rejects(resolveByAid({ ...deps, fetchImpl: viewFail }, newState(), 999),
    (e: Error & { code?: string }) => e.code === 'video_not_found' && /av 号无效/.test(e.message));

  const viewData = { code: 0, data: { aid: 123, bvid: 'BVaidonly', title: '新视频', duration: 360, cid: 7,
    pages: [{ cid: 7, page: 1, part: '', duration: 360 }] } };
  const { fetchImpl } = makeFetch(() => null, { view: viewData });
  const { deps: d2, logs } = makeDeps({ ...client, getVideo: async () => null }, fetchImpl);
  const v = await resolveByAid(d2, newState(), 123);
  assert.equal(v.bvid, 'BVaidonly');
  assert.equal(v.title, '新视频', '库内无视频 → 标题回落 view');
  assert.ok(logs.some((l) => l.includes('库内无此视频')), '不在库警示日志');

  const r = await resolveVideo(d2, newState(), parseCollectOpts({ aid: '123' }));
  assert.ok(r.aidSource.includes('--aid'), '--aid 单给 dispatch resolveByAid(aidSource 标记)');
});

test('countOrFail 直测:ok:false 与抛错都包装 count_failed(message 带 cause)', async () => {
  const { client } = makeClient();
  const { deps } = makeDeps(client, async () => { throw new Error('unused'); });
  const bad = { ...client, danmakuCount: async () => ({ ok: false, error: 'db down' }) };
  await assert.rejects(countOrFail({ ...deps, client: bad }, 'BV1dm0001'),
    (e: Error & { code?: string }) => e.code === 'count_failed' && /db down/.test(e.message));
  const throwing = { ...client, danmakuCount: async () => { throw new Error('conn reset'); } };
  await assert.rejects(countOrFail({ ...deps, client: throwing }, 'BV1dm0001'),
    (e: Error & { code?: string }) => e.code === 'count_failed' && /conn reset/.test(e.message));
});

test('ingestBatch 直测:空批直通不计数 / 响应缺 inserted·updated 记 0 / ok:false 与抛错计连击 / 3 连败硬停 ingest_fail', async () => {
  const { client } = makeClient();
  const { deps, logs } = makeDeps(client, async () => { throw new Error('unused'); });
  const ctx: DmCtx = { bvid: 'BV1dm0001', aid: '123', title: null, batchId: 'b0', statDanmaku: null, opts: opts() };
  const tag = { cid: 456, page: 1 };
  const items = [{ id_str: 'x' }] as unknown as DanmakuItem[];

  const st0 = newState();
  assert.equal(await ingestBatch(deps, st0, ctx, [], tag), true, '空批直通');
  assert.equal(st0.store.requests, 0, '空批不占请求/批次');

  const sparse = { ...deps, client: { ...client, danmakuIngest: async () => ({ ok: true }) } };
  const st1 = newState();
  assert.equal(await ingestBatch(sparse, st1, ctx, items, tag), true);
  assert.deepEqual(st1.store, { inserted: 0, updated: 0, requests: 1 }, '响应缺 inserted/updated 字段 → 记 0');

  const st2 = newState();
  const failing = { ...deps, client: { ...client, danmakuIngest: async () => ({ ok: false, error: '写库超时' }) } };
  for (let i = 1; i <= 3; i++) assert.equal(await ingestBatch(failing, st2, ctx, items, tag), false, `第 ${i} 批失败`);
  assert.equal(st2.ingestFailStreak, 3);
  assert.deepEqual(st2.stopped, { reason: 'ingest_fail', partial: true }, '3 连败硬停');
  assert.ok(logs.some((l) => l.includes('ingest 失败(1/3)')) && logs.some((l) => l.includes('连续 3 次 ingest 失败')));

  const st3 = newState();
  const throwing = { ...deps, client: { ...client, danmakuIngest: async () => { throw new Error('ECONNRESET'); } } };
  assert.equal(await ingestBatch(throwing, st3, ctx, items, tag), false);
  assert.equal(st3.ingestFailStreak, 1, '抛错同入连击');
  assert.ok(logs.some((l) => l.includes('ECONNRESET')));
});

test('flushBuffer:ingest_fail 硬停后保留 buffer 现场不冲(stopped 保护短路)', async () => {
  const { client } = makeClient();
  const { deps } = makeDeps(client, async () => { throw new Error('unused'); });
  const ctx: DmCtx = { bvid: 'BV1dm0001', aid: '123', title: null, batchId: 'b0', statDanmaku: null, opts: opts({ batchSize: '1' }) };
  const st = newState();
  st.stopped = { reason: 'ingest_fail', partial: true };
  st.buffer.push(...([{ id_str: 'a' }, { id_str: 'b' }] as unknown as DanmakuItem[]));
  await flushBuffer(deps, st, ctx, { cid: 456, page: 1 });
  assert.equal(st.buffer.length, 2, '硬停保护短路,现场保留');
  assert.equal(st.store.requests, 0);
});

test('embeddedVerify 直测:client 缺失防御 null / ok:false → null 不拦回执 / 稀疏响应 dash 兜底 "-"', async () => {
  const { client } = makeClient();
  const { deps, logs } = makeDeps(client, async () => { throw new Error('unused'); });
  assert.equal(await embeddedVerify({ ...deps, client: null as unknown as DanmakuClient }, 'BV1dm0001'), null, 'client 缺失防御');

  const bad = { ...deps, client: { ...client, danmakuVerify: async () => ({ ok: false, error: 'verify boom' }) } };
  assert.equal(await embeddedVerify(bad, 'BV1dm0001'), null);
  assert.ok(logs.some((l) => l.includes('[verify] 校验查询失败(不拦回执): verify boom')));

  const before = logs.length;
  const sparse = { ...deps, client: { ...client, danmakuVerify: async () => ({ ok: true }) } };
  assert.deepEqual(await embeddedVerify(sparse, 'BV1dm0001'), { ok: true });
  assert.ok(logs.slice(before).some((l) => l.includes('rows=- pages=- min_progress=-')), '稀疏响应 dash 兜底 -');
});

test('编排:seg 恒 -403 → 不退避(零 sleep)直接 partial protocol_403,预算仅 1 次', async () => {
  const { client, rig } = makeClient();
  const { fetchImpl } = makeFetch(defaultSegMap, { segStatus: 403, segBili: '-403' });
  const { deps, sleeps, logs } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ page: '1' }));
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'protocol_403');
  assert.deepEqual(sleeps, [], '-403 不退避');
  assert.equal(r.bili_requests, 1);
  assert.ok(logs.some((l) => l.includes('-403 不退避 → 终止本轮(partial protocol_403)')));
  assert.equal(rig.ingests.length, 0);
});

test('编排:seg 恒 -101 → partial need_login,带/不带 cookie 两种提示', async () => {
  const { client } = makeClient();
  const { fetchImpl } = makeFetch(defaultSegMap, { segStatus: 500, segBili: '-101' });
  const { deps, logs } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ page: '1' }));
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'need_login');
  assert.ok(logs.some((l) => l.includes('-101 需登录 → 终止本轮(partial need_login)')));
  assert.ok(logs.some((l) => l.includes('cookie 已带,疑似失效→重取')), '带 cookie 语境提示');

  const { deps: anonDeps, logs: anonLogs } = makeDeps(client, makeFetch(defaultSegMap, { segStatus: 500, segBili: '-101' }).fetchImpl, { cookie: null });
  const r2 = await run(anonDeps, opts({ page: '1' }));
  assert.equal(r2.partial_reason, 'need_login');
  assert.ok(anonLogs.some((l) => l.includes('未带 cookie→补 cookie 重跑')), '匿名语境提示');
});

test('编排:连续 3 段失败(500 无风控码) → 失败(1/3)(2/3)继续,跨 P 第 3 段触顶 partial seg_fail', async () => {
  const { client, rig } = makeClient();
  const { fetchImpl } = makeFetch(defaultSegMap, { segStatus: 500, segBili: '0' });
  const { deps, logs } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts());
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'seg_fail');
  assert.equal(r.bili_requests, 3, 'P1 两段(N=2)全败 + P2 第 1 段再败触顶');
  assert.ok(logs.some((l) => l.includes('失败(1/3)')), '未触顶失败带连击进度');
  assert.ok(logs.some((l) => l.includes('失败(2/3)')));
  assert.ok(logs.some((l) => l.includes('连续 3 段失败 → 终止本轮(partial seg_fail)')));
  assert.equal(rig.ingests.length, 0);
});

test('编排:失败连击中断后恢复——seg1 http 500 → 失败(1/3)继续,seg2 200 清零恢复,本 P 采完非 partial', async () => {
  const { client, rig } = makeClient();
  const raw = makeFetch(defaultSegMap);
  let first = true;
  const fetchImpl: typeof fetch = async (u, init) => {
    if (String(u).includes('seg.so') && first) {
      first = false;
      return new Response('err', { status: 500, headers: { 'bili-status-code': '0' } });
    }
    return raw.fetchImpl(u as never, init as never);
  };
  const { deps, logs } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ page: '1' }));
  assert.equal(r.partial, false, '单段失败不触顶 → 整轮照常完成');
  assert.equal(r.fetched_total, 1, '恢复后 seg2 一条入库');
  assert.equal(r.bili_requests, 2, '失败 1 + 恢复段 1(P1 N=2,无第 3 段)');
  assert.ok(logs.some((l) => l.includes('失败(1/3)')), '失败进度日志在场');
});

test('编排:seg 体非 protobuf → 解析失败 partial parse_fail,日志带前 32 字节 hex 现场', async () => {
  const { client, rig } = makeClient();
  const garbage = new Uint8Array([0xff, 0xff, 0xff]); // varint 续位无终止 → parseSeg 抛「varint 截断」
  const segMap: SegMap = (cid, seg) => (cid === 456 && seg === 1 ? garbage : null);
  const { fetchImpl } = makeFetch(segMap);
  const { deps, logs } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ page: '1' }));
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'parse_fail');
  assert.ok(logs.some((l) => l.includes('解析失败') && l.includes('前 32 字节') && l.includes('ffffff')), 'hex 现场日志');
  assert.equal(rig.ingests.length, 0, '解析失败无入库');
});

test('编排:seg 带白名单外字段(elem field20 varint) → [parse] 未识别字段 计数不中断', async () => {
  const { client } = makeClient();
  const elemU = (id: string): Uint8Array => concat(elem(id), concat(tag(20, 0), encVarint(7)));
  const body = concat(tag(1, 2), encVarint(elemU('u1').length), elemU('u1'));
  const segMap: SegMap = (cid, seg) => (cid === 456 && seg === 1 ? body : null);
  const { fetchImpl } = makeFetch(segMap);
  const { deps, logs } = makeDeps(client, fetchImpl);
  const r = await run(deps, opts({ page: '1' }));
  assert.equal(r.partial, false, '未知字段跳过不中断');
  assert.equal(r.fetched_total, 1, '未知字段不丢 elem');
  assert.ok(logs.some((l) => l.includes('未识别字段 {20: 1}')), '未知字段计数进 parse 日志');
});

test('编排:ingest 连续 3 批失败 → partial ingest_fail,after=before 不复查 count,verify 照常', async () => {
  const { client, rig } = makeClient();
  let ingestAttempts = 0;
  const failing = { ...client, danmakuIngest: async () => { ingestAttempts++; throw new Error('写库超时'); } };
  const { deps, logs } = makeDeps(failing, makeFetch(defaultSegMap).fetchImpl);
  const r = await run(deps, opts({ batchSize: '1' }));
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'ingest_fail');
  assert.equal(ingestAttempts, 3, '三批三败(第 3 败触顶停)');
  assert.equal(rig.countCalls, 1, 'ingest_fail 后 after=before,不复查 count');
  assert.equal(rig.verifyCalls, 1, 'verify 照常执行');
  assert.equal(r.fetched_total, 3, '已采统计照记(P1 3 条)');
  assert.ok(logs.some((l) => l.includes('连续 3 次 ingest 失败 → 终止本轮')));
});

test('编排:count 哨兵查询失败 → 抛 count_failed(RUNTIME 类),不进段循环', async () => {
  const { client } = makeClient();
  const bad = { ...client, danmakuCount: async () => ({ ok: false, error: 'db down' }) };
  const bili = makeFetch(defaultSegMap);
  const { deps } = makeDeps(bad, bili.fetchImpl);
  await assert.rejects(run(deps, opts()), (e: Error & { code?: string }) => e.code === 'count_failed');
  assert.equal(bili.rig.segCalls.length, 0, 'count 失败即中断,不进段循环');
});

test('编排:内嵌 verify 响应 ok:false → 回执 verify=null 但整体 ok 不受影响', async () => {
  const { client } = makeClient();
  const bad = { ...client, danmakuVerify: async () => ({ ok: false, error: 'verify 失败' }) };
  const { deps, logs } = makeDeps(bad, makeFetch(defaultSegMap).fetchImpl);
  const r = await run(deps, opts({ page: '1' }));
  assert.equal(r.ok, true);
  assert.equal(r.verify, null, 'verify 失败置 null 不拦回执');
  assert.ok(logs.some((l) => l.includes('校验查询失败(不拦回执)')));
});

test('编排:video 行无 title → 回执 video.title null,定位日志回落 "-"', async () => {
  const { client, rig, videoRow } = makeClient();
  client.getVideo = async () => ({ ...videoRow, title: undefined });
  const { deps, logs } = makeDeps(client, makeFetch(defaultSegMap).fetchImpl);
  const r = await run(deps, opts({ page: '1' }));
  assert.equal(r.video.title, null);
  assert.ok(logs.some((l) => l.includes('标题=-')), '标题缺省日志占位');
  assert.equal(rig.ingests.length, 1);
});
