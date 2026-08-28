// asr-douyin（直链解析 + mp4 流式下载）单元测试。下载走真实临时文件（mkdtemp 目录内），
// fetch 全 mock：断言字节落盘一致、礼貌头、重试退避节奏、大小上限两道防线（content-length 预检 /
// 流中断流）、失败清残留。302 跟随由 fetch 默认 redirect:'follow' 语义承担——mock 里用递归跟随模拟，
// 断言我方代码不干扰该语义（不设 redirect:'manual'、不自行读 Location）。
// 编排层（圈定 source 透传/全链路/dry-run/truncated）在 [commands/asr.test.ts](./commands/asr.test.ts)。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 解析×3 组 + 下载成功/302/重试/上限/异常 | 通过 | sleep 注入立即记录不真等 |

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDouyinVideoUrl, buildDouyinPlayUrl, downloadDouyinVideo,
  DOUYIN_HEADERS, DOUYIN_MAX_VIDEO_BYTES, DOUYIN_PLAY_RATIO, DOUYIN_PLAY_LINE,
} from './asr-douyin.js';

const PLAY_URI = 'v0300fg10000da8i3knog65s9j5g544g';
const PLAY_URL = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${PLAY_URI}&ratio=${DOUYIN_PLAY_RATIO}&line=${DOUYIN_PLAY_LINE}`;
const CDN_URL = 'https://v26-web.douyinvod.com/video/tos/cdn-obj.mp4';

let tmpDir: string;
before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'asr-douyin-test-')); });
after(async () => { await rm(tmpDir, { recursive: true, force: true }); });

const dest = () => join(tmpDir, `dl-${crypto.randomUUID()}.mp4`);

// 基础 deps：fetch/sleep/log 全注入（退避不真等，日志可断言）
function deps(fetchImpl: typeof fetch) {
  const sleeps: number[] = [];
  return { d: { fetchImpl, sleep: async (ms: number) => { sleeps.push(ms); }, log: () => {} }, sleeps };
}

// ── resolveDouyinVideoUrl / buildDouyinPlayUrl ──

test('resolveDouyinVideoUrl：对象与 JSON 字符串双形态取 play_uri，直构 URL 形态正确', () => {
  // 对象形态（编排 mock 常用）
  assert.deepEqual(resolveDouyinVideoUrl({ play_uri: PLAY_URI }), { url: PLAY_URL });
  // JSON 字符串形态（server 详情端点 video.extra 是 TEXT 列）
  assert.deepEqual(resolveDouyinVideoUrl(JSON.stringify({ play_uri: PLAY_URI, stat: { view: 0 } })), { url: PLAY_URL });
  // 直构 URL：video_id 编码 + spike 实测的 ratio/line 参数。
  // 空格编成 + 是 URLSearchParams 的 form-urlencoded 语义（真实 play_uri 是 [a-z0-9]，此处纯健壮性断言）
  assert.equal(
    buildDouyinPlayUrl('a b/c'),
    `https://aweme.snssdk.com/aweme/v1/play/?video_id=a+b%2Fc&ratio=${DOUYIN_PLAY_RATIO}&line=${DOUYIN_PLAY_LINE}`,
    '特殊字符 play_uri 经 URLSearchParams 编码',
  );
});

test('resolveDouyinVideoUrl：无 play_uri / 空串 / 非法 JSON → 明确 error（键名列表可观察）', () => {
  for (const extra of [{}, { play_addr: { url_list: [CDN_URL] } }, { play_uri: '' }, { play_uri: 123 }, 'not json', '123', null]) {
    const r = resolveDouyinVideoUrl(extra);
    assert.ok('error' in r && r.error.includes('play_uri'), `应报 error 且含 play_uri：${JSON.stringify(extra)} → ${JSON.stringify(r)}`);
  }
  // 键名列表助判结构漂移（CLAUDE.md §9 可观察性）
  const withKeys = resolveDouyinVideoUrl({ play_addr: { url_list: [] } });
  assert.ok('error' in withKeys && withKeys.error.includes('play_addr'), 'error 带实际键名');
});

// ── downloadDouyinVideo ──

test('downloadDouyinVideo：成功流式落盘（字节一致 + 计数 + UA/Referer 礼貌头）', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const seenHeaders: Array<Record<string, string>> = [];
  const { d } = deps(async (_input, init) => {
    seenHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
  });
  const file = dest();
  const r = await downloadDouyinVideo(d, PLAY_URL, file);
  assert.deepEqual(r, { ok: true, bytes: bytes.length });
  assert.deepEqual(await readFile(file), Buffer.from(bytes), '落盘字节与响应一致');
  assert.equal(seenHeaders[0]['user-agent'], DOUYIN_HEADERS['User-Agent'], 'Chrome UA 礼貌头');
  assert.equal(seenHeaders[0].referer, 'https://www.douyin.com/', '抖音 Referer 礼貌头');
});

test('downloadDouyinVideo：302 → CDN 206 由 fetch 默认跟随（我方不设 redirect manual）', async () => {
  const hits: string[] = [];
  // mock fetch 自身模拟 redirect:'follow'：snssdk 302 → 递归取 Location 的 CDN 206
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    hits.push(url);
    if (url.startsWith('https://aweme.snssdk.com/aweme/v1/play/')) return impl(CDN_URL);
    return new Response(new Uint8Array([9, 8, 7]), { status: 206, headers: { 'Content-Type': 'video/mp4' } });
  };
  const file = dest();
  const r = await downloadDouyinVideo({ ...deps(impl as unknown as typeof fetch).d }, PLAY_URL, file);
  assert.ok(r.ok, `302 跟随后应成功：${JSON.stringify(r)}`);
  assert.deepEqual(await readFile(file), Buffer.from([9, 8, 7]));
  assert.deepEqual(hits, [PLAY_URL, CDN_URL], '两跳都被请求（跟随不丢链路）');
});

test('downloadDouyinVideo：HTTP 403 两次退避后成功（复用 B 站 30s/2min 序列）', async () => {
  let hits = 0;
  const { d, sleeps } = deps(async () => {
    hits++;
    return hits <= 2 ? new Response('blocked', { status: 403 }) : new Response(new Uint8Array([1]), { status: 200 });
  });
  const file = dest();
  const r = await downloadDouyinVideo(d, PLAY_URL, file);
  assert.ok(r.ok);
  assert.deepEqual(sleeps, [30_000, 120_000], '退避序列对齐 asr-net RISK_BACKOFF_MS');
});

test('downloadDouyinVideo：恒 403 → 三档退避后放弃 download_http_403；清残留半文件', async () => {
  const { d, sleeps } = deps(async () => new Response('blocked', { status: 403 }));
  const file = dest();
  const r = await downloadDouyinVideo(d, PLAY_URL, file);
  assert.ok(!r.ok && r.code === 'download_http_403' && r.message.includes('三档退避'), JSON.stringify(r));
  assert.deepEqual(sleeps, [30_000, 120_000, 300_000]);
  await assert.rejects(stat(file), '失败路径不残留文件');
});

test('downloadDouyinVideo：HTTP 500/404 不退避 → download_http_500 / download_http_404', async () => {
  for (const status of [500, 404]) {
    const { d, sleeps } = deps(async () => new Response('nope', { status }));
    const r = await downloadDouyinVideo(d, PLAY_URL, dest());
    assert.equal((r as { code: string }).code, `download_http_${status}`, `非 403/412 不重试`);
    assert.deepEqual(sleeps, []);
  }
});

test('downloadDouyinVideo：fetch 抛异常 → download_error；响应无 body → download_error', async () => {
  // 1. 网络异常
  const { d: d1, sleeps } = deps(async () => { throw new Error('net down'); });
  let r = await downloadDouyinVideo(d1, PLAY_URL, dest());
  assert.equal((r as { code: string }).code, 'download_error');
  assert.deepEqual(sleeps, [], '网络异常不退避');
  // 2. 200 但 body null（构造 Response(null)）
  const { d: d2 } = deps(async () => new Response(null, { status: 200 }));
  r = await downloadDouyinVideo(d2, PLAY_URL, dest());
  assert.equal((r as { code: string }).code, 'download_error');
  assert.ok((r as { message: string }).message.includes('无 body'));
});

test('downloadDouyinVideo：content-length 超上限 → video_too_large 预检拦截不落盘', async () => {
  const { d, sleeps } = deps(async () => new Response(new Uint8Array([1]), {
    status: 200, headers: { 'Content-Length': String(DOUYIN_MAX_VIDEO_BYTES + 1) },
  }));
  const file = dest();
  const r = await downloadDouyinVideo(d, PLAY_URL, file);
  assert.ok(!r.ok && r.code === 'video_too_large' && r.message.includes('预检'), JSON.stringify(r));
  assert.deepEqual(sleeps, []);
  await assert.rejects(stat(file), '预检拦截不写文件');
});

test('downloadDouyinVideo：流中途超上限 → video_too_large 断流并清残留', async () => {
  // 两段各 4 字节，maxBytes=5：第二段累计 8 > 5 触发断流
  const stream = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([1, 2, 3, 4])); c.enqueue(new Uint8Array([5, 6, 7, 8])); c.close(); },
  });
  const { d, sleeps } = deps(async () => new Response(stream, { status: 200 }));
  const file = dest();
  const r = await downloadDouyinVideo({ ...d, maxBytes: 5 }, PLAY_URL, file);
  assert.ok(!r.ok && r.code === 'video_too_large', JSON.stringify(r));
  assert.deepEqual(sleeps, [], '体积超限不是拦截，不退避');
  await assert.rejects(stat(file), '断流后清残留半文件');
});
