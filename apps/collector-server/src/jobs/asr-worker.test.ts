// jobs/asr-worker.ts 测试：环境装配（缺省/覆盖/cookie 文件读取与降级）、dryRunCircle 圈定口径、
// runAsrBackfillJob 装配真链路（复用 cli runBackfill + serverBackfillClient 直查 DB）。
// 全部用例走「零外网」路径：空圈定直返、douyin 缺 play_uri 归因 missing_play_uri、
// douyin 带 play_uri 走到下载但对 127.0.0.1:1 立即连接拒绝（非风控不退避，毫秒级失败）——
// 该用例同时钉死 getVideo 必须回平视频行（extra 在行上；若误回 {video} 包裹形态会恒 missing_play_uri）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | env 装配/dry-run 圈定/worker 装配（空圈定/missing_play_uri/下载失败归因/dry_run 兜底/cookie 日志） | 通过 | Phase 4 web 化 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { markNoSubtitle } from '../db/tags.js';
import {
  asrApiFromEnv, engineFromEnv, biliCookieFromEnv, biliCookieConfigured,
  dryRunCircle, runAsrBackfillJob, serverBackfillClient,
} from './asr-worker.js';
import type { JobCtx } from './runner.js';

function setup(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

// 播种 no-subtitle 视频（first_seen 手工钉序：dry-run 圈定按 first_seen 倒序）
function seedNoSub(db: Database.Database, source: string, vid: string, opts: { duration?: number; firstSeen?: number; withTrack?: boolean; extra?: Record<string, unknown> } = {}): void {
  ingestVideo(db, {
    source: source as 'bilibili' | 'douyin',
    video: {
      source_vid: vid, title: `t-${vid}`, creator: { source_uid: 'u1', name: 'up' },
      duration: opts.duration ?? 60, ...(opts.extra !== undefined ? { extra: opts.extra } : {}),
    },
    tracks: opts.withTrack
      ? [{ lan: 'zh', lan_doc: '中文', track_type: 0, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 1, content: 'x' }] } }] }]
      : [],
  });
  // 有轨视频不打 no-subtitle 标（真实链路轨落地即摘标；圈定按标签过滤，带标带轨会被误圈）
  if (!opts.withTrack) markNoSubtitle(db, { source: source as 'bilibili' | 'douyin', source_vid: vid });
  if (opts.firstSeen !== undefined) db.prepare('UPDATE videos SET first_seen_at = ? WHERE source_vid = ?').run(opts.firstSeen, vid);
}

function fakeCtx(db: Database.Database, onProgressCalls: Array<Record<string, unknown>>): JobCtx {
  return { db, jobId: 42, onProgress: (p) => onProgressCalls.push(p) };
}

// ── 环境装配 ──

test('env 装配：缺省值 / 显式覆盖 / cookie 文件 trim / 不可读降级 undefined / configured 判定', () => {
  const empty = { __: 1 } as unknown as NodeJS.ProcessEnv;
  assert.equal(asrApiFromEnv(empty), 'http://127.0.0.1:5079', '缺省 fireredasr 地址（DEFAULT_ASR_API）');
  assert.equal(engineFromEnv(empty), 'fireredasr-aed-l', '缺省引擎（DEFAULT_ENGINE）');
  assert.equal(biliCookieFromEnv(empty), undefined);
  assert.equal(biliCookieConfigured(empty), false);

  const dir = mkdtempSync(join(tmpdir(), 'collector-asrworker-'));
  try {
    const cookieFile = join(dir, 'cookie.txt');
    writeFileSync(cookieFile, '  SESSDATA=abc\n');
    const env = {
      COLLECTOR_ASR_BASE_URL: 'http://10.0.0.8:5079',
      COLLECTOR_ASR_ENGINE: 'my-engine',
      COLLECTOR_BILI_COOKIE_FILE: cookieFile,
    } as unknown as NodeJS.ProcessEnv;
    assert.equal(asrApiFromEnv(env), 'http://10.0.0.8:5079');
    assert.equal(engineFromEnv(env), 'my-engine');
    assert.equal(biliCookieFromEnv(env), 'SESSDATA=abc', 'cookie 读入并 trim');
    assert.equal(biliCookieConfigured(env), true, 'configured 只看变量是否设置');

    assert.equal(biliCookieFromEnv({ COLLECTOR_BILI_COOKIE_FILE: join(dir, 'no-such.txt') } as NodeJS.ProcessEnv), undefined, '文件不可读 → 按未配置（warn 降级）');
    assert.equal(biliCookieFromEnv({ COLLECTOR_BILI_COOKIE_FILE: '   ' } as NodeJS.ProcessEnv), undefined, '变量为空白 → 未配置');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── dry-run 圈定 ──

test('dryRunCircle：no-subtitle 精确圈定 + first_seen 倒序 + source/max_duration/size/page 过滤', () => {
  const db = setup();
  seedNoSub(db, 'bilibili', 'BV1old000001', { duration: 60, firstSeen: 100 });
  seedNoSub(db, 'bilibili', 'BV2long000002', { duration: 600, firstSeen: 200 });
  seedNoSub(db, 'bilibili', 'BV3sub000001', { firstSeen: 300, withTrack: true }); // 有轨 → 不该被圈
  seedNoSub(db, 'douyin', 'dy0001', { firstSeen: 400 });
  try {
    assert.deepEqual(dryRunCircle(db, {}).map((i) => i.source_vid), ['dy0001', 'BV2long000002', 'BV1old000001'], '缺省 size=5 全量圈定，最新在前');
    const one = dryRunCircle(db, {});
    assert.deepEqual(Object.keys(one[0]!).sort(), ['duration', 'source_vid', 'title'], '条目字段就是 source_vid/title/duration');
    assert.deepEqual(dryRunCircle(db, { source: 'bilibili' }).map((i) => i.source_vid), ['BV2long000002', 'BV1old000001']);
    assert.deepEqual(dryRunCircle(db, { source: 'bilibili', max_duration: 100 }).map((i) => i.source_vid), ['BV1old000001'], 'max_duration 上限过滤');
    assert.deepEqual(dryRunCircle(db, { size: 1 }).map((i) => i.source_vid), ['dy0001']);
    assert.deepEqual(dryRunCircle(db, { page: 2, size: 2 }).map((i) => i.source_vid), ['BV1old000001'], '第 2 页每页 2 条 → 只剩最旧一条');
  } finally { db.close(); }
});

// ── worker 装配（真 runBackfill + serverBackfillClient，零外网路径）──

test('runAsrBackfillJob：空圈定 → summary 直返（零网络零步进），初始进度 {done:0,total:0} 落一次', async () => {
  const db = setup();
  const progress: Array<Record<string, unknown>> = [];
  const summary = await runAsrBackfillJob(fakeCtx(db, progress), {});
  assert.deepEqual(summary, { source: 'bilibili', circled: 0, done: 0, dry_run: false, failed: {}, samples: {} });
  assert.deepEqual(progress, [{ done: 0, total: 0, failed: {} }], '只有初始进度（无条目无步进）');
  db.close();
});

test('runAsrBackfillJob：douyin 缺 play_uri → missing_play_uri 归因 + onStep 进度序列；非法 size 防御性归一', async () => {
  const db = setup();
  seedNoSub(db, 'douyin', 'dy0001', {});
  const progress: Array<Record<string, unknown>> = [];
  const summary = await runAsrBackfillJob(fakeCtx(db, progress), { source: 'douyin', size: 'abc' });
  assert.equal(summary.circled, 1);
  assert.equal(summary.done, 0);
  assert.deepEqual(summary.failed, { missing_play_uri: 1 });
  assert.deepEqual(summary.samples, { missing_play_uri: ['dy0001'] });
  assert.deepEqual(progress, [
    { done: 0, total: 0, failed: {} },
    { done: 1, total: 1, failed: { missing_play_uri: 1 } },
  ], '初始进度 + 每视频步进（失败分类码实时累计）');
  db.close();
});

test('runAsrBackfillJob：douyin 带 play_uri → extra.play_uri 正确取出（走到下载而非 missing_play_uri），下载失败归 download_error', async () => {
  const db = setup();
  seedNoSub(db, 'douyin', 'dy0002', { extra: { play_uri: 'dy-mock-uri' } });
  // 下载直链是 play_uri 直构的 snssdk URL（play_uri 本身不进 fetch）——打桩全局 fetch 令下载立即失败：
  // download_error risk:false 不退避，毫秒级零真网；若误回 {video} 包裹形态则根本走不到 fetch（恒 missing_play_uri）
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('mock net down'); }) as typeof fetch;
  try {
    const progress: Array<Record<string, unknown>> = [];
    const summary = await runAsrBackfillJob(fakeCtx(db, progress), { source: 'douyin' });
    assert.equal(summary.circled, 1);
    assert.equal(summary.failed.missing_play_uri, undefined, 'play_uri 取到才会走到下载步（形态钉子：误回包裹形态会 missing_play_uri）');
    assert.deepEqual(summary.failed, { download_error: 1 });
  } finally {
    globalThis.fetch = origFetch;
    db.close();
  }
});

test('runAsrBackfillJob：dry_run=true → 圈定后直返不处理（worker 兜底：handler 同步直答后不会入队）', async () => {
  const db = setup();
  seedNoSub(db, 'douyin', 'dy0001', {});
  const progress: Array<Record<string, unknown>> = [];
  const summary = await runAsrBackfillJob(fakeCtx(db, progress), { source: 'douyin', dry_run: true });
  assert.equal(summary.dry_run, true);
  assert.equal(summary.circled, 1);
  assert.equal(summary.done, 0);
  assert.deepEqual(summary.failed, {}, 'dry-run 不做任何下载/转写');
  assert.deepEqual(progress, [{ done: 0, total: 0, failed: {} }]);
  db.close();
});

test('serverBackfillClient：listVideos 映射（tags 单值→数组 / 缺省回退）与 getVideo 缺失 → null', async () => {
  const db = setup();
  seedNoSub(db, 'bilibili', 'BV1old000001', { duration: 60 });
  const client = serverBackfillClient(db);
  try {
    // 缺省参数回退：不传 sort/desc/page/size → first_seen 倒序 + page=1 size=20
    const r = await client.listVideos({} as Parameters<typeof client.listVideos>[0]);
    assert.equal(r.total, 1, 'tags 未传 → 不过滤标签（worker 恒传 no-subtitle，此处只钉映射分支）');
    assert.equal(r.items[0]!.source_vid, 'BV1old000001');
    const filtered = await client.listVideos({ tags: 'no-subtitle', sort: 'first_seen', desc: true, page: 1, size: 5 } as Parameters<typeof client.listVideos>[0]);
    assert.equal(filtered.total, 1, 'tags 单值 → [单值] 数组进 ListFilter');
    // getVideo：命中回平视频行（extra 在行上）；缺失回 null（runBackfill 归因 video_missing 路径的前置）
    const detail = await client.getVideo('bilibili', 'BV1old000001');
    assert.ok(detail);
    assert.equal((detail as Record<string, unknown>).source_vid, 'BV1old000001');
    assert.equal(await client.getVideo('bilibili', 'BV9missing09'), null);
  } finally { db.close(); }
});

test('serverBackfillClient：asrSubmit 视频缺失抛错（submit_error 归因前置），命中走 writeAsrVersion 落轨', async () => {
  const db = setup();
  const client = serverBackfillClient(db);
  try {
    await assert.rejects(
      () => client.asrSubmit('bilibili', 'BV9missing09', 'e', []),
      /video not found: bilibili\/BV9missing09/,
    );
    seedNoSub(db, 'bilibili', 'BV1old000001', {});
    const out = (await client.asrSubmit('bilibili', 'BV1old000001', 'test-engine', [{ from: 0, to: 1, content: 'x' }])) as { inserted: number; unmarked: boolean };
    assert.equal(out.inserted, 1);
    assert.equal(out.unmarked, true, '写回成功自动摘 no-subtitle 标');
    const tracks = db.prepare("SELECT COUNT(*) AS n FROM subtitle_tracks st JOIN videos v ON v.id = st.video_id WHERE v.source_vid = 'BV1old000001'").get() as { n: number };
    assert.equal(tracks.n, 1, 'cues 写回为字幕轨（复用 HTTP asr/submit 同事务口径）');
    const tagged = db.prepare("SELECT COUNT(*) AS n FROM video_tags vt JOIN tags t ON t.id = vt.tag_id JOIN videos v ON v.id = vt.video_id WHERE v.source_vid = 'BV1old000001' AND t.name = 'no-subtitle'").get() as { n: number };
    assert.equal(tagged.n, 0, '写回成功自动摘 no-subtitle 标');
  } finally { db.close(); }
});

test('runAsrBackfillJob：cookie 装配按环境注入（未配置 → 日志明示 need_login 预警；douyin 恒零 cookie）', async () => {
  const db = setup();
  const saved = process.env.COLLECTOR_BILI_COOKIE_FILE;
  const dir = mkdtempSync(join(tmpdir(), 'collector-asrworker-'));
  const cookieFile = join(dir, 'c.txt');
  writeFileSync(cookieFile, 'SESSDATA=x');
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (msg: unknown) => lines.push(String(msg));
  try {
    delete process.env.COLLECTOR_BILI_COOKIE_FILE;
    await runAsrBackfillJob(fakeCtx(db, []), { source: 'bilibili' }); // 空库零网络
    assert.ok(lines.some((l) => l.includes('未配置 cookie')), 'bilibili + 无 cookie → 执行日志带预警');

    lines.length = 0;
    process.env.COLLECTOR_BILI_COOKIE_FILE = cookieFile;
    await runAsrBackfillJob(fakeCtx(db, []), { source: 'bilibili' });
    assert.ok(!lines.some((l) => l.includes('未配置 cookie')), '已配置 → 无预警');

    lines.length = 0;
    delete process.env.COLLECTOR_BILI_COOKIE_FILE;
    await runAsrBackfillJob(fakeCtx(db, []), { source: 'douyin' });
    assert.ok(!lines.some((l) => l.includes('未配置 cookie')), 'douyin 零 cookie 依赖，不预警');
  } finally {
    if (saved !== undefined) process.env.COLLECTOR_BILI_COOKIE_FILE = saved;
    else delete process.env.COLLECTOR_BILI_COOKIE_FILE;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});
