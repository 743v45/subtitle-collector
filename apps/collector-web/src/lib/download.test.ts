// download.ts 单测：Content-Disposition 双格式解析、数字头读取、downloadUrl 全链路
//（fetch 错误抛错带 server 文案 / 成功触发 <a download> / 头缺失回落 fallback 文件名）。
// 跑法：npx vitest run src/lib/download.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R2 | apiFetch 改造后 fetch spy 断言补第二参 undefined（无 token 透传形态） | 通过 | 2026-10-07 U-1 token 注入 |
// | R1 | parseContentDisposition（filename* UTF-8 中文 / 普通 filename / 引号 / 两者并存 / 空头） | 通过 | |
// | R2 | readCountHeader（数字/空/非数字/null） | 通过 | |
// | R3 | downloadUrl：成功下载（URL + 文件名 + count + 多头直读）；400 JSON 抛错带文案；非 JSON 错误体；无头回落 fallback | 通过 | mock fetch + createObjectURL + anchor click |
import { test, expect, vi, afterEach } from 'vitest';
import { downloadUrl, parseContentDisposition, readCountHeader } from './download';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── R1：parseContentDisposition ──

test('解析 filename*=UTF-8 形式：中文文件名百分号解码', () => {
  const h = "attachment; filename*=UTF-8''%E5%8E%9F%E6%96%99%E5%8C%85-20261004.zip";
  expect(parseContentDisposition(h)).toBe('原料包-20261004.zip');
});

test('解析普通 filename= 形式（含引号包裹与无引号两种）', () => {
  expect(parseContentDisposition('attachment; filename="videos-export.csv"')).toBe('videos-export.csv');
  expect(parseContentDisposition('attachment; filename=bundle.zip')).toBe('bundle.zip');
});

test('两种形式并存时 filename* 优先；只剩 filename* 非法编码时回落 filename=', () => {
  const both = "attachment; filename=fallback.csv; filename*=UTF-8''%E5%AF%BC%E5%87%BA.json";
  expect(parseContentDisposition(both)).toBe('导出.json');
  // %ZZ 非法编码 → decodeURIComponent 抛 → 回落普通分支
  const bad = "attachment; filename=fallback.csv; filename*=UTF-8''%ZZ";
  expect(parseContentDisposition(bad)).toBe('fallback.csv');
});

test('空头/无 filename 段 → null（调用方回落 fallback 文件名）', () => {
  expect(parseContentDisposition(null)).toBe(null);
  expect(parseContentDisposition('attachment')).toBe(null);
  expect(parseContentDisposition('')).toBe(null);
});

// ── R2：readCountHeader ──

test('readCountHeader：数字字符串 → number；空/非数字/null → undefined', () => {
  expect(readCountHeader('42')).toBe(42);
  expect(readCountHeader('0')).toBe(0);
  expect(readCountHeader('')).toBe(undefined);
  expect(readCountHeader('abc')).toBe(undefined);
  expect(readCountHeader(null)).toBe(undefined);
});

// ── R3：downloadUrl ──

// SubtitleView.test.tsx R4 同款 spy：jsdom 无 createObjectURL，defineProperty 覆盖 + click spy
function stubDownload() {
  const createObjectURL = vi.fn(() => 'blob:mock-url');
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return { createObjectURL, revokeObjectURL, clickSpy };
}

function fileResponse(headers: Record<string, string>): Response {
  return new Response('%PDF-fake', { status: 200, headers });
}

test('成功下载：请求 url、anchor.download 取 Content-Disposition 文件名、count 读 X-Export-Count、多头可直读、revoke 回收', async () => {
  const stubs = stubDownload();
  const fetchSpy = vi.fn(async () =>
    fileResponse({
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="videos-export.csv"',
      'x-export-count': '137',
      'x-bundle-total': '140',
      'x-bundle-exported': '137',
      'x-bundle-errors': '3',
    }),
  );
  vi.stubGlobal('fetch', fetchSpy);

  const r = await downloadUrl('/api/export/videos?format=csv', 'videos-export.csv');
  // apiFetch 无 token 时透传 (url, undefined) 两参——行为等价裸 fetch
  expect(fetchSpy).toHaveBeenCalledWith('/api/export/videos?format=csv', undefined);
  expect(r.filename).toBe('videos-export.csv');
  expect(r.count).toBe(137);
  // 多头场景（原料包三数）由调用方经 headers 直读
  expect(r.headers.get('x-bundle-total')).toBe('140');
  expect(r.headers.get('x-bundle-exported')).toBe('137');
  expect(r.headers.get('x-bundle-errors')).toBe('3');
  expect(stubs.clickSpy).toHaveBeenCalledTimes(1);
  expect((stubs.clickSpy.mock.instances[0] as HTMLAnchorElement).download).toBe('videos-export.csv');
  expect(stubs.createObjectURL).toHaveBeenCalledTimes(1);
  expect(stubs.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
});

test('HTTP 400 + JSON 错误体 → 抛错并带出 server 文案（对齐 ensureOk 风格）', async () => {
  stubDownload();
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ ok: false, error: 'limit must be <= 1000, got: 2000' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  ));
  await expect(downloadUrl('/api/export/bundle?limit=2000', 'bundle.zip')).rejects.toThrow(
    'HTTP 400：limit must be <= 1000, got: 2000',
  );
});

test('HTTP 500 + 非 JSON 错误体 → 抛错只带状态码', async () => {
  stubDownload();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
  await expect(downloadUrl('/api/export/videos', 'x.csv')).rejects.toThrow('HTTP 500');
});

test('响应无 Content-Disposition → 文件名回落 fallback；无 X-Export-Count → count 缺省', async () => {
  const stubs = stubDownload();
  vi.stubGlobal('fetch', vi.fn(async () => fileResponse({ 'content-type': 'application/zip' })));
  const r = await downloadUrl('/api/export/bundle', 'bundle.zip');
  expect(r.filename).toBe('bundle.zip');
  expect(r.count).toBe(undefined);
  expect((stubs.clickSpy.mock.instances[0] as HTMLAnchorElement).download).toBe('bundle.zip');
});
