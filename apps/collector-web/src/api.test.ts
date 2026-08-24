// api.ts fetch 封装层单测：URL/方法/body 组装 + ensureOk 错误分支 + 各端点解包。
// 不 mock api 模块本身——stubGlobal fetch 后直接调真实函数，锁住请求形状与解析行为。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | ensureOk 四分支 + 全端点 URL 组装/解包 | 通过 | 204 须 null body（jsdom Response 限制），删除类端点回 {} |
// | R2 | setTaskDispatch（2026-08-23 仅上报状态） | 通过 | 与 setReporting 同构 |
import { test, expect, vi, afterEach } from 'vitest';
import * as api from './api';
import type { VideoDetail } from './types';

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

// ── ensureOk 错误分支 ──

test('非 2xx 且带 JSON error → 抛「HTTP 状态：error 文案」', async () => {
  fetchMock.mockResolvedValueOnce(httpErr(503, { error: '扩展离线：无已连接客户端' }));
  await expect(api.listClients()).rejects.toThrow('HTTP 503：扩展离线：无已连接客户端');
});

test('非 2xx 且 JSON 无 error 字段 → 回落裸状态码', async () => {
  fetchMock.mockResolvedValueOnce(httpErr(500, { foo: 1 }));
  await expect(api.listClients()).rejects.toThrow('HTTP 500');
});

test('非 2xx 且响应非 JSON → 回落裸状态码（catch 忽略）', async () => {
  fetchMock.mockResolvedValueOnce(httpErr(502, '<html>Bad Gateway</html>'));
  await expect(api.listClients()).rejects.toThrow('HTTP 502');
});

test('2xx 但 json.ok===false 带 error → 抛 json.error', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: false, error: '任务不存在' }));
  await expect(api.getCollectTask(9)).rejects.toThrow('任务不存在');
});

test('2xx 但 json.ok===false 无 error → 抛回落「API error」', async () => {
  fetchMock.mockResolvedValueOnce(ok({ ok: false }));
  await expect(api.getCollectTask(9)).rejects.toThrow('API error');
});

test('2xx 但 body 非 JSON → r.json() 抛 SyntaxError 上抛', async () => {
  fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
  await expect(api.listClients()).rejects.toThrow();
});

test('网络层抛错 → 原样上抛', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(api.listClients()).rejects.toThrow('Failed to fetch');
});

// ── 视频 ──

test('listVideos：空 filter → 仅默认分页参数', async () => {
  fetchMock.mockResolvedValueOnce(ok({ total: 0, items: [] }));
  await api.listVideos();
  expect(lastCall().url).toBe('/api/videos?page=1&size=20');
});

test('listVideos：全量 filter → 逐参数写入 query', async () => {
  fetchMock.mockResolvedValueOnce(ok({ total: 1, items: [] }));
  await api.listVideos({
    q: '关键词', source: 'youtube', tid: 22, tname: '鬼畜', tag: '单标签',
    tags: ['a', 'b'], tag_source: ['manual', 'ai'], subtitle_q: '字幕词', lang: 'zh',
    has_subtitle: true, since: 1000, until: 2000, min_duration: 30, max_duration: 600,
    creator_id: 7, min_view: 10, max_view: 99, date_field: 'published_at',
    sort: 'view', desc: true, page: 3, size: 50,
  });
  const u = new URL(lastCall().url, 'http://x/');
  const q = u.searchParams;
  expect(u.pathname).toBe('/api/videos');
  expect(q.get('q')).toBe('关键词');
  expect(q.get('source')).toBe('youtube');
  expect(q.get('tid')).toBe('22');
  expect(q.get('tname')).toBe('鬼畜');
  expect(q.get('tag')).toBe('单标签');
  expect(q.get('tags')).toBe('a,b');
  expect(q.get('tag_source')).toBe('manual,ai');
  expect(q.get('subtitle_q')).toBe('字幕词');
  expect(q.get('lang')).toBe('zh');
  expect(q.get('has_subtitle')).toBe('true');
  expect(q.get('since')).toBe('1000');
  expect(q.get('until')).toBe('2000');
  expect(q.get('min_duration')).toBe('30');
  expect(q.get('max_duration')).toBe('600');
  expect(q.get('creator_id')).toBe('7');
  expect(q.get('min_view')).toBe('10');
  expect(q.get('max_view')).toBe('99');
  expect(q.get('date_field')).toBe('published_at');
  expect(q.get('sort')).toBe('view');
  expect(q.get('desc')).toBe('true');
  expect(q.get('page')).toBe('3');
  expect(q.get('size')).toBe('50');
});

test('getVideo：extra JSON 字符串 → 解析成对象；sourceVid 编码', async () => {
  const extra = { tid: 22, tname: '科技', stat: { view: 100 } };
  fetchMock.mockResolvedValueOnce(ok({ video: { title: 't', extra: JSON.stringify(extra) }, tracks: [], tag_details: [] }));
  const d: VideoDetail = await api.getVideo('bilibili', 'BV1/abc');
  expect(lastCall().url).toBe('/api/videos/bilibili/BV1%2Fabc');
  expect((d.video.extra as Record<string, unknown>)?.tname).toBe('科技');
});

test('getVideo：extra 非法 JSON 字符串 → 落回空对象', async () => {
  fetchMock.mockResolvedValueOnce(ok({ video: { title: 't', extra: '{oops' }, tracks: [] }));
  const d = await api.getVideo('bilibili', 'BV1');
  expect(d.video.extra).toEqual({});
});

test('getVideo：extra 非字符串（null）→ 原样透传', async () => {
  fetchMock.mockResolvedValueOnce(ok({ video: { title: 't', extra: null }, tracks: [] }));
  const d = await api.getVideo('bilibili', 'BV1');
  expect(d.video.extra).toBeNull();
});

test('getVersion：透传 j', async () => {
  const payload = { version: { id: 5, origin: 'api', payload: { body: [] }, captured_at: 1 } };
  fetchMock.mockResolvedValueOnce(ok(payload));
  await expect(api.getVersion(5)).resolves.toEqual(payload);
  expect(lastCall().url).toBe('/api/versions/5');
});

// ── change_log / 统计 ──

test('getChanges：entity + 分页参数', async () => {
  fetchMock.mockResolvedValueOnce(ok({ total: 2, items: [{ id: 1 }] }));
  await expect(api.getChanges({ entity: 'video', page: 2, size: 30 })).resolves.toEqual({ total: 2, items: [{ id: 1 }] });
  expect(lastCall().url).toBe('/api/changes?entity=video&page=2&size=30');
});

test('getChanges：entity 省略 + items 缺失回落 []', async () => {
  fetchMock.mockResolvedValueOnce(ok({ total: 0 }));
  await expect(api.getChanges({})).resolves.toEqual({ total: 0, items: [] });
  expect(lastCall().url).toBe('/api/changes?page=1&size=20');
});

test('getStatsOverview：解包 total + by_source（2026-08-24 分平台形状）', async () => {
  fetchMock.mockResolvedValueOnce(ok({ total: { videos: 3 }, by_source: { bilibili: { videos: 3 } } }));
  await expect(api.getStatsOverview()).resolves.toEqual({ total: { videos: 3 }, by_source: { bilibili: { videos: 3 } } });
  expect(lastCall().url).toBe('/api/stats?type=overview');
});

test('getStatsAggregate：groupBy + 筛选 + topN；items 缺失回落 []', async () => {
  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.getStatsAggregate('lang', { q: 'x', tag: 't', tname: 'tn' }, 10)).resolves.toEqual([]);
  const q = new URL(lastCall().url, 'http://x/').searchParams;
  expect(q.get('type')).toBe('aggregate');
  expect(q.get('groupBy')).toBe('lang');
  expect(q.get('q')).toBe('x');
  expect(q.get('tag')).toBe('t');
  expect(q.get('tname')).toBe('tn');
  expect(q.get('topN')).toBe('10');
});

// ── 客户端 / 采集任务 ──

test('listClients：解包 clients', async () => {
  fetchMock.mockResolvedValueOnce(ok({ clients: [{ client_id: 'c1' }] }));
  await expect(api.listClients()).resolves.toEqual([{ client_id: 'c1' }]);
});

test('createCollectTask：POST {text}，解包 task', async () => {
  fetchMock.mockResolvedValueOnce(ok({ task: { id: 1, status: 'pending' } }));
  const t = await api.createCollectTask('分享文本');
  expect(t.id).toBe(1);
  const { url, init } = lastCall();
  expect(url).toBe('/api/collect-tasks');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ text: '分享文本' });
});

test('listCollectTasks：limit 进 query，total/items 回落', async () => {
  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.listCollectTasks(5)).resolves.toEqual({ total: 0, items: [] });
  expect(lastCall().url).toBe('/api/collect-tasks?limit=5');
});

test('listCollectTasksPage：分页 + 全量筛选映射到 query', async () => {
  fetchMock.mockResolvedValueOnce(ok({ total: 1, items: [{ id: 2 }] }));
  await api.listCollectTasksPage(3, 50, {
    status: ['failed', 'limited'], source: 'youtube', batchId: 'b1', batchScope: 'batch',
    creator: 'U 主', creatorUid: '42', q: 'kw', since: 100, until: 200,
  });
  const q = new URL(lastCall().url, 'http://x/').searchParams;
  expect(q.get('page')).toBe('3');
  expect(q.get('page_size')).toBe('50');
  expect(q.get('status')).toBe('failed,limited');
  expect(q.get('source')).toBe('youtube');
  expect(q.get('batch_id')).toBe('b1');
  expect(q.get('batch')).toBe('batch');
  expect(q.get('creator')).toBe('U 主');
  expect(q.get('creator_uid')).toBe('42');
  expect(q.get('q')).toBe('kw');
  expect(q.get('since')).toBe('100');
  expect(q.get('until')).toBe('200');
});

test('listCollectTasksPage：空 filter → 仅分页', async () => {
  fetchMock.mockResolvedValueOnce(ok({ total: 0, items: [] }));
  await api.listCollectTasksPage(1, 20);
  expect(lastCall().url).toBe('/api/collect-tasks?page=1&page_size=20');
});

test('getCollectTask：解包 task', async () => {
  fetchMock.mockResolvedValueOnce(ok({ task: { id: 7 } }));
  await expect(api.getCollectTask(7)).resolves.toEqual({ id: 7 });
});

test('deleteCollectTask：DELETE 且失败上抛（await 不吞）', async () => {
  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.deleteCollectTask(3)).resolves.toBeUndefined();
  const { url, init } = lastCall();
  expect(url).toBe('/api/collect-tasks/3');
  expect(init?.method).toBe('DELETE');

  fetchMock.mockResolvedValueOnce(httpErr(404, { error: '不存在' }));
  await expect(api.deleteCollectTask(4)).rejects.toThrow('HTTP 404：不存在');
});

test('expandUpperVideos：POST {mid}，total/items 回落', async () => {
  fetchMock.mockResolvedValueOnce(ok({ items: [{ bvid: 'BV1' }] }));
  await expect(api.expandUpperVideos('123')).resolves.toEqual({ total: 0, items: [{ bvid: 'BV1' }] });
  const { url, init } = lastCall();
  expect(url).toBe('/api/upper-videos/expand');
  expect(JSON.parse(String(init?.body))).toEqual({ mid: '123' });
});

test('createCollectTasksBatch：带 creatorUid 进 body', async () => {
  fetchMock.mockResolvedValueOnce(ok({ created: 2, skipped: 1 }));
  await expect(api.createCollectTasksBatch(['a', 'b'], 'bilibili', '42')).resolves.toEqual({ created: 2, skipped: 1 });
  expect(JSON.parse(String(lastCall().init?.body))).toEqual({ vids: ['a', 'b'], source: 'bilibili', creator_uid: '42' });
});

test('createCollectTasksBatch：无 creatorUid 不写该键，回落 0', async () => {
  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.createCollectTasksBatch(['a'], 'youtube')).resolves.toEqual({ created: 0, skipped: 0 });
  expect(JSON.parse(String(lastCall().init?.body))).toEqual({ vids: ['a'], source: 'youtube' });
});

test('retryCollectTasks：POST {ids}，retried/tasks 回落', async () => {
  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.retryCollectTasks([1, 2])).resolves.toEqual({ retried: 0, tasks: [] });
  expect(JSON.parse(String(lastCall().init?.body))).toEqual({ ids: [1, 2] });
});

// ── 设置 ──

test('getCollectTimeout / setCollectTimeout', async () => {
  fetchMock.mockResolvedValueOnce(ok({ bilibili: 90000, youtube: 45000 }));
  await expect(api.getCollectTimeout()).resolves.toEqual({ bilibili: 90000, youtube: 45000 });
  expect(lastCall().url).toBe('/api/settings/collect-timeout');

  fetchMock.mockResolvedValueOnce(ok({ bilibili: 60000, youtube: 30000 }));
  await expect(api.setCollectTimeout({ bilibili: 60000, youtube: 30000 })).resolves.toEqual({ bilibili: 60000, youtube: 30000 });
  const { init } = lastCall();
  expect(init?.method).toBe('PUT');
  expect(JSON.parse(String(init?.body))).toEqual({ bilibili: 60000, youtube: 30000 });
});

test('setReporting：clientId 编码 + body {enabled}', async () => {
  fetchMock.mockResolvedValueOnce(ok({ reporting_enabled: false }));
  await expect(api.setReporting('client/1', false)).resolves.toBe(false);
  const { url, init } = lastCall();
  expect(url).toBe('/api/clients/client%2F1/reporting');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
});

test('setTaskDispatch：clientId 编码 + body {enabled}', async () => {
  fetchMock.mockResolvedValueOnce(ok({ task_dispatch_enabled: false }));
  await expect(api.setTaskDispatch('client/1', false)).resolves.toBe(false);
  const { url, init } = lastCall();
  expect(url).toBe('/api/clients/client%2F1/task-dispatch');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
});

// ── 分类 ──

test('listCategories：无 scope 不带 query；带 scope 落 query；items 回落', async () => {
  fetchMock.mockResolvedValueOnce(ok({ items: [{ id: 1, name: 'a' }] }));
  await expect(api.listCategories()).resolves.toEqual([{ id: 1, name: 'a' }]);
  expect(lastCall().url).toBe('/api/categories');

  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.listCategories('human')).resolves.toEqual([]);
  expect(lastCall().url).toBe('/api/categories?scope=human');
});

test('createCategory / updateCategory：解包 category', async () => {
  fetchMock.mockResolvedValueOnce(ok({ category: { id: 1, name: '新', scope: 'agent' } }));
  await expect(api.createCategory('新', 'agent')).resolves.toEqual({ id: 1, name: '新', scope: 'agent' });
  expect(JSON.parse(String(lastCall().init?.body))).toEqual({ name: '新', scope: 'agent' });

  fetchMock.mockResolvedValueOnce(ok({ category: { id: 1, name: '改' } }));
  await expect(api.updateCategory(1, { name: '改', sort_order: 2 })).resolves.toEqual({ id: 1, name: '改' });
  const { url, init } = lastCall();
  expect(url).toBe('/api/categories/1');
  expect(init?.method).toBe('PATCH');
  expect(JSON.parse(String(init?.body))).toEqual({ name: '改', sort_order: 2 });
});

test('deleteCategory：DELETE 且失败上抛', async () => {
  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.deleteCategory(5)).resolves.toBeUndefined();
  expect(lastCall().url).toBe('/api/categories/5');
  expect(lastCall().init?.method).toBe('DELETE');

  fetchMock.mockResolvedValueOnce(httpErr(400, { error: 'x' }));
  await expect(api.deleteCategory(6)).rejects.toThrow('HTTP 400：x');
});

// ── 标签 ──

test('listTags：source/q/topN（默认 500）；items 回落', async () => {
  fetchMock.mockResolvedValueOnce(ok({ items: [{ id: 1, name: 't' }] }));
  await expect(api.listTags({ source: 'manual', q: '键' })).resolves.toEqual([{ id: 1, name: 't' }]);
  const q = new URL(lastCall().url, 'http://x/').searchParams;
  expect(q.get('source')).toBe('manual');
  expect(q.get('q')).toBe('键');
  expect(q.get('topN')).toBe('500');

  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.listTags({ topN: 3 })).resolves.toEqual([]);
  expect(new URL(lastCall().url, 'http://x/').searchParams.get('topN')).toBe('3');
});

test('applyTags / removeTags：POST body 原样', async () => {
  fetchMock.mockResolvedValueOnce(ok({ inserted: 2, missing: 1 }));
  const body = { items: [{ source: 'bilibili', source_vid: 'BV1' }], names: ['a', 'b'], source: 'manual' as const };
  await expect(api.applyTags(body)).resolves.toEqual({ inserted: 2, missing: 1 });
  expect(JSON.parse(String(lastCall().init?.body))).toEqual(body);

  fetchMock.mockResolvedValueOnce(ok({ removed: 3, missing: 0 }));
  const rbody = { items: body.items, names: ['a'], source: 'ai' as const };
  await expect(api.removeTags(rbody)).resolves.toEqual({ removed: 3, missing: 0 });
  expect(JSON.parse(String(lastCall().init?.body))).toEqual(rbody);
});

test('renameTag：PATCH {name}，解包 tag', async () => {
  fetchMock.mockResolvedValueOnce(ok({ tag: { id: 9, name: '新名' } }));
  await expect(api.renameTag(9, '新名')).resolves.toEqual({ id: 9, name: '新名' });
  const { url, init } = lastCall();
  expect(url).toBe('/api/tags/9');
  expect(init?.method).toBe('PATCH');
  expect(JSON.parse(String(init?.body))).toEqual({ name: '新名' });
});

test('deleteTag：DELETE 且失败上抛', async () => {
  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.deleteTag(9)).resolves.toBeUndefined();
  expect(lastCall().url).toBe('/api/tags/9');
  expect(lastCall().init?.method).toBe('DELETE');

  fetchMock.mockResolvedValueOnce(httpErr(409, { error: '占用中' }));
  await expect(api.deleteTag(9)).rejects.toThrow('HTTP 409：占用中');
});

test('getTagPriority / putTagPriority', async () => {
  fetchMock.mockResolvedValueOnce(ok({ priority: ['manual', 'ai'] }));
  await expect(api.getTagPriority()).resolves.toEqual(['manual', 'ai']);
  expect(lastCall().url).toBe('/api/settings/tag-priority');

  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.putTagPriority(['ai', 'manual'])).resolves.toBeUndefined();
  const { init } = lastCall();
  expect(init?.method).toBe('PUT');
  expect(JSON.parse(String(init?.body))).toEqual({ priority: ['ai', 'manual'] });
});

test('videoApplyTags：POST body {names, scope}，解包 inserted', async () => {
  fetchMock.mockResolvedValueOnce(ok({ inserted: 4 }));
  await expect(api.videoApplyTags('bilibili', 'BV 1', ['x'], 'batch')).resolves.toEqual({ inserted: 4 });
  const { url, init } = lastCall();
  expect(url).toBe('/api/videos/bilibili/BV%201/tags');
  expect(JSON.parse(String(init?.body))).toEqual({ names: ['x'], scope: 'batch' });
});

test('videoRemoveTags：scope 可选进 query，解包 removed', async () => {
  fetchMock.mockResolvedValueOnce(ok({ removed: 1 }));
  await expect(api.videoRemoveTags('youtube', 'abc', 'x')).resolves.toEqual({ removed: 1 });
  expect(lastCall().url).toBe('/api/videos/youtube/abc/tags?name=x');

  fetchMock.mockResolvedValueOnce(ok({ removed: 2 }));
  await expect(api.videoRemoveTags('youtube', 'abc', 'x', 'manual')).resolves.toEqual({ removed: 2 });
  expect(lastCall().url).toBe('/api/videos/youtube/abc/tags?name=x&scope=manual');
});

// ── UP 主 ──

test('listCreators：筛选 + 默认分页；total/items 回落', async () => {
  fetchMock.mockResolvedValueOnce(ok({ total: 1, items: [{ id: 1 }] }));
  await api.listCreators({ q: '名', category: '科技', scope: 'agent', sort: 'fans', page: 2, size: 10 });
  const q = new URL(lastCall().url, 'http://x/').searchParams;
  expect(q.get('q')).toBe('名');
  expect(q.get('category')).toBe('科技');
  expect(q.get('scope')).toBe('agent');
  expect(q.get('sort')).toBe('fans');
  expect(q.get('page')).toBe('2');
  expect(q.get('size')).toBe('10');

  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.listCreators({})).resolves.toEqual({ total: 0, items: [] });
  expect(lastCall().url).toBe('/api/creators?page=1&size=20');
});

test('getCreatorDetail：解包 creator', async () => {
  fetchMock.mockResolvedValueOnce(ok({ creator: { id: 3, name: 'U' } }));
  await expect(api.getCreatorDetail(3)).resolves.toEqual({ id: 3, name: 'U' });
  expect(lastCall().url).toBe('/api/creators/3');
});

test('setCreatorCategory：平台段 + uid 编码 + body {scope,name}；失败上抛', async () => {
  fetchMock.mockResolvedValueOnce(ok({}));
  await expect(api.setCreatorCategory('bilibili', '42', 'agent', '科技')).resolves.toBeUndefined();
  const { url, init } = lastCall();
  expect(url).toBe('/api/creators/by-uid/bilibili/42/category');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ scope: 'agent', name: '科技' });

  fetchMock.mockResolvedValueOnce(httpErr(400, { error: '分类不存在' }));
  await expect(api.setCreatorCategory('youtube', 'UC%20x', 'human', '无')).rejects.toThrow('HTTP 400：分类不存在');
  expect(lastCall().url).toBe('/api/creators/by-uid/youtube/UC%2520x/category');
});
