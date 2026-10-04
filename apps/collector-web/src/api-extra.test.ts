// api-extra.ts 单测：Phase 1/3 端点封装（字幕检索/补翻/server 状态/补翻写回/采集编排）的 URL 组装与解包。
// 与 api.test.ts 同范式：stubGlobal fetch 后直调真实函数，锁请求形状；ensureOk 分支由
// api.test.ts（共享 api-core）覆盖，这里只锁各端点自己的 query/body/解析。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | subSearch 三例 + translatePending 两例 + translateSource 两例 + getServerStatus 透传 | 通过 | 2026-10 自 api.test.ts 随封装搬家（api.ts 台账拆分） |
// | R2 | translateFill 两例 + collectSearch 两例 + seasonPreview 两例 + refreshUpperInfo 两例 | 通过 | 2026-10 Phase 3 采集编排/补翻写回封装（契约对齐 collect-proxy.ts） |
import { test, expect, vi, afterEach } from 'vitest';
import { subSearch, translatePending, translateSource, getServerStatus, translateFill, collectSearch, seasonPreview, refreshUpperInfo } from './api-extra';

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}
function httpErr(status: number, body: unknown = ''): Response {
  return typeof body === 'string'
    ? new Response(body, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => {
  fetchMock.mockReset();
});

function lastCall(): { url: string; init?: RequestInit } {
  const c = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: String(c[0]), init: c[1] as RequestInit | undefined };
}

// ── 字幕检索 ──

test('subSearch：仅 keyword → query 只带 keyword', async () => {
  fetchMock.mockResolvedValueOnce(ok({ keyword: 'x', regex: false, matched_videos: 0, total_snippets: 0, truncated: false, items: [] }));
  await subSearch({ keyword: '加息' });
  expect(lastCall().url).toBe('/api/sub-search?keyword=%E5%8A%A0%E6%81%AF');
});

test('subSearch：全量参数 → 逐项进 query；items 缺失回落 []', async () => {
  fetchMock.mockResolvedValueOnce(ok({ keyword: 'x', regex: true, matched_videos: 0, total_snippets: 0, truncated: false }));
  await expect(
    subSearch({
      keyword: 'fed', regex: true, caseSensitive: true, ctx: 20, source: 'youtube', creator: 'UP',
      since: 1, until: 2, maxSnippetsPerVideo: 5, maxSnippets: 50, maxVideos: 20,
    }),
  ).resolves.toEqual({ keyword: 'x', regex: true, matched_videos: 0, total_snippets: 0, truncated: false, items: [] });
  const q = new URL(lastCall().url, 'http://x/').searchParams;
  expect(q.get('keyword')).toBe('fed');
  expect(q.get('regex')).toBe('1');
  expect(q.get('case_sensitive')).toBe('1');
  expect(q.get('ctx')).toBe('20');
  expect(q.get('source')).toBe('youtube');
  expect(q.get('creator')).toBe('UP');
  expect(q.get('since')).toBe('1');
  expect(q.get('until')).toBe('2');
  expect(q.get('max_snippets_per_video')).toBe('5');
  expect(q.get('max_snippets')).toBe('50');
  expect(q.get('max_videos')).toBe('20');
});

test('subSearch：400 非法正则 → HTTP 状态文案直出', async () => {
  fetchMock.mockResolvedValueOnce(httpErr(400, { error: '非法正则: ([' }));
  await expect(subSearch({ keyword: '([' })).rejects.toThrow('HTTP 400：非法正则: ([');
});

// ── 补翻 ──

test('translatePending：默认分页参数必发；items/total 缺失回落', async () => {
  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(translatePending()).resolves.toEqual({ total: 0, page: 1, size: 20, items: [] });
  expect(lastCall().url).toBe('/api/translate/pending?page=1&size=20');
});

test('translatePending：筛选/排序全量进 query', async () => {
  fetchMock.mockResolvedValueOnce(ok({ total: 1, page: 2, size: 50, items: [{ source: 'bilibili' }] }));
  await expect(
    translatePending({ source: 'douyin', from: 'en', creator: 'UP', page: 2, size: 50, sort: 'published_at', asc: true }),
  ).resolves.toEqual({ total: 1, page: 2, size: 50, items: [{ source: 'bilibili' }] });
  const q = new URL(lastCall().url, 'http://x/').searchParams;
  expect(q.get('source')).toBe('douyin');
  expect(q.get('from')).toBe('en');
  expect(q.get('creator')).toBe('UP');
  expect(q.get('page')).toBe('2');
  expect(q.get('size')).toBe('50');
  expect(q.get('sort')).toBe('published_at');
  expect(q.get('asc')).toBe('1');
});

test('translateSource：from 进 query；vid 编码；无 from 无问号', async () => {
  fetchMock.mockResolvedValueOnce(ok({ source: 'bilibili', source_vid: 'BV 1', lan: 'en', version_id: 3, lines: [{ line: 1, text: 'hi' }], text: '1\thi' }));
  await expect(translateSource('bilibili', 'BV 1', 'en')).resolves.toEqual({
    source: 'bilibili', source_vid: 'BV 1', lan: 'en', version_id: 3, lines: [{ line: 1, text: 'hi' }], text: '1\thi',
  });
  expect(lastCall().url).toBe('/api/translate/source/bilibili/BV%201?from=en');

  fetchMock.mockResolvedValueOnce(ok({ source: 'bilibili', source_vid: 'BV 1', lan: 'en', version_id: 3, lines: [], text: '' }));
  await translateSource('bilibili', 'BV 1');
  expect(lastCall().url).toBe('/api/translate/source/bilibili/BV%201');
});

test('translateSource：404 无该轨 → HTTP 状态文案直出', async () => {
  fetchMock.mockResolvedValueOnce(httpErr(404, { error: '没有 en 轨' }));
  await expect(translateSource('bilibili', 'BV1', 'en')).rejects.toThrow('HTTP 404：没有 en 轨');
});

// ── server 状态 ──

test('getServerStatus：/api/status 透传六字段', async () => {
  const payload = {
    version: '0.5.0',
    uptime_s: 3661,
    config: { host: '127.0.0.1', port: 8080, auth_required: true, token_configured: true, allowed_hosts: '*' },
    db_path: '/data/collector.db',
    online_clients: 2,
    counts: { videos: 10, creators: 3, tracks: 20, versions: 30, collect_tasks: 5 },
  };
  fetchMock.mockResolvedValueOnce(ok(payload));
  await expect(getServerStatus()).resolves.toEqual(payload);
  expect(lastCall().url).toBe('/api/status');
});

// ── 补翻写回（Phase 3）──

test('translateFill：POST body 四字段直传；成功解包 lan/lines/zh_manual_versions_before', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: true, source: 'bilibili', source_vid: 'BV1x', from_lan: 'en', lan: 'zh-manual', lines: 2, zh_manual_versions_before: 1 }));
  await expect(
    translateFill({ source: 'bilibili', source_vid: 'BV1x', from_lan: 'en', lines: ['你好', '世界'] }),
  ).resolves.toEqual({ source: 'bilibili', source_vid: 'BV1x', from_lan: 'en', lan: 'zh-manual', lines: 2, zh_manual_versions_before: 1 });
  expect(lastCall().url).toBe('/api/translate/fill');
  expect(lastCall().init?.method).toBe('POST');
  expect(JSON.parse(String(lastCall().init?.body))).toEqual({ source: 'bilibili', source_vid: 'BV1x', from_lan: 'en', lines: ['你好', '世界'] });
});

test('translateFill：行数不符 400 → expected/got 进错误文案直出', async () => {
  fetchMock.mockResolvedValueOnce(httpErr(400, { ok: false, error: '译文行数不符: 源字幕 2 行, 收到 3 行', expected: 2, got: 3, hint: '空译文行保留占位不可省略' }));
  await expect(translateFill({ source: 'bilibili', source_vid: 'BV1x', from_lan: 'en', lines: ['a', 'b', 'c'] })).rejects.toThrow('HTTP 400：译文行数不符: 源字幕 2 行, 收到 3 行');
});

// ── 采集编排（Phase 3）──

test('collectSearch：bilibili → sinceDays 映射 since_days、tid 透传；items/total 解包', async () => {
  fetchMock.mockResolvedValueOnce(ok({
    ok: true, source: 'bilibili', keyword: '加息', client_id: 'c1', total: 1,
    items: [{ bvid: 'BV1', title: 't', up: 'u', exists: true, has_subtitle: true }],
  }));
  await expect(collectSearch({ source: 'bilibili', keyword: '加息', tid: 21 })).resolves.toEqual({
    source: 'bilibili', keyword: '加息', client_id: 'c1', total: 1,
    items: [{ bvid: 'BV1', title: 't', up: 'u', exists: true, has_subtitle: true }],
    raw_total: null, pages_fetched: null, since_days: null, since_filtered: 0,
  });
  expect(lastCall().url).toBe('/api/collect-search');
  expect(JSON.parse(String(lastCall().init?.body))).toEqual({ source: 'bilibili', keyword: '加息', order: undefined, pages: undefined, since_days: undefined, tid: 21 });
});

test('collectSearch：youtube → order/pages/sinceDays 进 body；回执 youtube 计数字段透传', async () => {
  fetchMock.mockResolvedValueOnce(ok({
    ok: true, source: 'youtube', keyword: 'fed', client_id: 'c1',
    raw_total: 20, pages_fetched: 2, since_days: 30, since_filtered: 5, total: 15,
    items: [{ vid: 'yt1', title: 't', exists: false, has_subtitle: false }],
  }));
  await expect(
    collectSearch({ source: 'youtube', keyword: 'fed', order: 'newest', pages: 2, sinceDays: 30 }),
  ).resolves.toMatchObject({ total: 15, items: [{ vid: 'yt1' }], since_filtered: 5 });
  expect(JSON.parse(String(lastCall().init?.body))).toEqual({ source: 'youtube', keyword: 'fed', order: 'newest', pages: 2, since_days: 30, tid: undefined });
});

test('collectSearch：无在线扩展 503 → HTTP 文案直出（UI 层改写为扩展离线指引）', async () => {
  fetchMock.mockResolvedValueOnce(httpErr(503, { ok: false, error: 'no online client（扩展未连接）' }));
  await expect(collectSearch({ source: 'bilibili', keyword: 'x' })).rejects.toThrow('HTTP 503：no online client（扩展未连接）');
});

test('seasonPreview：arg 进 POST body；season/items 解包', async () => {
  fetchMock.mockResolvedValueOnce(ok({
    ok: true, season: { id: 123, mid: 9 }, client_id: 'c1', total: 2,
    items: [{ bvid: 'BVa', exists: true, has_subtitle: true }, { bvid: 'BVb', exists: false, has_subtitle: false }],
  }));
  await expect(seasonPreview({ arg: '123' })).resolves.toEqual({
    season: { id: 123, mid: 9 }, client_id: 'c1', total: 2,
    items: [{ bvid: 'BVa', exists: true, has_subtitle: true }, { bvid: 'BVb', exists: false, has_subtitle: false }],
  });
  expect(lastCall().url).toBe('/api/season/preview');
  expect(JSON.parse(String(lastCall().init?.body))).toEqual({ arg: '123' });
});

test('seasonPreview：BV 未采过 404 → HTTP 文案直出', async () => {
  fetchMock.mockResolvedValueOnce(httpErr(404, { ok: false, error: 'BV 未采集过,库内无合集归属——先采集 BV1z 单个视频，或直接传合集 id / 合集页链接' }));
  await expect(seasonPreview({ arg: 'BV1z' })).rejects.toThrow('HTTP 404：BV 未采集过');
});

test('refreshUpperInfo：mid 进 POST body；creator 对象透传', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: true, client_id: 'c1', creator: { name: '某UP', mid: 42, fans: 12345 } }));
  await expect(refreshUpperInfo({ mid: '42' })).resolves.toEqual({ client_id: 'c1', creator: { name: '某UP', mid: 42, fans: 12345 } });
  expect(lastCall().url).toBe('/api/upper-info/refresh');
  expect(JSON.parse(String(lastCall().init?.body))).toEqual({ mid: '42' });
});

test('refreshUpperInfo：creator 缺失回落空对象（宽松透传不炸 UI）', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: true, client_id: 'c1' }));
  await expect(refreshUpperInfo({ mid: '42' })).resolves.toEqual({ client_id: 'c1', creator: {} });
});
