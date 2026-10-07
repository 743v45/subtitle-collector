// comments collect 编排测试（依赖注入 mock：CommentsClient + fetch 路由器全 mock，圈定 §7.1 编排层清单）。
// 分层：纯判定函数直测（comments-run.ts）+ I/O 适配直测（comments-net.ts）+ 编排全链路（comments-collect.ts）
// + comments 命令装配层参数校验（进程内 captureParse，stats.test.ts 同构）。
// collect 成功全链路不在本文件：进程内真 HTTP + stdout 桩会吞 node:test 子进程协议帧（2026-10-04 实测
// 38 用例只剩尾部 4 条），端到端成功回执移 comments.cli.test.ts 子进程跑。
// 真实 B 站/server 通路不在本文件（真实验收由主会话执行，PLAN §7.1）。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 纯函数 11 组 + I/O 适配 5 组 + 编排 20 组 + 装配 5 组（共 41）| 通过 | sleep 全注入；风控退避不真等；发现并回归 cursor 透传/pins 登记/floors 闸门/buffer 空转/loadWbi 空键 五 bug |
// | R2 | +6 组（47）：定位三路 source 分支/批量抛错侧 -101 中止/楼中楼预算与页帽闸门/parseHitStats 饱和/selectRefreshRoots 逆序/logOf 缺省 | 通过 | 补齐 c8 分支覆盖盲区（2026-10-04）；全部 mock 注入无真网络 |
// | R3 | +12 组（59）：全局分支门定向补盲（定位失败三态/-403 强刷再败/count·ingest 裸形态/ingest 缺省与硬停不冲/缺省 deps 默认路由/risk_control 归一/marker 批失败不拦轮/dry-run partial/抛错侧 run_error 兜底/中途 3 连败顶停/预览根去重/装配层负整数与 bvid-file 不可读） | 通过 | c8 全局分支 92.99→94.00 越过 93 门（2026-10-04）；全部 mock 注入无真网络 |
// | R4 | renderTree reply_to 悬空兜底（悬空+parent_reply_name 快照 → 回复 @快照；与 bundle 同语义，1 组） | 通过 | 2026-10-07 媒体信息轻量增强 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollect } from './comments-collect.js';
import {
  biliCodeNum, buildReceipt, completeRoundGuard, entryRoot, isRiskCode, logOf, newRoundState, nowOf, pageInterval,
  parseHitStats, pickEntry, projectVerify, readBvidFile, selectRefreshRoots, shouldStopFloor, shouldStopMain,
  entryLike, entryRcount, entryRpid,
  type CollectDeps, type CollectOpts, type CommentsClient, type RawEntry, type RoundCtx, type RoundState,
} from './comments-run.js';
import { countOrFail, countSoft, fetchMainPage, flushBuffer, handleMainFailure, ingestBatch, loadWbi, resolveVideo, viewLookup } from './comments-net.js';
import { ServerClient } from '../http.js';
import { buildCommentsCommand, COOKIE_GUIDANCE, renderTree } from './comments.js';
import { setCliContext } from '../context.js';
import { RISK_BACKOFF_MS } from '../asr-net.js';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { upsertComments, clearAndSetPins, type CommentRecord, type CommentUpsertRow } from '../../db/comments.js';

// ── mock 基建 ──

const BILI = 'http://bili.mock';
const WBI_IMG = '7cd084941338484aae1ad9425b84077c';
const WBI_SUB = '4932caff0ff746eab6f01bf08b70ac45';

const okData = (data: unknown) => ({ code: 0, message: '0', ttl: 1, data });
const errBody = (code: number, message = '拦截') => ({ code, message });

let rpidSeq = 100;

// 根形原始条目（pickEntry 白名单键全给；rpid 固定值优先，自增兜底）
function rootEntry(o: { rpid?: number; rcount?: number; like?: number; ctime?: number } = {}): RawEntry {
  const rpid = o.rpid ?? ++rpidSeq;
  return {
    rpid, rpid_str: String(rpid), root: 0, root_str: '0', parent: 0, parent_str: '0', dialog: 0, dialog_str: '0',
    mid: 9000 + rpid, mid_str: String(9000 + rpid), member: { uname: `用户${rpid}` }, content: { message: `评论${rpid}` },
    like: o.like ?? 1, rcount: o.rcount ?? 0, count: o.rcount ?? 0,
    ctime: o.ctime ?? 1_700_000_000 + rpid, state: 0,
  };
}

// 楼形原始条目（root/parent/dialog 全指向根）
function floorEntry(root: number, o: { rpid?: number } = {}): RawEntry {
  const rpid = o.rpid ?? ++rpidSeq;
  return {
    rpid, rpid_str: String(rpid), root, root_str: String(root), parent: root, parent_str: String(root),
    dialog: root, dialog_str: String(root), mid: 9000 + rpid, mid_str: String(9000 + rpid),
    member: { uname: `楼客${rpid}` }, content: { message: `楼层${rpid}` },
    like: 0, rcount: 0, ctime: 1_700_000_500 + rpid, state: 0,
  };
}

// wbi/main data 形态（cursor 为原文形态：next_offset 嵌 pagination_reply——与真实响应同构）
function mainData(rows: RawEntry[], o: { nextOffset?: string | null; isEnd?: boolean; allCount?: number; top?: Record<string, unknown>; emptyShell?: boolean } = {}) {
  const data: Record<string, unknown> = {
    replies: o.emptyShell ? null : rows,
    cursor: { is_end: o.isEnd ?? false, all_count: o.allCount ?? rows.length, pagination_reply: { next_offset: o.nextOffset ?? null } },
    top: o.top ?? {},
    upper: { mid: 999 },
  };
  if (o.emptyShell) data.page = { num: 0, size: 0, count: 0, acount: 0 };
  return data;
}

// 楼中楼页 data（count=null → 缺 page 键，判停走空页护栏）
function floorData(root: RawEntry, floors: RawEntry[], count: number | null) {
  const data: Record<string, unknown> = { root, replies: floors, upper: { mid: 999 } };
  if (count !== null) data.page = { count };
  return data;
}

// B 站 fetch 路由器：nav / wbi/main / reply/reply / view 按 URL 分发；main 按序取页（越界复用末页，打转护栏兜底）
function makeBili(o: {
  main?: Array<Record<string, unknown>>;
  floors?: Record<string, Array<Record<string, unknown>>>;
  view?: Record<string, unknown> | null;
  navFailCode?: number;
  navNoKeys?: boolean;
} = {}) {
  const state = { nav: 0, view: 0, mainIdx: 0 };
  const mainUrls: string[] = [];
  const floorUrls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/x/web-interface/nav')) {
      state.nav++;
      if (o.navFailCode) return json(errBody(o.navFailCode));
      if (o.navNoKeys) return json(okData({ isLogin: true }));
      return json(okData({ isLogin: true, wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${WBI_IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${WBI_SUB}.png` } }));
    }
    if (url.includes('/x/v2/reply/wbi/main')) {
      mainUrls.push(url);
      const list = o.main ?? [];
      const body = list[Math.min(state.mainIdx, list.length - 1)];
      state.mainIdx++;
      return json(body);
    }
    if (url.includes('/x/v2/reply/reply')) {
      floorUrls.push(url);
      const u = new URL(url);
      const pages = o.floors?.[u.searchParams.get('root') ?? ''] ?? [];
      return json(pages[Number(u.searchParams.get('pn') ?? 1) - 1] ?? errBody(12061));
    }
    if (url.includes('/x/web-interface/view')) {
      state.view++;
      if (o.view === null) return json(errBody(-404));
      return json(okData(o.view ?? { aid: 500, bvid: 'BV1', stat: { reply: 12 } }));
    }
    return json(errBody(-999, `mock 未覆盖: ${url}`));
  }) as typeof fetch;
  return { fetchImpl, mainUrls, floorUrls, state };
}

// server 客户端 mock：getVideo/commentsCount/commentsIngest/commentsVerify；ingest 可注入连败
function makeClient(o: {
  video?: Record<string, unknown> | null | ((vid: string) => Record<string, unknown> | null);
  count?: Record<string, unknown>;
  count2?: Record<string, unknown>;
  ingestFailTimes?: number;
  verify?: Record<string, unknown> | 'fail';
} = {}) {
  const ingests: Array<Record<string, unknown>> = [];
  let countCalls = 0;
  let failsLeft = o.ingestFailTimes ?? 0;
  const defaultCount = { ok: true, rows: 0, roots: 0, max_ctime_s: null };
  // count2 缺省给 99 行——完整轮守卫的 count 复查在 mock 里天然通过（真实链路由 ingest 落库保证）
  const guardCount = { ok: true, rows: 99, roots: 99, max_ctime_s: null };
  const rig = {
    ingests,
    verifyCalls: 0,
    client: {
      getVideo: async (_s: string, vid: string) => {
        if (typeof o.video === 'function') return o.video(vid);
        if (o.video === null) return null;
        return o.video ?? { id: 1, source_vid: vid, title: '测试视频', extra: JSON.stringify({ aid: 500 }) };
      },
      commentsCount: async () => {
        countCalls++;
        if (countCalls >= 2) return o.count2 ?? guardCount;
        return o.count ?? defaultCount;
      },
      commentsIngest: async (body: Record<string, unknown>) => {
        ingests.push(body);
        if (failsLeft > 0) { failsLeft--; throw new Error('server ingest 500'); }
        const n = Array.isArray(body.replies) ? body.replies.length : 0;
        return body.full_scan === true
          ? { ok: true, inserted: n, updated: 0, missing: { candidates: 1, confirmed: 2 } }
          : { ok: true, inserted: n, updated: 0 };
      },
      commentsVerify: async () => {
        rig.verifyCalls++;
        if (o.verify === 'fail') throw new Error('verify 500');
        return o.verify ?? {
          ok: true, counts: { roots: 2, floors: 0, total: 2, pins: 0, missing_candidates: 0, missing_confirmed: 0 },
          integrity: { triple_inconsistent: 0, orphan_floor: 0, dangling_parent: 0, dangling_dialog: 0, rcount_mismatch: 0 },
          coverage: { ratio: 1 },
        };
      },
    } satisfies CommentsClient,
  };
  return rig;
}

interface DepsOpts { sleeps?: number[]; logs?: string[] }
function makeDeps(client: CommentsClient, fetchImpl: typeof fetch, o: DepsOpts = {}): CollectDeps {
  let t = 1_700_000_000_000;
  return {
    client, cookie: 'SESSDATA=abc', cookieFrom: '/tmp/cookie.txt', biliApi: BILI, fetchImpl,
    sleep: async (ms) => { o.sleeps?.push(ms); },
    log: (m) => { o.logs?.push(m); },
    now: () => (t += 1000),
    random: () => 0.5,
  };
}

const opts = (over: Partial<CollectOpts> = {}): CollectOpts => ({
  bvid: 'BV1', mode: 'auto', sort: 'time', maxPages: 0, maxFloorPages: 0, refreshRoots: 0,
  maxRequests: 600, dryRun: false, pageIntervalMs: 2000, batchSize: 200, ...over,
});

// 标准 full 轮两页（根 1/2 → 根 3+置顶 10，is_end）
const fullRoundBili = (over: Parameters<typeof makeBili>[0] = {}) => makeBili({
  main: [
    okData(mainData([rootEntry({ rpid: 1, rcount: 0 }), rootEntry({ rpid: 2, rcount: 0 })], { nextOffset: 'TOK1', allCount: 3 })),
    okData(mainData([rootEntry({ rpid: 3, rcount: 0 })], { isEnd: true, allCount: 3, top: { upper: rootEntry({ rpid: 10 }) } })),
  ],
  ...over,
});

// ── A. 纯函数层（comments-run.ts）──

test('pickEntry：白名单裁剪 + 非 object 拒绝；entry* 读数 rpid_str/root 归一', () => {
  const raw = { rpid: 1, bogus: '丢弃', content: { message: 'm' }, root_str: '77', rcount: 2 };
  const e = pickEntry(raw) as RawEntry;
  assert.equal(entryRpid(e), '1');
  assert.equal(entryRoot(e), '77');
  assert.equal(entryRcount(e), 2);
  assert.equal(entryLike(e), 0);
  assert.equal('bogus' in e, false, '白名单外键被裁');
  assert.equal(entryRoot(pickEntry({ rpid: 5 }) as RawEntry), '0', 'root 缺失归 0');
  assert.equal(pickEntry(null), null);
  assert.equal(pickEntry([1] as unknown), null);
  assert.equal(pickEntry('x' as unknown), null);
});

test('parseHitStats：字段命中计数 + 缺失样本封顶 5 个', () => {
  const good = { rpid_str: '1', member: {}, content: { message: 'x', emote: {}, picture: [{}, {}] }, ctime: 1, like: 2 };
  const noContent = { rpid_str: '2', member: {} };
  const noMember = { rpid_str: '3', content: {}, ctime: 1, like: 1 };
  const s = parseHitStats([good, noContent, noMember, ...Array.from({ length: 6 }, (_, i) => ({ rpid_str: String(10 + i) }))]);
  assert.equal(s.total, 9);
  assert.equal(s.member, 2);
  assert.equal(s.content, 2);
  assert.equal(s.emote, 1);
  assert.equal(s.pics, 2);
  assert.equal(s.missing.length, 5, '缺失样本封顶 5');
});

test('shouldStopMain：判停表全分支（空页/水位/is_end/打转/游标缺失/max-pages/继续）', () => {
  const cur = (next: string | null, isEnd = false) => ({ is_end: isEnd, all_count: 3, next_offset: next });
  // MainStop 判别联合的收窄辅助:先断言 stop 再取 reason/partial
  const stopped = (r: ReturnType<typeof shouldStopMain>): { stop: true; reason: string; partial: boolean } => {
    assert.equal(r.stop, true, '期望判停');
    return r as { stop: true; reason: string; partial: boolean };
  };
  assert.equal(stopped(shouldStopMain({ mode: 'full', cursor: cur('T'), usedOffset: null, rowCount: 1, emptyPages: 2, minCtime: null, watermark: 0, pagesDone: 1, maxPages: 0 })).reason, 'empty_pages_suspicious');
  assert.deepEqual(shouldStopMain({ mode: 'incremental', cursor: cur('T'), usedOffset: 'P', rowCount: 2, emptyPages: 0, minCtime: 100, watermark: 200, pagesDone: 1, maxPages: 0 }), { stop: true, reason: 'watermark', partial: false });
  assert.deepEqual(shouldStopMain({ mode: 'full', cursor: cur(null, true), usedOffset: 'P', rowCount: 2, emptyPages: 0, minCtime: null, watermark: 0, pagesDone: 1, maxPages: 0 }), { stop: true, reason: 'is_end', partial: false });
  assert.equal(stopped(shouldStopMain({ mode: 'full', cursor: cur('P'), usedOffset: 'P', rowCount: 2, emptyPages: 0, minCtime: null, watermark: 0, pagesDone: 2, maxPages: 0 })).reason, 'cursor_spin');
  assert.equal(stopped(shouldStopMain({ mode: 'full', cursor: null, usedOffset: 'P', rowCount: 2, emptyPages: 0, minCtime: null, watermark: 0, pagesDone: 2, maxPages: 0 })).reason, 'cursor_missing');
  assert.equal(stopped(shouldStopMain({ mode: 'full', cursor: cur(null), usedOffset: 'P', rowCount: 2, emptyPages: 0, minCtime: null, watermark: 0, pagesDone: 2, maxPages: 0 })).reason, 'cursor_missing');
  assert.equal(stopped(shouldStopMain({ mode: 'full', cursor: cur('T'), usedOffset: 'P', rowCount: 2, emptyPages: 0, minCtime: null, watermark: 0, pagesDone: 3, maxPages: 3 })).reason, 'max_pages_cap');
  assert.deepEqual(shouldStopMain({ mode: 'full', cursor: cur('T'), usedOffset: 'P', rowCount: 2, emptyPages: 0, minCtime: null, watermark: 0, pagesDone: 3, maxPages: 0 }), { stop: false, next: 'T' });
  assert.deepEqual(shouldStopMain({ mode: 'full', cursor: cur('T'), usedOffset: null, rowCount: 0, emptyPages: 1, minCtime: null, watermark: 0, pagesDone: 1, maxPages: 0 }), { stop: false, next: 'T' }, '1 空页不停(护栏要连续 2)');
});

test('shouldStopFloor：count 分母/连续空页/页数上限三判停', () => {
  assert.deepEqual(shouldStopFloor({ rowCount: 1, emptyPages: 0, got: 20, pageCount: 20, pn: 1, maxFloorPages: 0 }), { stop: true, reason: 'count_reached', partial: false });
  assert.deepEqual(shouldStopFloor({ rowCount: 0, emptyPages: 2, got: 0, pageCount: null, pn: 2, maxFloorPages: 0 }), { stop: true, reason: 'empty_pages', partial: false });
  assert.deepEqual(shouldStopFloor({ rowCount: 1, emptyPages: 0, got: 3, pageCount: null, pn: 2, maxFloorPages: 2 }), { stop: true, reason: 'floor_pages_cap', partial: true });
  assert.deepEqual(shouldStopFloor({ rowCount: 1, emptyPages: 0, got: 3, pageCount: 20, pn: 2, maxFloorPages: 0 }), { stop: false, reason: null, partial: false });
});

test('completeRoundGuard：伪完整轮判定（复查失败跳过/无外部规模不疑）', () => {
  assert.deepEqual(completeRoundGuard({ isEndReached: true, riskAbort: false, emptySuspicious: false, activeRows: 10, allCount: 10, statReply: null }), { complete: true, suspicious: false });
  assert.deepEqual(completeRoundGuard({ isEndReached: true, riskAbort: false, emptySuspicious: false, activeRows: 5, allCount: 100, statReply: null }), { complete: false, suspicious: true });
  assert.equal(completeRoundGuard({ isEndReached: true, riskAbort: false, emptySuspicious: false, activeRows: null, allCount: 100, statReply: null }).suspicious, false, '复查失败跳过伪完整判定');
  assert.equal(completeRoundGuard({ isEndReached: true, riskAbort: false, emptySuspicious: false, activeRows: 0, allCount: 0, statReply: 0 }).suspicious, false, '外部规模 0 不疑');
  assert.equal(completeRoundGuard({ isEndReached: true, riskAbort: true, emptySuspicious: false, activeRows: 10, allCount: 10, statReply: null }).complete, false, '风控中止非完整');
});

test('selectRefreshRoots：like 降序 top-N + rpid 并列稳定序', () => {
  const roots = [{ rpid: 'a', like: 5, rcount: 0 }, { rpid: 'b', like: 9, rcount: 0 }, { rpid: 'c', like: 5, rcount: 0 }];
  assert.deepEqual(selectRefreshRoots(roots, 2).map((r) => r.rpid), ['b', 'a']);
  assert.equal(selectRefreshRoots(roots, 0).length, 0);
});

test('parseHitStats：缺失样本封顶饱和后不再追加（member/ctime 两条 else-if 的假分支）', () => {
  // 6 条皆缺 member/ctime：前 3 条把 missing 顶满 5,第 4 条起 member-miss 与 ctime-miss 双双饱和
  const bad = Array.from({ length: 6 }, (_, i) => ({ rpid_str: String(50 + i), content: { message: 'x' } }));
  const s = parseHitStats(bad as unknown as RawEntry[]);
  assert.equal(s.total, 6);
  assert.equal(s.member, 0);
  assert.equal(s.content, 6);
  assert.equal(s.ctime, 0);
  assert.equal(s.missing.length, 5, '饱和后 else-if 假分支走通且封顶 5');
});

test('selectRefreshRoots：like 并列时 rpid 降序输入亦稳定升序（比较器 1 分支）', () => {
  const roots = [{ rpid: 'c', like: 5, rcount: 0 }, { rpid: 'a', like: 5, rcount: 0 }];
  assert.deepEqual(selectRefreshRoots(roots, 2).map((r) => r.rpid), ['a', 'c']);
});

test('logOf/nowOf 缺省注入：无 log/now 的 deps 不炸（noop/Date.now 兜底）', () => {
  const bare = {} as unknown as CollectDeps;
  logOf(bare)('这条日志应被丢弃');
  assert.equal(typeof nowOf(bare)(), 'number');
});

test('biliCodeNum/isRiskCode：错误码形态归类', () => {
  assert.equal(biliCodeNum('bili_12002'), 12002);
  assert.equal(biliCodeNum('bili_-403'), -403);
  assert.equal(biliCodeNum('need_login'), null);
  for (const c of ['risk_control', 'bili_-412', 'bili_-352', 'bili_-799', 'bili_-509']) assert.equal(isRiskCode(c), true, c);
  for (const c of ['bili_-403', 'need_login', 'bili_12002']) assert.equal(isRiskCode(c), false, c);
});

test('readBvidFile：注释/空行过滤 + 空文件与不可读 ARGS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-test-'));
  try {
    const p = join(dir, 'bvids.txt');
    writeFileSync(p, '# 注释\nBV1\n\n  BV2  \n', 'utf-8');
    assert.deepEqual(readBvidFile(p), ['BV1', 'BV2']);
    writeFileSync(p, '# 只有注释\n\n', 'utf-8');
    assert.throws(() => readBvidFile(p), (e: unknown) => (e as { code?: string }).code === 'ARGS');
    assert.throws(() => readBvidFile(join(dir, 'nope.txt')), (e: unknown) => (e as { code?: string }).code === 'ARGS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildReceipt：total=根+楼、partial_reason/comments_disabled、dry-run store 段', () => {
  const st: RoundState = newRoundState();
  st.fetched.roots = 2; st.fetched.floors = 3; st.fetched.pins = 1;
  st.store.inserted = 5; st.store.updated = 1; st.store.requests = 4;
  st.stopped = { reason: 'cursor_missing', partial: true };
  st.commentsDisabled = true;
  const ctx: RoundCtx = { bvid: 'BV1', aid: '500', title: null, mode: 'full', sort: 'time', watermark: 0, scanStart: 1, batchId: 'b', opts: opts() };
  const r = buildReceipt(st, ctx, 1500, null, null);
  assert.equal(r.fetched.total, 5);
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'cursor_missing');
  assert.equal(r.comments_disabled, true);
  assert.deepEqual(r.store, { inserted: 5, updated: 1, requests: 4 });
  const dry = newRoundState();
  dry.dryRun = true; dry.dryRows = 7; dry.store.requests = 2;
  assert.deepEqual(buildReceipt(dry, ctx, 0, null, null).store, { would_requests: 2, rows: 7 });
});

test('projectVerify：verify 响应投影四字段 + 缺键落 null', () => {
  assert.deepEqual(projectVerify({ integrity: { rcount_mismatch: 1, orphan_floor: 2, dangling_parent: 3 }, coverage: { ratio: 0.9 } }), { coverage: 0.9, rcount_mismatch: 1, orphan_floor: 2, dangling_parent: 3 });
  assert.deepEqual(projectVerify({}), { coverage: null, rcount_mismatch: null, orphan_floor: null, dangling_parent: null });
});

test('pageInterval：基数 ±30% 抖动（random 0/0.5/1 → 1400/2000/2600）', async () => {
  for (const [r, want] of [[0, 1400], [0.5, 2000], [1, 2600]] as const) {
    const sleeps: number[] = [];
    const deps: CollectDeps = { ...makeDeps(makeClient().client, makeBili().fetchImpl, { sleeps }), random: () => r };
    await pageInterval(deps, opts());
    assert.deepEqual(sleeps, [want]);
  }
});

// ── B. I/O 适配层直测（comments-net.ts）──

test('loadWbi：-101 指引 / 缺 wbi_img / 缓存短路 / force 强刷', async () => {
  const rig = makeClient();
  const st = newRoundState();
  const box = { keys: null };
  const fail = await loadWbi(makeDeps(rig.client, makeBili({ navFailCode: -101 }).fetchImpl, { logs: [] }), st, box, false);
  assert.equal(fail.ok, false);
  assert.match((fail as { message: string }).message, /重取/);
  const noKeys = await loadWbi(makeDeps(rig.client, makeBili({ navNoKeys: true }).fetchImpl), newRoundState(), { keys: null }, false);
  assert.equal((noKeys as { code?: string }).code, 'no_wbi_keys');
  const ok = await loadWbi(makeDeps(rig.client, makeBili().fetchImpl), st, box, false);
  assert.equal(ok.ok, true);
  assert.ok(box.keys);
  st.biliRequests = 0; st.reqKinds = { nav: 0, view: 0, main: 0, floor: 0 };
  await loadWbi(makeDeps(rig.client, makeBili().fetchImpl), st, box, false);
  assert.equal(st.reqKinds.nav, 0, 'box 已有 keys 不发 nav');
  await loadWbi(makeDeps(rig.client, makeBili().fetchImpl), st, box, true);
  assert.equal(st.reqKinds.nav, 1, 'force 强刷发 nav');
});

test('viewLookup：缺 aid/bvid 形态异常 → view_no_aid；stat.reply 捕获', async () => {
  const rig = makeClient();
  const st = newRoundState();
  const bad = await viewLookup(makeDeps(rig.client, makeBili({ view: { foo: 1 } }).fetchImpl), st, { bvid: 'BV1' });
  assert.equal((bad as { code?: string }).code, 'view_no_aid');
  const ok = await viewLookup(makeDeps(rig.client, makeBili({ view: { aid: 500, bvid: 'BV1', stat: { reply: 7 } } }).fetchImpl), st, { bvid: 'BV1' });
  assert.deepEqual(ok, { ok: true, bvid: 'BV1', aid: '500', statReply: 7 });
  assert.equal(st.statReply, 7);
});

test('countSoft/countOrFail：软查询失败落 null，硬查询失败抛 count_failed', async () => {
  const throwing: CommentsClient = {
    getVideo: async () => null, commentsCount: async () => { throw new Error('down'); },
    commentsIngest: async () => ({}), commentsVerify: async () => ({}),
  };
  assert.equal(await countSoft(makeDeps(throwing, makeBili().fetchImpl), 'BV1'), null);
  await assert.rejects(countOrFail(makeDeps(throwing, makeBili().fetchImpl), 'BV1'), (e: unknown) => (e as { code?: string }).code === 'count_failed');
});

test('resolveVideo：getVideo 抛错包装 server_error；fetchMainPage 无 keys 短路', async () => {
  const broken: CommentsClient = {
    getVideo: async () => { throw new Error('boom'); }, commentsCount: async () => ({}),
    commentsIngest: async () => ({}), commentsVerify: async () => ({}),
  };
  await assert.rejects(resolveVideo(makeDeps(broken, makeBili().fetchImpl), newRoundState(), opts()), (e: unknown) => (e as { code?: string }).code === 'server_error');
  const noKeys = await fetchMainPage(makeDeps(makeClient().client, makeBili().fetchImpl), newRoundState(), { keys: null }, '500', '', 2);
  assert.equal((noKeys as { code?: string }).code, 'no_wbi_keys');
});

test('handleMainFailure：非风控/登录/关闭码 → stopped 如实失败', () => {
  const st = newRoundState();
  handleMainFailure(makeDeps(makeClient().client, makeBili().fetchImpl), st, { ok: false, code: 'bili_-404', message: 'none' }, 1);
  assert.deepEqual(st.stopped, { reason: 'bili_-404', partial: true });
  assert.equal(st.riskAbort, false);
});

// ── C. 编排全链路（模式判定 / 主列表判停 / 完整轮守卫 / 楼中楼 / 批量 / dry-run）──

test('模式判定：auto rows=0 → full；rows>0 → incremental（水位停，无 full_scan 标记）', async () => {
  const bili = fullRoundBili();
  const c1 = makeClient();
  const d1 = makeDeps(c1.client, bili.fetchImpl);
  const r1 = await runCollect(d1, opts()) as { mode: string; partial: boolean };
  assert.equal(r1.mode, 'full');
  assert.equal(r1.partial, false);

  const bili2 = makeBili({ main: [okData(mainData([rootEntry({ rpid: 21, ctime: 1_700_000_003 }), rootEntry({ rpid: 22, ctime: 1_700_000_001 })], { nextOffset: 'T1', allCount: 99 }))] });
  const c2 = makeClient({ count: { ok: true, rows: 5, roots: 5, max_ctime_s: 1_700_000_005 } });
  const r2 = await runCollect(makeDeps(c2.client, bili2.fetchImpl), opts()) as { mode: string; partial: boolean; partial_reason?: string };
  assert.equal(r2.mode, 'incremental');
  assert.equal(r2.partial, false, '水位停是正常终态');
  assert.equal(r2.partial_reason, undefined);
  const marker = c2.ingests.find((b) => b.full_scan === true);
  assert.equal(marker, undefined, '增量轮不发 full_scan 标记批');
});

test('incremental 但库内 0 行 → 降级 full（日志留痕）；incremental+hot → 降级 time', async () => {
  const logs: string[] = [];
  const bili = fullRoundBili();
  const c = makeClient();
  const r = await runCollect(makeDeps(c.client, bili.fetchImpl, { logs }), opts({ mode: 'incremental' })) as { mode: string; sort: string };
  assert.equal(r.mode, 'full');
  assert.ok(logs.some((l) => l.includes('降级 full')));

  const logs2: string[] = [];
  const bili2 = makeBili({ main: [okData(mainData([rootEntry({ rpid: 31, ctime: 5 })], { isEnd: true, allCount: 1 }))] });
  const c2 = makeClient({ count: { ok: true, rows: 2, roots: 2, max_ctime_s: 99 } });
  const r2 = await runCollect(makeDeps(c2.client, bili2.fetchImpl, { logs: logs2 }), opts({ mode: 'incremental', sort: 'hot' })) as { mode: string; sort: string };
  assert.equal(r2.sort, 'time', '增量轮 hot 无意义降级 time');
  assert.ok(bili2.mainUrls.every((u) => !u.includes('mode=3')), '无 hot 快照页');
});

test('定位：--aid 单给走 view?aid= 回查；extra.aid 缺失走 view?bvid= 回查；--aid 不一致 → aid_mismatch', async () => {
  const bili = fullRoundBili();
  const c = makeClient();
  const logs: string[] = [];
  const r = await runCollect(makeDeps(c.client, bili.fetchImpl, { logs }), opts({ bvid: undefined, aid: '500' })) as { video: { aid: string }; stat_reply: { view: number | null }; bili_requests: number };
  assert.equal(r.video.aid, '500');
  assert.equal(r.stat_reply.view, 12, 'view stat.reply 外部哨兵进回执');
  assert.equal(bili.state.view, 1);
  assert.ok(logs.some((l) => l.includes('view 回查(--aid)')));

  const c2 = makeClient({ video: { id: 1, source_vid: 'BV1', title: 't' } });
  const r2 = await runCollect(makeDeps(c2.client, makeBili().fetchImpl), opts()) as { video: { aid: string } };
  assert.equal(r2.video.aid, '500', 'extra.aid 缺失 → view 回查');

  const c3 = makeClient();
  await assert.rejects(runCollect(makeDeps(c3.client, makeBili().fetchImpl), opts({ aid: '999' })), (e: unknown) => (e as { code?: string }).code === 'aid_mismatch');

  // aid 交叉校验第二分支：extra.aid 缺失 → view?bvid= 回查 aid 与 --aid 不一致 → aid_mismatch
  const c4 = makeClient({ video: { id: 1, source_vid: 'BV1', title: 't' } });
  await assert.rejects(runCollect(makeDeps(c4.client, makeBili().fetchImpl), opts({ aid: '999' })), (e: unknown) => (e as { code?: string }).code === 'aid_mismatch');

  // bvid+aid 同给且与 extra.aid 一致 → 不发 view,aidSource=extra.aid（source 日志留痕）
  const c5 = makeClient();
  const logs5: string[] = [];
  const r5 = await runCollect(makeDeps(c5.client, fullRoundBili().fetchImpl, { logs: logs5 }), opts({ aid: '500' })) as { video: { aid: string } };
  assert.equal(r5.video.aid, '500');
  assert.ok(logs5.some((l) => l.includes('来源=extra.aid')));

  // bvid+aid 同给但 extra.aid 缺失 → view?bvid= 回查一致 → aidSource=view 回查
  const c6 = makeClient({ video: { id: 1, source_vid: 'BV1', title: 't' } });
  const logs6: string[] = [];
  const r6 = await runCollect(makeDeps(c6.client, fullRoundBili().fetchImpl, { logs: logs6 }), opts({ aid: '500' })) as { video: { aid: string } };
  assert.equal(r6.video.aid, '500');
  assert.ok(logs6.some((l) => l.includes('来源=view 回查')), 'view 回查一致分支');

  // bvid+aid 同给、extra.aid 缺失且 view 失败 → --aid 直给继续（交叉校验跳过留日志）
  const c7 = makeClient({ video: { id: 1, source_vid: 'BV1', title: 't' } });
  const logs7: string[] = [];
  const r7 = await runCollect(makeDeps(c7.client, fullRoundBili({ view: null }).fetchImpl, { logs: logs7 }), opts({ aid: '500' })) as { video: { aid: string } };
  assert.equal(r7.video.aid, '500');
  assert.ok(logs7.some((l) => l.includes('--aid 交叉校验跳过')));
  assert.ok(logs7.some((l) => l.includes('来源=--aid 直给')));
});

test('full 完整轮：游标包裹 {"offset":原文} 透传 + is_end 标记批(full_scan/scan_start/pins) + missing 进回执', async () => {
  const bili = fullRoundBili();
  const c = makeClient();
  const logs: string[] = [];
  const r = await runCollect(makeDeps(c.client, bili.fetchImpl, { logs }), opts()) as {
    partial: boolean; fetched: { roots: number; floors: number; pins: number; total: number }; bili_requests: number;
    pages: { main: number }; missing: { candidates: number; confirmed: number } | null; verify: Record<string, unknown> | null;
    store: { inserted: number };
  };
  assert.equal(bili.mainUrls.length, 2);
  assert.equal(new URL(bili.mainUrls[0]).searchParams.get('pagination_str'), '', '首页空 pagination');
  assert.equal(new URL(bili.mainUrls[1]).searchParams.get('pagination_str'), JSON.stringify({ offset: 'TOK1' }), '游标黑盒包裹透传');
  assert.equal(r.partial, false);
  assert.equal(r.fetched.roots, 4, '根 1/2/3 + 置顶 10 计入根');
  assert.equal(r.fetched.total, 4);
  assert.equal(r.bili_requests, 3, 'nav 1 + main 2');
  assert.equal(r.pages.main, 2);
  assert.equal(c.ingests.length, 2, '尾批 + full_scan 标记批');
  assert.equal(c.ingests[0].full_scan, false, '前置批不带标记');
  const marker = c.ingests[1];
  assert.equal(marker.full_scan, true);
  assert.equal(typeof marker.scan_start, 'number');
  assert.deepEqual(marker.pins, [{ rpid_str: '10', kind: 'upper' }], '置顶清单随标记批先清后打');
  assert.equal(marker.upper_mid, '999', 'upper_mid 透传');
  assert.deepEqual(r.missing, { candidates: 1, confirmed: 2 }, 'missing 对账结果进回执');
  assert.deepEqual(r.verify, { coverage: 1, rcount_mismatch: 0, orphan_floor: 0, dangling_parent: 0 });
  assert.ok(logs.some((l) => l.includes('[verify]')));
  assert.ok(logs.some((l) => l.includes('[floor] skip root=') && l.includes('rcount=0')), 'rcount=0 根 skip 日志');
});

test('判停：next_offset 缺失 partial cursor_missing / max-pages 触顶 / 预算耗尽 / 游标打转', async () => {
  const bili1 = makeBili({ main: [okData(mainData([rootEntry({ rpid: 41 })], { nextOffset: null, allCount: 99 }))] });
  const r1 = await runCollect(makeDeps(makeClient().client, bili1.fetchImpl), opts()) as { partial_reason?: string };
  assert.equal(r1.partial_reason, 'cursor_missing');

  const bili2 = makeBili({ main: [okData(mainData([rootEntry({ rpid: 42 })], { nextOffset: 'T1', allCount: 99 }))] });
  const r2 = await runCollect(makeDeps(makeClient().client, bili2.fetchImpl), opts({ maxPages: 1 })) as { partial_reason?: string };
  assert.equal(r2.partial_reason, 'max_pages_cap');

  const bili3 = makeBili({ main: [okData(mainData([rootEntry({ rpid: 43 })], { nextOffset: 'T1' }))] });
  const r3 = await runCollect(makeDeps(makeClient().client, bili3.fetchImpl), opts({ maxRequests: 2 })) as { partial_reason?: string; pages: { main: number } };
  assert.equal(r3.partial_reason, 'request_budget');
  assert.equal(r3.pages.main, 1);

  const bili4 = makeBili({ main: [okData(mainData([rootEntry({ rpid: 44 })], { nextOffset: 'T1' })), okData(mainData([rootEntry({ rpid: 45 })], { nextOffset: 'T1' }))] });
  const r4 = await runCollect(makeDeps(makeClient().client, bili4.fetchImpl), opts()) as { partial_reason?: string };
  assert.equal(r4.partial_reason, 'cursor_spin', 'next_offset 与上页相同 → 打转护栏');
});

test('判停：连续 2 空页（full 空壳形态带 [parse] 日志 / incremental 同停）', async () => {
  const logs: string[] = [];
  const bili1 = makeBili({ main: [okData(mainData([], { nextOffset: 'T1', emptyShell: true })), okData(mainData([], { nextOffset: 'T2', emptyShell: true }))] });
  const r1 = await runCollect(makeDeps(makeClient().client, bili1.fetchImpl, { logs }), opts()) as { partial_reason?: string };
  assert.equal(r1.partial_reason, 'empty_pages_suspicious');
  assert.ok(logs.some((l) => l.includes('空壳形态')), '空壳形态 replyDiag 日志');

  const bili2 = makeBili({ main: [okData(mainData([], { nextOffset: 'T1' })), okData(mainData([], { nextOffset: 'T2' }))] });
  const c2 = makeClient({ count: { ok: true, rows: 5, roots: 5, max_ctime_s: 9_999_999_999 } });
  const r2 = await runCollect(makeDeps(c2.client, bili2.fetchImpl), opts()) as { partial_reason?: string };
  assert.equal(r2.partial_reason, 'empty_pages_suspicious');
});

test('风控三档退避：-352 → 30s/120s/300s 后 partial；-403 → 强刷 wbi keys 重试成功', async () => {
  const sleeps: number[] = [];
  const bili1 = makeBili({ main: [errBody(-352)] });
  const r1 = await runCollect(makeDeps(makeClient().client, bili1.fetchImpl, { sleeps }), opts()) as { partial_reason?: string };
  assert.deepEqual(sleeps, RISK_BACKOFF_MS, '三档退避 30s/120s/300s');
  assert.equal(r1.partial_reason, 'bili_-352');

  const bili2 = makeBili({ main: [errBody(-403), okData(mainData([rootEntry({ rpid: 46 })], { isEnd: true, allCount: 1 }))] });
  const c2 = makeClient();
  const r2 = await runCollect(makeDeps(c2.client, bili2.fetchImpl, { sleeps: [] }), opts()) as { partial: boolean };
  assert.equal(bili2.state.nav, 2, '首登 + -403 强刷共 2 次 nav');
  assert.equal(bili2.mainUrls.length, 2, '失败一次 + 重试一次');
  assert.equal(r2.partial, false, '重试成功 → 完整轮');
});

test('终态：12002 comments_disabled 正常收尾；-101 need_login partial 带重取指引', async () => {
  const bili1 = makeBili({ main: [errBody(12002)] });
  const r1 = await runCollect(makeDeps(makeClient().client, bili1.fetchImpl), opts()) as { partial: boolean; comments_disabled?: boolean };
  assert.equal(r1.partial, false);
  assert.equal(r1.comments_disabled, true);

  const logs: string[] = [];
  const bili2 = makeBili({ main: [errBody(-101)] });
  const r2 = await runCollect(makeDeps(makeClient().client, bili2.fetchImpl, { logs }), opts()) as { partial: boolean; partial_reason?: string };
  assert.equal(r2.partial, true);
  assert.equal(r2.partial_reason, 'need_login');
  assert.ok(logs.some((l) => l.includes('重取') && l.includes('bili-cookie-from-chrome')));
});

test('hot 快照：full+hot 首发 mode=3 快照页随批入库；快照页失败降级继续时间序', async () => {
  const bili1 = makeBili({
    main: [
      okData(mainData([rootEntry({ rpid: 51, like: 99 })], { nextOffset: 'TH', allCount: 2 })),
      okData(mainData([rootEntry({ rpid: 52 })], { isEnd: true, allCount: 2 })),
    ],
  });
  const c1 = makeClient();
  const r1 = await runCollect(makeDeps(c1.client, bili1.fetchImpl), opts({ mode: 'full', sort: 'hot' })) as { fetched: { roots: number }; partial: boolean };
  assert.ok(bili1.mainUrls[0].includes('mode=3'), '快照页 mode=3');
  assert.ok(bili1.mainUrls[1].includes('mode=2'), '主遍历 mode=2');
  assert.equal(r1.fetched.roots, 2);
  assert.equal(r1.partial, false);

  const logs: string[] = [];
  const bili2 = makeBili({
    main: [errBody(-404), okData(mainData([rootEntry({ rpid: 53 })], { isEnd: true, allCount: 1 }))],
  });
  const r2 = await runCollect(makeDeps(makeClient().client, bili2.fetchImpl, { logs }), opts({ mode: 'full', sort: 'hot' })) as { partial: boolean };
  assert.ok(logs.some((l) => l.includes('快照页失败') && l.includes('降级')));
  assert.equal(r2.partial, false, '快照失败不拦整轮');
});

test('v_voucher 风控凭证：如实报告日志，不自动化', async () => {
  const logs: string[] = [];
  const page = mainData([rootEntry({ rpid: 61 })], { isEnd: true, allCount: 1 });
  page.v_voucher = '凭证';
  const bili = makeBili({ main: [okData(page)] });
  const r = await runCollect(makeDeps(makeClient().client, bili.fetchImpl, { logs }), opts()) as { partial: boolean };
  assert.ok(logs.some((l) => l.includes('v_voucher')));
  assert.equal(r.partial, false);
});

test('楼中楼：page.count 实时分母翻全 count_reached + 楼条目入库 + data.root 刷新不重复计根', async () => {
  const root = rootEntry({ rpid: 1, rcount: 2 });
  const bili = makeBili({
    main: [okData(mainData([root], { isEnd: true, allCount: 1 }))],
    floors: { 1: [okData(floorData(root, [floorEntry(1, { rpid: 901 })], 2)), okData(floorData(root, [floorEntry(1, { rpid: 902 })], 2))] },
  });
  const c = makeClient();
  const logs: string[] = [];
  const r = await runCollect(makeDeps(c.client, bili.fetchImpl, { logs }), opts()) as { fetched: { roots: number; floors: number; total: number }; partial: boolean };
  assert.equal(bili.floorUrls.length, 2);
  assert.equal(new URL(bili.floorUrls[0]).searchParams.get('pn'), '1');
  assert.equal(new URL(bili.floorUrls[1]).searchParams.get('ps'), '20', '楼中楼固定 ps=20 无 wbi');
  assert.equal(r.fetched.roots, 1, 'data.root 内嵌根行不重复计根');
  assert.equal(r.fetched.floors, 2);
  assert.equal(r.fetched.total, 3);
  assert.equal(r.partial, false);
  const floorBody = c.ingests.flatMap((b) => b.replies as RawEntry[]).find((e) => entryRoot(e) === '1');
  assert.ok(floorBody, '楼条目随批入库');
  assert.ok(logs.some((l) => l.includes('[floor] root=1 rcount=2')));
});

test('楼中楼判停：count 缺失连续 2 空页；12002/12061 按无楼终态', async () => {
  const root = rootEntry({ rpid: 1, rcount: 2 });
  const bili1 = makeBili({
    main: [okData(mainData([root], { isEnd: true, allCount: 1 }))],
    floors: { 1: [okData(floorData(root, [], null)), okData(floorData(root, [], null))] },
  });
  const c1 = makeClient();
  const r1 = await runCollect(makeDeps(c1.client, bili1.fetchImpl), opts()) as { partial: boolean; fetched: { floors: number } };
  assert.equal(bili1.floorUrls.length, 2, 'count 缺失走 2 空页护栏');
  assert.equal(r1.partial, false);
  assert.equal(r1.fetched.floors, 0);

  for (const code of [12002, 12061]) {
    const bili = makeBili({
      main: [okData(mainData([rootEntry({ rpid: 2, rcount: 5 })], { isEnd: true, allCount: 1 }))],
      floors: { 2: [errBody(code)] },
    });
    const r = await runCollect(makeDeps(makeClient().client, bili.fetchImpl), opts()) as { partial: boolean };
    assert.equal(bili.floorUrls.length, 1);
    assert.equal(r.partial, false, `code=${code} 无楼终态不拦轮`);
  }
});

test('楼中楼预算闸门：nav+main 耗尽预算 → 进入翻楼前 request_budget partial（floor 零请求）', async () => {
  const bili = makeBili({ main: [okData(mainData([rootEntry({ rpid: 3, rcount: 9 })], { isEnd: true, allCount: 1 }))] });
  const r = await runCollect(makeDeps(makeClient().client, bili.fetchImpl), opts({ maxRequests: 2 })) as { partial_reason?: string; fetched: { floors: number } };
  assert.equal(r.partial_reason, 'request_budget', 'nav 1 + main 1 恰好用尽 2 请求预算');
  assert.equal(bili.floorUrls.length, 0, '翻楼未发出任何请求');
  assert.equal(r.fetched.floors, 0);
});

test('楼中楼页数上限：--max-floor-pages 触顶 → floor_pages_cap partial（不多发下一页）', async () => {
  const root = rootEntry({ rpid: 4, rcount: 99 });
  const bili = makeBili({
    main: [okData(mainData([root], { isEnd: true, allCount: 1 }))],
    floors: { 4: [okData(floorData(root, [floorEntry(4, { rpid: 901 })], null))] },
  });
  const r = await runCollect(makeDeps(makeClient().client, bili.fetchImpl), opts({ maxFloorPages: 1 })) as { partial_reason?: string; fetched: { floors: number } };
  assert.equal(bili.floorUrls.length, 1, '只取第 1 页即停');
  assert.equal(r.partial_reason, 'floor_pages_cap');
  assert.equal(r.fetched.floors, 1, '已取楼层计入');
});

test('楼中楼失败：-101 partial need_login；-412 风控三档退避后 partial', async () => {
  const root1 = rootEntry({ rpid: 1, rcount: 5 });
  const bili1 = makeBili({ main: [okData(mainData([root1], { isEnd: true, allCount: 1 }))], floors: { 1: [errBody(-101)] } });
  const r1 = await runCollect(makeDeps(makeClient().client, bili1.fetchImpl), opts()) as { partial_reason?: string };
  assert.equal(r1.partial_reason, 'need_login');

  const sleeps: number[] = [];
  const root2 = rootEntry({ rpid: 2, rcount: 5 });
  const bili2 = makeBili({ main: [okData(mainData([root2], { isEnd: true, allCount: 1 }))], floors: { 2: [errBody(-412)] } });
  const r2 = await runCollect(makeDeps(makeClient().client, bili2.fetchImpl, { sleeps }), opts()) as { partial_reason?: string };
  assert.deepEqual(sleeps, RISK_BACKOFF_MS);
  assert.equal(r2.partial_reason, 'risk_control');
});

test('增量轮：refresh-roots 强制重翻 like top-N；楼已见且无增长 skip（退化口径=本轮已见）', async () => {
  const bili = makeBili({
    main: [okData(mainData([
      rootEntry({ rpid: 1, rcount: 0, like: 10, ctime: 1_700_000_009 }),
      rootEntry({ rpid: 2, rcount: 0, like: 5, ctime: 1_700_000_008 }),
    ], { isEnd: true, allCount: 99 }))],
    floors: { 1: [errBody(12002)] },
  });
  const logs: string[] = [];
  const c = makeClient({ count: { ok: true, rows: 5, roots: 5, max_ctime_s: 1_700_000_099 } });
  await runCollect(makeDeps(c.client, bili.fetchImpl, { logs }), opts({ refreshRoots: 1 }));
  assert.ok(logs.some((l) => l.includes('skip root=2') && l.includes('rcount=0')));
  assert.ok(logs.some((l) => l.includes('root=1') && l.includes('refresh-roots 强制重翻')), 'like top-1 根被强制重翻');
  assert.equal(bili.floorUrls.length, 1);
  assert.ok(bili.floorUrls[0].includes('root=1'));

  const logs2: string[] = [];
  const bili2 = makeBili({ main: [okData(mainData([rootEntry({ rpid: 100, rcount: 1, ctime: 1_700_000_009 }), floorEntry(100, { rpid: 901 })], { isEnd: true, allCount: 99 }))] });
  const c2 = makeClient({ count: { ok: true, rows: 5, roots: 5, max_ctime_s: 1_700_000_099 } });
  const r2 = await runCollect(makeDeps(c2.client, bili2.fetchImpl, { logs: logs2 }), opts()) as { fetched: { floors: number } };
  assert.ok(logs2.some((l) => l.includes('无增长')), 'rcount<=本轮已见 → skip');
  assert.equal(bili2.floorUrls.length, 0);
  assert.equal(r2.fetched.floors, 0);
});

test('ingest 连续 3 失败 → 终止本轮 partial ingest_fail（失败现场保留不冲）', async () => {
  const bili = makeBili({ main: [okData(mainData([rootEntry({ rpid: 71 }), rootEntry({ rpid: 72 }), rootEntry({ rpid: 73 })], { isEnd: true, allCount: 3 }))] });
  const c = makeClient({ ingestFailTimes: 99 });
  const r = await runCollect(makeDeps(c.client, bili.fetchImpl), opts({ batchSize: 1 })) as { partial: boolean; partial_reason?: string; store: { requests: number } };
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'ingest_fail');
  assert.equal(c.ingests.length, 3, '恰好 3 连败后停');
  assert.equal(r.store.requests, 3);
});

test('伪完整轮守卫：复查行数×1.2 < all_count → suspicious_truncation 不发标记批；复查失败/verify 失败不拦轮', async () => {
  const bili = makeBili({ main: [okData(mainData([rootEntry({ rpid: 81 })], { isEnd: true, allCount: 100 }))] });
  const c = makeClient({ count2: { ok: true, rows: 5, roots: 5, max_ctime_s: null } });
  const logs: string[] = [];
  const r = await runCollect(makeDeps(c.client, bili.fetchImpl, { logs }), opts()) as { partial: boolean; partial_reason?: string };
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'suspicious_truncation');
  assert.ok(logs.some((l) => l.includes('伪完整轮')));
  assert.equal(c.ingests.some((b) => b.full_scan === true), false, 'partial 轮不触发 missing 对账');

  const logs2: string[] = [];
  const bili2 = makeBili({ main: [okData(mainData([rootEntry({ rpid: 82 })], { isEnd: true, allCount: 1 }))] });
  const c2 = makeClient({ count2: { ok: false }, verify: 'fail' });
  const r2 = await runCollect(makeDeps(c2.client, bili2.fetchImpl, { logs: logs2 }), opts()) as { partial: boolean; verify: unknown };
  assert.equal(r2.partial, false, '复查失败跳过伪完整判定，仍完整轮');
  assert.equal(r2.verify, null, 'verify 查询失败不拦回执');
  assert.equal(c2.ingests.some((b) => b.full_scan === true), true);
  assert.ok(logs2.some((l) => l.includes('[verify] 校验查询失败')));
});

test('dry-run：取数解析照常、零 ingest 调用、store 段 would_requests/rows、无 verify', async () => {
  const bili = fullRoundBili();
  const c = makeClient({ ingestFailTimes: 1, verify: 'fail' });
  const r = await runCollect(makeDeps(c.client, bili.fetchImpl), opts({ dryRun: true })) as {
    dry_run: boolean; store: { would_requests: number; rows: number }; verify: unknown; missing: unknown;
  };
  assert.equal(r.dry_run, true);
  assert.deepEqual(r.store, { would_requests: 1, rows: 4 }, '尾批 4 行攒一批');
  assert.equal(r.verify, null);
  assert.equal(r.missing, null);
  assert.equal(c.ingests.length, 0, 'dry-run 零写库');
});

test('批量 --bvid-file：串行+5s 间隔、失败不阻断、batch 回执 succeeded/failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-test-'));
  try {
    const file = join(dir, 'bvids.txt');
    writeFileSync(file, 'BV1\n# 注释\nBV404\n', 'utf-8');
    const bili = fullRoundBili();
    const c = makeClient({ video: (vid) => (vid === 'BV404' ? null : { id: 1, source_vid: vid, title: 't', extra: JSON.stringify({ aid: 500 }) }) });
    const sleeps: number[] = [];
    const logs: string[] = [];
    const r = await runCollect(makeDeps(c.client, bili.fetchImpl, { sleeps, logs }), opts({ bvidFile: file })) as {
      batch: true; ok: boolean; total: number; succeeded: number; failed: number; results: Array<Record<string, unknown>>;
    };
    assert.equal(r.batch, true);
    assert.equal(r.total, 2);
    assert.equal(r.succeeded, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.ok, false);
    assert.equal(r.results[1].code, 'video_not_found');
    assert.deepEqual(sleeps, [2000, 5000], '视频间 5s 间隔（BV1 两主列表页之间的 pageInterval 2000 也在列——pageInterval 恒记 sleep,含 base 0 的 sleep(0)）');
    assert.ok(logs.some((l) => l.includes('批量继续下一个')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('批量 -101 中止：首个视频 need_login → 批量 break 不再采后续', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-test-'));
  try {
    const file = join(dir, 'bvids.txt');
    writeFileSync(file, 'BV1\nBV2\n', 'utf-8');
    const bili = makeBili({ main: [errBody(-101)] });
    const c = makeClient();
    const sleeps: number[] = [];
    const r = await runCollect(makeDeps(c.client, bili.fetchImpl, { sleeps }), opts({ bvidFile: file })) as {
      succeeded: number; failed: number; results: Array<Record<string, unknown>>;
    };
    assert.equal(r.succeeded, 1);
    assert.equal(r.failed, 0);
    assert.equal(r.results.length, 1, 'need_login 中止批量');
    assert.equal(r.results[0].partial_reason, 'need_login');
    assert.deepEqual(sleeps, [], '中止后无视频间隔');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('批量 -101 中止（抛错侧）：loadWbi 失败 collectOne 抛 need_login → catch 中止批量', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-test-'));
  try {
    const file = join(dir, 'bvids.txt');
    writeFileSync(file, 'BV1\nBV2\n', 'utf-8');
    const logs: string[] = [];
    const sleeps: number[] = [];
    const r = await runCollect(makeDeps(makeClient().client, makeBili({ navFailCode: -101 }).fetchImpl, { logs, sleeps }), opts({ bvidFile: file })) as {
      ok: boolean; succeeded: number; failed: number; results: Array<{ ok: boolean; code?: string }>;
    };
    assert.equal(r.succeeded, 0);
    assert.equal(r.failed, 1);
    assert.equal(r.results.length, 1, '与 partial 内收路径同效:抛错侧也中止批量');
    assert.equal(r.results[0].ok, false);
    assert.equal(r.results[0].code, 'need_login');
    assert.equal(r.ok, false);
    assert.deepEqual(sleeps, [], '中止后无视频间隔');
    assert.ok(logs.some((l) => l.includes('批量继续下一个')), '单视频失败日志先落再中止');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── C2. 分支补盲（R3，2026-10-04）：c8 全局分支门差额的定向补测，全部 mock 注入无真网络 ──

test('补盲·定位：--aid 单给两失败路 + 坏 extra JSON/缺 title 回查兜底 + extra 缺失且 view 失败 aid_unresolved', async () => {
  // --aid 单给,view 回查失败 → video_not_found
  await assert.rejects(
    resolveVideo(makeDeps(makeClient().client, makeBili({ view: null }).fetchImpl), newRoundState(), opts({ aid: '9', bvid: undefined })),
    (e: unknown) => (e as { code?: string }).code === 'video_not_found',
  );
  // --aid 单给,view ok 但库内无该视频 → video_not_found
  await assert.rejects(
    resolveVideo(makeDeps(makeClient({ video: null }).client, makeBili().fetchImpl), newRoundState(), opts({ aid: '9', bvid: undefined })),
    (e: unknown) => (e as { code?: string }).code === 'video_not_found',
  );
  // extra 是坏 JSON + 无 title → extraAidOf 解析兜底走 view 回查,title 落 null
  const c3 = makeClient({ video: { id: 1, source_vid: 'BV1', extra: '{oops' } });
  const v3 = await resolveVideo(makeDeps(c3.client, makeBili().fetchImpl), newRoundState(), opts());
  assert.equal(v3.aidSource, 'view 回查');
  assert.equal(v3.title, null);
  // extra 缺失 + view 失败 → aid_unresolved
  const c4 = makeClient({ video: { id: 1, source_vid: 'BV1' } });
  await assert.rejects(
    resolveVideo(makeDeps(c4.client, makeBili({ view: null }).fetchImpl), newRoundState(), opts()),
    (e: unknown) => (e as { code?: string }).code === 'aid_unresolved',
  );
});

test('补盲·I/O：main -403 后强刷 nav 再失败 → fetchMainPage 返回 need_login 强刷失败', async () => {
  const rig = makeClient();
  const st = newRoundState();
  const box = { keys: null };
  assert.equal((await loadWbi(makeDeps(rig.client, makeBili().fetchImpl), st, box, false)).ok, true, '先正常装一次 keys');
  const bad = await fetchMainPage(makeDeps(rig.client, makeBili({ main: [errBody(-403)], navFailCode: -101 }).fetchImpl), st, box, '500', '', 2);
  assert.equal(bad.ok, false);
  assert.match((bad as { message: string }).message, /强刷 wbi keys 失败/);
});

test('补盲·I/O：count ok:false → count_failed;裸 ok 响应 → rows 0/水位 null;view 无 stat → statReply null', async () => {
  await assert.rejects(
    countOrFail(makeDeps(makeClient({ count: { ok: false, error: '库锁' } }).client, makeBili().fetchImpl), 'BV1'),
    (e: unknown) => (e as { code?: string }).code === 'count_failed',
  );
  const cnt = await countOrFail(makeDeps(makeClient({ count: { ok: true } }).client, makeBili().fetchImpl), 'BV1');
  assert.deepEqual(cnt, { rows: 0, max_ctime_s: null });
  const st = newRoundState();
  const v = await viewLookup(makeDeps(makeClient().client, makeBili({ view: { aid: 500, bvid: 'BV1' } }).fetchImpl), st, { bvid: 'BV1' });
  assert.equal(v.ok, true);
  assert.equal(v.statReply, null, 'view 无 stat → 哨兵缺省不炸');
});

test('补盲·ingest：响应缺 inserted/updated/missing → 0/0/null;ok:false → streak;空批短路;fullScan 标记缺省;硬停 buffer 不冲', async () => {
  const rig = makeClient();
  let resp: Record<string, unknown> = { ok: true };
  const bare = { ...rig.client, commentsIngest: async () => resp } as CommentsClient;
  const deps = makeDeps(bare, makeBili().fetchImpl);
  const st = newRoundState();
  const ctx = { bvid: 'BV1', aid: '500', batchId: 'b1' } as unknown as RoundCtx;
  assert.equal(await ingestBatch(deps, st, ctx, [rootEntry()], { page: 1, sort: 'time' }), true);
  assert.deepEqual([st.store.inserted, st.store.updated, st.lastMissing], [0, 0, null], '裸 ok 响应全缺省');
  resp = { ok: false };
  assert.equal(await ingestBatch(deps, st, ctx, [rootEntry()], { page: 1, sort: 'time' }), false);
  assert.equal(st.ingestFailStreak, 1);

  const st2 = newRoundState();
  assert.equal(await ingestBatch(makeDeps(makeClient().client, makeBili().fetchImpl), st2, ctx, [], { page: null, sort: null }), true, '空批直接成功');
  assert.equal(st2.store.requests, 0, '空批不发请求');

  const st3 = newRoundState();
  const rig3 = makeClient();
  await ingestBatch(makeDeps(rig3.client, makeBili().fetchImpl), st3, ctx, [rootEntry()], { page: null, sort: null, fullScan: true });
  assert.equal(rig3.ingests[0].scan_start, null, 'scan_start 缺省 null');
  assert.deepEqual(rig3.ingests[0].pins, [], 'pins 缺省空表');

  const st4 = newRoundState();
  st4.stopped = { reason: 'ingest_fail', partial: true };
  st4.buffer.push(rootEntry(), rootEntry());
  const rig4 = makeClient();
  await flushBuffer(makeDeps(rig4.client, makeBili().fetchImpl), st4, { opts: { ...opts(), batchSize: 1 } } as unknown as RoundCtx, { page: null, sort: null });
  assert.equal(st4.buffer.length, 2, '硬停现场保留不冲');
  assert.equal(rig4.ingests.length, 0);
});

test('补盲·失败归一：handleMainFailure risk_control 带 status → 退避指引+状态码+riskAbort', () => {
  const logs: string[] = [];
  const st = newRoundState();
  handleMainFailure(makeDeps(makeClient().client, makeBili().fetchImpl, { logs }), st, { ok: false, code: 'risk_control', message: '拦截', status: 412 }, 3);
  assert.equal(st.riskAbort, true);
  assert.equal(st.stopped?.reason, 'risk_control');
  assert.ok(logs.some((l) => l.includes('http=412') && l.includes('风控三档退避')), '日志同时带状态码与指引');
});

test('补盲·编排：deps 缺 biliApi/cookieFrom 默认路由照走 + 裸 verify 响应日志全占位', async () => {
  const root = rootEntry({ rpid: 1, rcount: 2 });
  const bili = makeBili({
    main: [okData(mainData([root], { isEnd: true, allCount: 1 }))],
    floors: { 1: [errBody(12061)] }, // 无楼终态,只为驱动 crawlFloors 的 URL 构造
  });
  const logs: string[] = [];
  const deps = { ...makeDeps(makeClient({ verify: { ok: true } }).client, bili.fetchImpl, { logs }), biliApi: undefined, cookieFrom: undefined };
  const r = await runCollect(deps as CollectDeps, opts()) as { partial: boolean; verify: Record<string, unknown> | null };
  assert.equal(r.partial, false);
  assert.equal(bili.floorUrls.length, 1, 'mock 按 path 路由,默认 host 不影响命中');
  assert.ok(logs.some((l) => l.includes('(inline)')), 'cookieFrom 缺省日志占位');
  assert.ok(logs.some((l) => l.includes('[verify] roots=- floors=-')), '裸 verify 全占位');
  assert.equal(r.verify?.orphan_floor, null);
});

test('补盲·编排：marker 批 ingest 失败 → missing 不产出且轮仍完整（2 连败未达 3）', async () => {
  const logs: string[] = [];
  const r = await runCollect(makeDeps(makeClient({ ingestFailTimes: 2 }).client, fullRoundBili().fetchImpl, { logs }), opts()) as { partial: boolean; missing: unknown };
  assert.equal(r.partial, false, '2 连败未达 3 连,不置 partial');
  assert.equal(r.missing, null, 'marker 批失败 → missing 段不产出');
});

test('补盲·编排：dry-run 撞请求预算 → dry 完成日志带 partial:request_budget', async () => {
  const logs: string[] = [];
  const r = await runCollect(makeDeps(makeClient().client, fullRoundBili().fetchImpl, { logs }), opts({ dryRun: true, maxRequests: 2 })) as { partial: boolean; partial_reason?: string };
  assert.equal(r.partial, true);
  assert.equal(r.partial_reason, 'request_budget');
  assert.ok(logs.some((l) => l.includes('dry-run 完成') && l.includes('partial:request_budget')), 'dry 日志也带 stop 段');
});

test('补盲·批量：server 不可达 getVideo 通路错误原样上抛 → 批内 code 归 run_error 不中止', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-test-'));
  try {
    const file = join(dir, 'bvids.txt');
    writeFileSync(file, 'BV1\n', 'utf-8');
    const logs: string[] = [];
    const dead = new ServerClient('http://127.0.0.1:1', 't');
    const r = await runCollect(makeDeps(dead, makeBili().fetchImpl, { logs }), opts({ bvidFile: file })) as {
      failed: number; results: Array<{ ok: boolean; code?: string }>;
    };
    assert.equal(r.failed, 1);
    assert.equal(r.results[0].code, 'run_error', '无 code 的通路错误兜底 run_error');
    assert.ok(logs.some((l) => l.includes('批量继续下一个')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('补盲·编排：主列表中途 ingest 3 连败 → runMain 顶停;楼中楼首根中途硬停 → 第二根跳过', async () => {
  // 主列表侧:batchSize 1 + 3 连败 → flushBuffer 置硬停,runMain 循环顶返回
  const mainBili = makeBili({ main: [
    okData(mainData([rootEntry({ rpid: 1 }), rootEntry({ rpid: 2 }), rootEntry({ rpid: 3 })], { nextOffset: 'T1', allCount: 9 })),
    okData(mainData([rootEntry({ rpid: 4 })], { isEnd: true, allCount: 9 })),
  ] });
  const r1 = await runCollect(makeDeps(makeClient({ ingestFailTimes: 3 }).client, mainBili.fetchImpl), opts({ batchSize: 1 })) as { partial: boolean; partial_reason?: string };
  assert.equal(r1.partial_reason, 'ingest_fail');
  assert.equal(mainBili.mainUrls.length, 1, '第二主列表页不再请求');

  // 楼中楼侧:根 1 翻楼中硬停 → crawlFloors 顶停 + 根 2 未进爬
  const root = rootEntry({ rpid: 5, rcount: 99 });
  const floorBili = makeBili({
    main: [okData(mainData([root, rootEntry({ rpid: 6, rcount: 9 })], { isEnd: true, allCount: 2 }))],
    floors: { 5: [okData(floorData(root, [floorEntry(5), floorEntry(5, { rpid: 52 }), floorEntry(5, { rpid: 53 })], 99))] },
  });
  const r2 = await runCollect(makeDeps(makeClient({ ingestFailTimes: 3 }).client, floorBili.fetchImpl), opts({ batchSize: 1 })) as { partial: boolean; partial_reason?: string };
  assert.equal(r2.partial_reason, 'ingest_fail');
  assert.equal(floorBili.floorUrls.length, 1, '第二楼页不再请求');
  assert.ok(floorBili.floorUrls[0].includes('root=5'), '根 6 未进爬(循环顶硬停)');
});

test('补盲·编排：主列表预览重复/根重复/缺 member 行/无 cursor 页 → 计数与占位日志各归位', async () => {
  const bare55 = JSON.parse(JSON.stringify(rootEntry({ rpid: 55 }))) as RawEntry;
  delete (bare55 as { member?: unknown }).member;
  const bili = makeBili({ main: [
    okData(mainData([
      rootEntry({ rpid: 1, rcount: 5 }), rootEntry({ rpid: 2, rcount: 0 }), bare55,
      floorEntry(1, { rpid: 11 }), floorEntry(1, { rpid: 12 }), rootEntry({ rpid: 1, rcount: 5 }),
    ], { nextOffset: 'T1', allCount: 5 })),
    okData({ replies: [floorEntry(1)], top: {}, upper: { mid: 9 } }), // 无 cursor 形态
  ] });
  const logs: string[] = [];
  const r = await runCollect(makeDeps(makeClient().client, bili.fetchImpl, { logs }), opts()) as { fetched: { roots: number; previews: number }; partial: boolean };
  assert.equal(r.fetched.roots, 3, '根重复只计一次');
  assert.equal(r.fetched.previews, 3, '楼预览跨页去重计入');
  assert.ok(logs.some((l) => l.includes('缺失样本=55')), '缺 member 行进缺失样本日志');
  assert.ok(logs.some((l) => l.includes('all_count=- is_end=-')), '无 cursor 页占位符');
  assert.equal(r.partial, true, '无 cursor → cursor_missing 护栏停');
});

test('wbi 加载失败：nav -101 → need_login；nav 其他失败 → run_error（单视频抛错）', async () => {
  await assert.rejects(
    runCollect(makeDeps(makeClient().client, makeBili({ navFailCode: -101 }).fetchImpl), opts()),
    (e: unknown) => (e as { code?: string }).code === 'need_login',
  );
  await assert.rejects(
    runCollect(makeDeps(makeClient().client, makeBili({ navFailCode: -404 }).fetchImpl), opts()),
    (e: unknown) => (e as { code?: string }).code === 'run_error',
  );
});

// ── D. comments 命令装配层（进程内 captureParse，stats.test.ts 同构；子进程端到端见 comments.cli.test.ts）──

async function captureParse(args: string[]): Promise<{ out: string; err: string; codes: number[] }> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exit;
  let out = '';
  let err = '';
  const codes: number[] = [];
  const EXIT_SENTINEL = Symbol('cli-exit');
  process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err += String(chunk); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { codes.push(code ?? 0); throw EXIT_SENTINEL; }) as typeof process.exit;
  try {
    await buildCommentsCommand().parseAsync(['node', 'collector-cli', ...args]);
  } catch (e) {
    if (e !== EXIT_SENTINEL) throw e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return { out, err, codes };
}

const cliCtx = (dbPath: string, serverUrl = 'http://127.0.0.1:1') =>
  setCliContext({ format: 'json', dbPath, serverUrl, token: 't', quiet: false, serverExplicit: false });

test('buildCommentsCommand：collect 双缺 / bvid-file 互斥 / mode·sort 非法 / --max-pages 非整数 → ARGS 退 2', async () => {
  cliCtx(join(tmpdir(), 'unused.db'));
  const double = await captureParse(['collect', '--cookie-file', 'x']);
  assert.deepEqual(double.codes, [2]);
  assert.match(double.err, /--bvid 或 --aid/);

  const both = await captureParse(['collect', '--bvid-file', 'f.txt', '--bvid', 'BV1']);
  assert.deepEqual(both.codes, [2]);
  assert.match(both.err, /互斥/);

  const badMode = await captureParse(['collect', '--bvid', 'BV1', '--mode', 'bogus']);
  assert.deepEqual(badMode.codes, [2]);
  assert.match(badMode.err, /--mode/);

  const badSort = await captureParse(['collect', '--bvid', 'BV1', '--sort', 'bogus']);
  assert.deepEqual(badSort.codes, [2]);
  assert.match(badSort.err, /--sort/);

  const badInt = await captureParse(['collect', '--bvid', 'BV1', '--cookie-file', 'x', '--max-pages', 'abc']);
  assert.deepEqual(badInt.codes, [2]);
  assert.match(badInt.err, /--max-pages/);

  const negInt = await captureParse(['collect', '--bvid', 'BV1', '--cookie-file', 'x', '--max-pages=-1']);
  assert.deepEqual(negInt.codes, [2]);
  assert.match(negInt.err, /--max-pages/, '负整数同走 ARGS');
});

test('buildCommentsCommand：--bvid-file 文件不可读 → CollectError ARGS 退 2', async () => {
  cliCtx(join(tmpdir(), 'unused.db'));
  const dir = mkdtempSync(join(tmpdir(), 'comments-test-'));
  try {
    const ck = join(dir, 'ck.txt');
    writeFileSync(ck, 'SESSDATA=x', 'utf-8');
    const r = await captureParse(['collect', '--bvid-file', '/nonexistent/bvids.txt', '--cookie-file', ck]);
    assert.deepEqual(r.codes, [2]);
    assert.match(r.err, /bvid-file 不可读/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildCommentsCommand：cookie 缺失/不可读/空 → ARGS 退 2 且错误含 cookie 通路指引', async () => {
  cliCtx(join(tmpdir(), 'unused.db'));
  const saved = process.env.COLLECTOR_BILI_COOKIE_FILE;
  delete process.env.COLLECTOR_BILI_COOKIE_FILE;
  try {
    const missing = await captureParse(['collect', '--bvid', 'BV1']);
    assert.deepEqual(missing.codes, [2]);
    assert.match(missing.err, /bili-cookie-from-chrome/);
    assert.match(missing.out, /ARGS/);

    const unreadable = await captureParse(['collect', '--bvid', 'BV1', '--cookie-file', '/nonexistent/ck']);
    assert.deepEqual(unreadable.codes, [2]);
    assert.match(unreadable.err, /不可读/);

    const dir = mkdtempSync(join(tmpdir(), 'comments-test-'));
    try {
      const empty = join(dir, 'empty.txt');
      writeFileSync(empty, '  \n', 'utf-8');
      const r = await captureParse(['collect', '--bvid', 'BV1', '--cookie-file', empty]);
      assert.deepEqual(r.codes, [2]);
      assert.match(r.err, /为空/);
      assert.ok(COOKIE_GUIDANCE.includes('bili-cookie-from-chrome'), '指引常量自描述');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally {
    if (saved !== undefined) process.env.COLLECTOR_BILI_COOKIE_FILE = saved;
  }
});


// tree/verify 装配层种子库：1 视频 + 根 101（UP 主、置顶、state=17 楼）+ 楼若干 + 孤儿楼
function seedDb(dir: string): { dbPath: string; videoId: number } {
  const dbPath = join(dir, 'test.db');
  const db = openDb(dbPath);
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV9', title: '树视频', creator: { source_uid: '1', name: 'UP酱' }, extra: {}, duration: 60, published_at: 1_700_000_000_000 },
    tracks: [],
  });
  const videoId = (db.prepare('SELECT id FROM videos WHERE source_vid = ?').get('BV9') as { id: number }).id;
  const up = (o: Partial<CommentUpsertRow> & { rpid_str: string }): CommentUpsertRow => ({
    root_rpid: '0', parent_rpid: '0', dialog_rpid: '0', mid_str: null, uname: null, member: null,
    message: null, content: null, like_count: 0, rcount: 0, reply_total: 0, ctime_s: null,
    ip_location: null, state: 0, invisible: 0, folded: 0, up_like: 0, up_reply: 0, parent_reply_name: null, ...o,
  });
  upsertComments(db, {
    videoId, upperMid: '9001', fetchedAt: 1_700_000_000_000, batchId: 'b1', page: 1, sort: 'time',
    replies: [
      up({ rpid_str: '101', mid_str: '9001', uname: 'UP酱', message: '根评论UP', like_count: 20, ctime_s: 1_700_000_000, ip_location: '上海', up_reply: 1, rcount: 3 }),
      up({ rpid_str: '102', mid_str: '8002', uname: '张三', message: '根评论张三', like_count: 10, ctime_s: 1_700_000_100, state: 5 }),
      up({ rpid_str: '201', root_rpid: '101', parent_rpid: '101', dialog_rpid: '101', mid_str: '8003', uname: '李四', message: '楼1 回复根', like_count: 3, ctime_s: 1_700_000_200 }),
      up({ rpid_str: '202', root_rpid: '101', parent_rpid: '999', dialog_rpid: '101', mid_str: '8004', uname: '王五', message: '楼2 对象已删', ctime_s: 1_700_000_300 }),
      up({ rpid_str: '203', root_rpid: '101', parent_rpid: '201', dialog_rpid: '201', mid_str: '8005', uname: '赵六', message: '楼3 二层', state: 17, ctime_s: 1_700_000_400 }),
      up({ rpid_str: '204', root_rpid: '101', parent_rpid: '202', dialog_rpid: '203', mid_str: '8006', uname: '钱七', message: '楼4 三层拍平', folded: 1, ctime_s: 1_700_000_500 }),
      up({ rpid_str: '301', root_rpid: '777', parent_rpid: '777', dialog_rpid: '777', mid_str: '8007', uname: '孤儿', message: '根已删的楼', ctime_s: 1_700_000_600 }),
    ],
  });
  clearAndSetPins(db, videoId, [{ rpid_str: '101', kind: 'upper' }]);
  db.close();
  return { dbPath, videoId };
}

test('renderTree：§6.3 缩进文本全要素（UP主/IP/置顶/折叠/仅自己可见/回复 @/对象已删/深度拍平/孤儿组/limit/空树）', () => {
  const rec = (o: Partial<CommentRecord> & { rpid_str: string }): CommentRecord => ({
    id: 0, video_id: 1, root_rpid: '0', parent_rpid: '0', dialog_rpid: '0', is_root: 1,
    mid_str: null, uname: null, member: null, message: null, content: null, like_count: 0,
    rcount: 0, reply_total: 0, ctime_s: null, ip_location: null, state: 0, invisible: 0,
    folded: 0, up_like: 0, up_reply: 0, is_up: 0, pin_kind: null, parent_reply_name: null, first_seen_at: 0,
    last_seen_at: 0, first_page: null, first_sort: null, batch_id: null, missing_since: null, ...o,
  });
  const rootUp = rec({ rpid_str: '101', uname: 'UP酱', is_up: 1, like_count: 20, ip_location: '上海', ctime_s: 1_700_000_000, up_reply: 1, message: '根正文', pin_kind: 'upper' });
  const rootZ = rec({ rpid_str: '102', uname: null, like_count: 10, ctime_s: null, state: 5 });
  const f1 = rec({ rpid_str: '201', root_rpid: '101', parent_rpid: '101', dialog_rpid: '101', is_root: 0, uname: '李四', message: '楼1', ctime_s: 1_700_000_200, like_count: 3 });
  const f2 = rec({ rpid_str: '202', root_rpid: '101', parent_rpid: '999', dialog_rpid: '101', is_root: 0, uname: '王五', message: '楼2', ctime_s: 1_700_000_300 });
  const f3 = rec({ rpid_str: '203', root_rpid: '101', parent_rpid: '201', dialog_rpid: '201', is_root: 0, uname: '赵六', message: '楼3', state: 17, ctime_s: 1_700_000_400 });
  const f4 = rec({ rpid_str: '204', root_rpid: '101', parent_rpid: '202', dialog_rpid: '203', is_root: 0, uname: '钱七', message: '楼4', folded: 1, ctime_s: 1_700_000_500 });
  const f5 = rec({ rpid_str: '205', root_rpid: '101', parent_rpid: '999', dialog_rpid: '888', is_root: 0, uname: null, message: '楼5', ctime_s: 1_700_000_550 });
  const orphan = rec({ rpid_str: '301', root_rpid: '777', parent_rpid: '777', dialog_rpid: '777', is_root: 0, uname: null, message: '孤楼', ctime_s: 1_700_000_600 });
  const tree = {
    roots: [rootUp, rootZ],
    floorsByRoot: new Map([['101', [f1, f2, f3, f4, f5]], ['777', [orphan]]]),
  };
  const text = renderTree(tree, {});
  assert.ok(text.includes('评论区树:共 8 条(根 2 / 楼中楼 6)'));
  assert.ok(text.includes('## 【赞 20】@UP酱(UP主) · IP属地:上海 · 2023-11-15 · UP主已回复 [置顶:upper]'), '根头标注齐全');
  assert.ok(text.includes('根正文'));
  assert.ok(!text.includes('IP属地:-'), '无 IP 不输出空属地段');
  assert.ok(text.includes('【赞 10】@(未知用户) · 时间未知 [state=5]'), '缺 uname/ctime 走占位');
  // 楼行无日期段;f1 dialog=根(101≠自身 201)→「回复 @UP酱」;f2 对象 999 缺失→对象已删标注
  assert.ok(text.includes('- 【赞 3】@李四 回复 @UP酱:楼1'), 'dialog 指向根作者');
  assert.ok(text.includes('- 【赞 0】@王五 回复 @UP酱(回复对象已删除):楼2'), '回复对象已删除标注');
  assert.ok(text.includes('  - 【赞 0】@赵六 回复 @李四:楼3 [仅自己可见]'), '二层缩进+仅自己可见');
  assert.ok(text.includes('  - 【赞 0】@钱七 回复 @赵六(回复对象已删除):楼4 [已折叠]'), '深层拍平+折叠');
  assert.ok(text.includes('- 【赞 0】@(未知用户)(回复对象已删除):楼5'), 'dialog 悬空(888 不在树)省略回复前缀');
  assert.ok(text.includes('[仅自己可见]'));
  assert.ok(text.includes('[已折叠]'));
  assert.ok(text.includes('[state=5]'));
  assert.ok(text.includes('## 根已删除的楼层(1 条)'));
  assert.ok(text.includes('- 【赞 0】@(未知用户):孤楼'), '孤儿组行(dialog=自身悬空省略前缀,缺 uname 占位)');
  const limited = renderTree(tree, { limit: 1 });
  assert.ok(limited.includes('(仅显示点赞前 1 根,共 2 根;--limit 调整)'));
  assert.ok(!limited.includes('张三'), 'limit 截根');
  assert.ok(limited.includes('根已删除的楼层'), '孤儿组不受 limit 影响');
  const empty = renderTree({ roots: [], floorsByRoot: new Map() }, {});
  assert.ok(empty.includes('(该视频暂无评论)'));
});

test('renderTree：reply_to 悬空兜底（悬空+parent_reply_name 快照 → 回复 @快照;与 bundle 导出同语义）', () => {
  const rec = (o: Partial<CommentRecord> & { rpid_str: string }): CommentRecord => ({
    id: 0, video_id: 1, root_rpid: '0', parent_rpid: '0', dialog_rpid: '0', is_root: 1,
    mid_str: null, uname: null, parent_reply_name: null, member: null, message: null, content: null, like_count: 0,
    rcount: 0, reply_total: 0, ctime_s: null, ip_location: null, state: 0, invisible: 0,
    folded: 0, up_like: 0, up_reply: 0, is_up: 0, pin_kind: null, first_seen_at: 0,
    last_seen_at: 0, first_page: null, first_sort: null, batch_id: null, missing_since: null, ...o,
  });
  const root = rec({ rpid_str: 'R', uname: '根作者', like_count: 5 });
  // 悬空 dialog(888 不在树)+ 快照;parent==dialog → 不缀「(回复对象已删除)」
  const ghost = rec({ rpid_str: 'g1', root_rpid: 'R', parent_rpid: '888', dialog_rpid: '888', is_root: 0, uname: '悬快照', parent_reply_name: '已删君', message: '带快照的楼', ctime_s: 1 });
  // 悬空 + parent≠dialog → 快照前缀与「(回复对象已删除)」标注可叠加
  const both = rec({ rpid_str: 'g2', root_rpid: 'R', parent_rpid: '999', dialog_rpid: '888', is_root: 0, uname: '双标注', parent_reply_name: '删者', message: '叠标注的楼', ctime_s: 2 });
  // 悬空且无快照 → 维持省略前缀(现状)
  const bare = rec({ rpid_str: 'g3', root_rpid: 'R', parent_rpid: 'gone', dialog_rpid: 'gone', is_root: 0, uname: '无摘要', parent_reply_name: null, message: '无快照的楼', ctime_s: 3 });
  // dialog=自身(直回根)即使误带快照也恒省略
  const self = rec({ rpid_str: 'g4', root_rpid: 'R', parent_rpid: 'R', dialog_rpid: 'g4', is_root: 0, uname: '直根', parent_reply_name: '不该出现', message: '直回根的楼', ctime_s: 4 });
  const tree = { roots: [root], floorsByRoot: new Map([['R', [ghost, both, bare, self]]]) };
  const text = renderTree(tree, {});
  assert.ok(text.includes('- 【赞 0】@悬快照 回复 @已删君:带快照的楼'), '悬空 → parent_reply_name 快照兜底');
  assert.ok(text.includes('- 【赞 0】@双标注 回复 @删者(回复对象已删除):叠标注的楼'), '快照前缀与已删标注可叠加');
  assert.ok(text.includes('- 【赞 0】@无摘要:无快照的楼'), '悬空且快照缺失维持省略');
  // dialog=自身(直回根)即使误带快照也无「回复 @」前缀;parent(R)≠dialog(g4) 缀的
  // 「(回复对象已删除)」系 parent_missing 既有纯字段比较语义,与本兜底无关
  assert.ok(text.includes('@直根(回复对象已删除):直回根的楼'), 'dialog=自身无回复前缀');
  assert.ok(!text.includes('不该出现'), '直回根误带快照不泄入前缀');
});

test('buildCommentsCommand：tree/verify 缺 --bvid → ARGS；未知视频 → NOT_FOUND 退 5', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-test-'));
  try {
    const { dbPath } = seedDb(dir);
    cliCtx(dbPath);
    const noBvid = await captureParse(['tree']);
    assert.deepEqual(noBvid.codes, [2]);

    const missing = await captureParse(['tree', '--bvid', 'BV404']);
    assert.deepEqual(missing.codes, [5]);
    assert.match(missing.out, /NOT_FOUND/);

    const vNoBvid = await captureParse(['verify']);
    assert.deepEqual(vNoBvid.codes, [2]);
    const vMissing = await captureParse(['verify', '--bvid', 'BV404']);
    assert.deepEqual(vMissing.codes, [5]);
    const badStat = await captureParse(['verify', '--bvid', 'BV9', '--stat-reply', 'abc']);
    assert.deepEqual(badStat.codes, [2]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildCommentsCommand：tree 缩进输出 + verify 回执（--stat-reply 启 R9 根数缺口）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comments-test-'));
  try {
    const { dbPath } = seedDb(dir);
    cliCtx(dbPath);
    const tree = await captureParse(['tree', '--bvid', 'BV9']);
    assert.deepEqual(tree.codes, []);
    assert.ok(tree.out.includes('评论区树:共 7 条(根 2 / 楼中楼 5)'), tree.out.slice(0, 120));
    assert.ok(tree.out.includes('@UP酱(UP主)'));
    assert.ok(tree.out.includes('[置顶:upper]'));
    assert.ok(tree.out.includes('根已删除的楼层(1 条)'));

    const verify = await captureParse(['verify', '--bvid', 'BV9', '--stat-reply', '1']);
    assert.deepEqual(verify.codes, []);
    const v = JSON.parse(verify.out) as { ok: boolean; counts: { roots: number }; integrity: { root_count_gap: number } };
    assert.equal(v.ok, true);
    assert.equal(v.counts.roots, 2);
    assert.ok(v.integrity.root_count_gap > 0, '外部哨兵 1 < 库内 2 → 缺口告警');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
