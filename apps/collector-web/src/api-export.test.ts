// 导出端点 URL 构造纯函数测试（api-export.ts；对应 server http/export.ts 三端点契约）
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildExportBundleUrl, buildExportSubtitleUrl, buildExportVideosUrl } from './api-export.ts';
import { videoListStateToFilter, type VideoListQueryState } from './videoFilterUrl.ts';

const DEFAULTS: VideoListQueryState = {
  q: '', sq: '', source: '', tname: '', tags: [], tagSource: '', lang: '',
  hasSubtitle: false, dateField: 'first_seen',
  sinceDate: '', untilDate: '', minDur: '', maxDur: '', minView: '', maxView: '',
  sort: undefined, desc: true, page: 1,
};

// ── buildExportVideosUrl ──

test('exportVideos：空筛选 + 缺省 format → 仅 format=json 一参', () => {
  assert.equal(buildExportVideosUrl({}), '/api/export/videos?format=json');
});

test('exportVideos：全量筛选透传（snake_case 同 listVideos 口径；page/size 不导出）', () => {
  const url = buildExportVideosUrl(
    videoListStateToFilter({
      ...DEFAULTS,
      q: '标题词', sq: '字幕词', source: 'youtube', tname: '科技', tags: ['游戏', '评测'], tagSource: 'manual',
      lang: 'zh', hasSubtitle: true, dateField: 'published_at',
      sinceDate: '2026-01-01', untilDate: '2026-01-31', minDur: '5', maxDur: '10', minView: '2', maxView: '3',
      sort: 'duration', desc: false, page: 7,
    }),
    'csv',
  );
  const p = new URL(url, 'http://x').searchParams;
  assert.equal(url.startsWith('/api/export/videos?'), true);
  assert.equal(p.get('format'), 'csv');
  assert.equal(p.get('q'), '标题词');
  assert.equal(p.get('subtitle_q'), '字幕词');
  assert.equal(p.get('tags'), '游戏,评测');
  assert.equal(p.get('tag_source'), 'manual');
  assert.equal(p.get('has_subtitle'), 'true');
  assert.equal(p.get('since'), String(new Date('2026-01-01T00:00:00').getTime()));
  assert.equal(p.get('min_duration'), '300'); // 分钟 → 秒
  assert.equal(p.get('min_view'), '20000');   // 万 → 绝对值
  assert.equal(p.get('sort'), 'duration');
  assert.equal(p.get('desc'), 'false');       // 升序显式发
  // 导出是全量拉取：page/size 不出现在 URL
  assert.equal(p.has('page'), false);
  assert.equal(p.has('size'), false);
});

test('exportVideos：desc 定义即显式写出（true/false 都发；仅 undefined 省略走 server 缺省降序）', () => {
  assert.equal(new URL(buildExportVideosUrl({ desc: false }), 'http://x').searchParams.get('desc'), 'false');
  assert.equal(new URL(buildExportVideosUrl({ desc: true }), 'http://x').searchParams.get('desc'), 'true');
  assert.equal(new URL(buildExportVideosUrl({}), 'http://x').searchParams.has('desc'), false);
});

// ── buildExportSubtitleUrl ──

test('exportSubtitle：无 opts → 干净路径无 query（server 缺省轨/版本/srt）', () => {
  assert.equal(buildExportSubtitleUrl('bilibili', 'BV1xxx'), '/api/export/subtitle/bilibili/BV1xxx');
});

test('exportSubtitle：中文 vid 百分号编码；全参数展开', () => {
  assert.equal(
    buildExportSubtitleUrl('bilibili', 'BV中文'),
    '/api/export/subtitle/bilibili/BV%E4%B8%AD%E6%96%87',
  );
  assert.equal(
    buildExportSubtitleUrl('bilibili', 'BV1x', { track: 12, version: 121, format: 'vtt' }),
    '/api/export/subtitle/bilibili/BV1x?track=12&version=121&format=vtt',
  );
});

test('exportSubtitle：track/version 为 0 等 falsy 数也正确写出（ != null 判空而非真值判断）', () => {
  assert.equal(
    new URL(buildExportSubtitleUrl('bilibili', 'BV1x', { track: 0, version: 0 }), 'http://x').searchParams.get('track'),
    '0',
  );
});

// ── buildExportBundleUrl ──

test('exportBundle：空筛选 + 无 opts → 裸路径（limit 走 server 缺省 500、名序走 CLI 缺省）', () => {
  assert.equal(buildExportBundleUrl({}), '/api/export/bundle');
});

test('exportBundle：limit/name_order/track + 筛选参数齐全', () => {
  const p = new URL(
    buildExportBundleUrl(videoListStateToFilter({ ...DEFAULTS, source: 'douyin', sq: '关键词' }), {
      limit: 200, nameOrder: 'id,name,time', track: 'ai-ZH',
    }),
    'http://x',
  ).searchParams;
  assert.equal(p.get('source'), 'douyin');
  assert.equal(p.get('subtitle_q'), '关键词');
  assert.equal(p.get('limit'), '200');
  assert.equal(p.get('name_order'), 'id,name,time');
  assert.equal(p.get('track'), 'ai-ZH');
});

test('exportBundle：opts 为 0 值不写出（limit=0/空串交由 server 校验或走缺省）', () => {
  assert.equal(buildExportBundleUrl({}, { limit: undefined, nameOrder: '', track: '' }), '/api/export/bundle');
});
