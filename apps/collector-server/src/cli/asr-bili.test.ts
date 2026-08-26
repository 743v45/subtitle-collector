// asr-bili.ts 纯函数测试：B 站响应解析族 + segments→cues 映射。
//
// 测试轮次记录表（对齐全局规则）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | parseBiliJson×5 + parseViewCid×3 + parsePlayurlAudio×3 + wbiKeysFromNav×2 + segmentsToCues×3 | 通过 | |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBiliJson, parseViewCid, parsePlayurlAudio,
  wbiKeysFromNav, isRiskControl,
} from './asr-bili.js';
import { buildPlayurlQuery } from './wbi.js';
import { segmentsToCues } from './subtitleFormat.js';

const WBI_IMG = '7cd084941338484aae1ad9425b84077c';
const WBI_SUB = '4932caff0ff746eab6f01bf08b70ac45';

test('parseBiliJson：code 0 → data；-101/-412 分类；畸形体/其他码透传', () => {
  assert.deepEqual(parseBiliJson({ code: 0, data: { x: 1 } }), { ok: true, data: { x: 1 } });
  assert.deepEqual(parseBiliJson({ code: -101 }), { ok: false, code: 'need_login', message: 'cookie 失效或未登录' });
  assert.deepEqual(parseBiliJson({ code: -412 }), { ok: false, code: 'risk_control', message: '请求被风控（-412）' });
  assert.deepEqual(parseBiliJson(null), { ok: false, code: 'malformed', message: 'non-json or missing code' });
  assert.deepEqual(parseBiliJson({ code: 'x' }), { ok: false, code: 'malformed', message: 'non-json or missing code' }, 'code 非数字也 malformed');
  assert.deepEqual(parseBiliJson({ code: 62002, message: '稿件不可见' }), { ok: false, code: 'bili_62002', message: '稿件不可见' });
});

test('parseViewCid：正常（含多 P 计数）；缺 cid / 缺 duration → error', () => {
  assert.deepEqual(parseViewCid({ cid: 123, duration: 60, pages: [{}, {}] }), { cid: 123, part_count: 2, duration: 60 });
  assert.deepEqual(parseViewCid({ cid: 123, duration: 60 }), { cid: 123, part_count: 1, duration: 60 });
  assert.equal('error' in parseViewCid({ duration: 60 }), true, '缺 cid 应 error');
  assert.equal('error' in parseViewCid({ cid: 123 }), true, '缺 duration 应 error');
});

test('parsePlayurlAudio：dash 首选 / durl 单段兜底（kind 区分）/ durl 多段与全无 → error', () => {
  assert.deepEqual(parsePlayurlAudio({ dash: { audio: [{ baseUrl: 'https://upos.m4s', id: 30280 }] } }), { base_url: 'https://upos.m4s', id: 30280, kind: 'dash' });
  // 2026-08-26 实测形态：账号 playurl 被降级到 durl（FLV/MP4 音视频合一）
  assert.deepEqual(parsePlayurlAudio({ durl: [{ url: 'https://upos.flv' }] }), { base_url: 'https://upos.flv', id: -1, kind: 'durl' });
  const multi = parsePlayurlAudio({ durl: [{ url: 'a' }, { url: 'b' }] });
  assert.equal('error' in multi && multi.error.includes('2 段'), true, '多段 durl 报可观察错误');
  assert.equal('error' in parsePlayurlAudio({ dash: {} }), true, '无 audio 应 error');
  const r = parsePlayurlAudio({ dash: { audio: [] } });
  assert.equal('error' in r && r.error.includes('dash.audio.length=0'), true, 'error 带命中计数（可观察性）');
});

test('buildPlayurlQuery：固定 keys 得已签名 query（含 w_rid，参数集正确）', () => {
  const q = buildPlayurlQuery('BV1xx', 456, WBI_IMG, WBI_SUB);
  assert.match(q, /^bvid=BV1xx&cid=456&fnval=16&fnver=0&qn=64&wts=\d+&w_rid=[0-9a-f]{32}$/);
});

test('wbiKeysFromNav：吃 nav 的 data 层抽 keys；风控畸形 data → 空串（判空信号）', () => {
  assert.deepEqual(
    wbiKeysFromNav({ wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${WBI_IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${WBI_SUB}.png` } }),
    { img_key: WBI_IMG, sub_key: WBI_SUB },
  );
  assert.deepEqual(wbiKeysFromNav({}), { img_key: '', sub_key: '' });
});

test('segmentsToCues：正常映射；剔空文本/非法时段/非对象；非数组 → []', () => {
  const segs = [
    { id: 1, start: 0, end: 2.5, text: '句一' },
    { id: 2, start: 2.6, end: 5, text: '  ' },       // 空文本 → 剔
    { id: 3, start: 5, end: 4, text: '倒置' },       // end ≤ start → 剔
    { id: 4, start: 6, end: 8, text: '句二' },
  ];
  assert.deepEqual(segmentsToCues(segs), [
    { from: 0, to: 2.5, content: '句一' },
    { from: 6, to: 8, content: '句二' },
  ]);
  assert.deepEqual(segmentsToCues([{ id: 1, start: 'x', end: 2, text: 't' }]), [], '类型不符 → 剔');
  assert.deepEqual(segmentsToCues('not array'), []);
});

test('isRiskControl：risk_control / bili_-412 判风控，其余非', () => {
  assert.equal(isRiskControl({ ok: false, code: 'risk_control' }), true);
  assert.equal(isRiskControl({ ok: false, code: 'bili_-412' }), true);
  assert.equal(isRiskControl({ ok: false, code: 'need_login' }), false);
  assert.equal(isRiskControl({ ok: true, code: '' }), false);
});
