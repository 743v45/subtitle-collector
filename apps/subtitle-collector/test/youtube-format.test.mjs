import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYoutubeJson3,
  parseYoutubeXml,
  normalizeYoutubeTimedtext,
  parseStatCount,
  parseYtPublishDateMs,
} from '../youtube-format.mjs';

// ---------------- parseStatCount ----------------
// YouTube 已从 videoDetails 移除 likeCount，点赞数仅 like 按钮 DOM 可见（textContent/aria-label）。
// parseStatCount 把这些显示串解析成整数：千分位 / 中文万·亿·萬 / 英文 K·M·B。

test('parseStatCount：纯数字 + 千分位逗号', () => {
  assert.equal(parseStatCount('6137'), 6137);
  assert.equal(parseStatCount('6,137'), 6137);
  assert.equal(parseStatCount('1,234,567'), 1234567);
});

test('parseStatCount：中文万/亿/萬', () => {
  assert.equal(parseStatCount('1.2万'), 12000);
  assert.equal(parseStatCount('1.2萬'), 12000);
  assert.equal(parseStatCount('3亿'), 300000000);
});

test('parseStatCount：英文 K/M/B', () => {
  assert.equal(parseStatCount('6.1K'), 6100);
  assert.equal(parseStatCount('1.2M'), 1200000);
  assert.equal(parseStatCount('2B'), 2000000000);
});

test('parseStatCount：aria-label 多语言长串（提取首个数字段）', () => {
  assert.equal(parseStatCount('与另外 6,137 人一起顶此视频'), 6137);
  assert.equal(parseStatCount('Liked by 1,234 people'), 1234);
});

test('parseStatCount：null/空/无数字 → null', () => {
  assert.equal(parseStatCount(null), null);
  assert.equal(parseStatCount(''), null);
  assert.equal(parseStatCount('顶此视频'), null);
});

test('parseStatCount：超大数字串（parseFloat → Infinity）→ null（防御分支）', () => {
  // 正则匹配到 400 位纯数字，parseFloat 溢出为 Infinity → !Number.isFinite → null
  assert.equal(parseStatCount('9'.repeat(400)), null);
});

// ---------------- parseYtPublishDateMs ----------------
// 回归 2026-08-22②：inject-yt extractMeta 此前不抽发布时间，content-yt 传的 publishedAt
// 恒 undefined、落库 published_at 恒 NULL。现从 microformat.playerMicroformatRenderer.publishDate
// （ISO 串）转毫秒（对齐 B 站 ingest-payload.js 的 pubdate×1000 口径）。

test('parseYtPublishDateMs：microformat publishDate ISO 串 → 毫秒纪元', () => {
  // 带时区偏移的完整 ISO（publishDate 常见形态）
  assert.equal(parseYtPublishDateMs('2009-10-25T06:57:33-07:00'), Date.parse('2009-10-25T06:57:33-07:00'));
  // 纯日期段（uploadDate 常见形态，按 UTC 零点）
  assert.equal(parseYtPublishDateMs('2009-10-25'), Date.parse('2009-10-25'));
  // Z 后缀
  assert.equal(parseYtPublishDateMs('2024-02-29T00:00:00Z'), Date.parse('2024-02-29T00:00:00Z'));
});

test('回归 2026-08-22②：parseYtPublishDateMs 缺失/非串/不可解析 → null（不发明值）', () => {
  assert.equal(parseYtPublishDateMs(null), null);
  assert.equal(parseYtPublishDateMs(undefined), null);
  assert.equal(parseYtPublishDateMs(''), null);
  assert.equal(parseYtPublishDateMs('   '), null);
  assert.equal(parseYtPublishDateMs(1700000000000), null); // 非字符串（防误传毫秒值直通）
  assert.equal(parseYtPublishDateMs('not a date'), null);
  // dateText 类本地化人读串（中文界面）不可靠解析 → null；inject-yt 也不采集 dateText（只取 ISO 的 publishDate/uploadDate）
  assert.equal(parseYtPublishDateMs('2009年10月25日'), null);
});

// ---------------- parseYoutubeJson3 ----------------

test('parseYoutubeJson3：标准多 event → 正确 cue 数组（from/to/content）', () => {
  const json3 = {
    events: [
      { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'Hello' }, { utf8: 'world' }] },
      { tStartMs: 5000, dDurationMs: 3000, segs: [{ utf8: '!' }] },
    ],
  };
  assert.deepEqual(parseYoutubeJson3(json3), {
    body: [
      { from: 0, to: 5, content: 'Hello world' },
      { from: 5, to: 8, content: '!' },
    ],
  });
});

test('parseYoutubeJson3：JSON 字符串入参与对象等价', () => {
  const str = JSON.stringify({
    events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'hi' }] }],
  });
  assert.deepEqual(parseYoutubeJson3(str), {
    body: [{ from: 1, to: 3, content: 'hi' }],
  });
});

test('parseYoutubeJson3：空 events 数组 → {body:[]}', () => {
  assert.deepEqual(parseYoutubeJson3({ events: [] }), { body: [] });
});

test('parseYoutubeJson3：缺 events 字段 → {body:[]}', () => {
  assert.deepEqual(parseYoutubeJson3({}), { body: [] });
});

test('parseYoutubeJson3：单个 event 多 segs 拼接（join 单空格 + trim）', () => {
  const json3 = {
    events: [
      {
        tStartMs: 0,
        dDurationMs: 5000,
        segs: [{ utf8: 'Hello' }, { utf8: 'world' }, { utf8: '!' }],
      },
    ],
  };
  assert.equal(parseYoutubeJson3(json3).body[0].content, 'Hello world !');
});

test('parseYoutubeJson3：含 tOffsetMs 词级偏移被忽略（cue 级聚合）', () => {
  const json3 = {
    events: [
      {
        tStartMs: 1000,
        dDurationMs: 4000,
        segs: [
          { utf8: 'Hello', tOffsetMs: 0 },
          { utf8: 'world', tOffsetMs: 500 },
        ],
      },
    ],
  };
  const cue = parseYoutubeJson3(json3).body[0];
  assert.equal(cue.from, 1);
  assert.equal(cue.to, 5);
  assert.equal(cue.content, 'Hello world');
});

test('parseYoutubeJson3：缺失 dDurationMs → to=from', () => {
  const json3 = { events: [{ tStartMs: 2000, segs: [{ utf8: 'x' }] }] };
  const cue = parseYoutubeJson3(json3).body[0];
  assert.equal(cue.from, 2);
  assert.equal(cue.to, 2);
});

test('parseYoutubeJson3：event 无 segs 被跳过', () => {
  const json3 = {
    events: [
      { tStartMs: 0, dDurationMs: 1000 },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'ok' }] },
    ],
  };
  const body = parseYoutubeJson3(json3).body;
  assert.equal(body.length, 1);
  assert.equal(body[0].content, 'ok');
});

test('parseYoutubeJson3：segs 中无 utf8 的片段被过滤', () => {
  const json3 = {
    events: [
      {
        tStartMs: 0,
        dDurationMs: 1000,
        segs: [{ utf8: 'keep' }, { tOffsetMs: 100 }, { utf8: 'this' }],
      },
    ],
  };
  assert.equal(parseYoutubeJson3(json3).body[0].content, 'keep this');
});

test('parseYoutubeJson3：null/undefined/空串 → {body:[]}', () => {
  for (const empty of [null, undefined, '']) {
    assert.deepEqual(parseYoutubeJson3(empty), { body: [] });
  }
});

test('parseYoutubeJson3：非法 JSON 字符串 → {body:[]}（pot 受限/截断兜底）', () => {
  assert.deepEqual(parseYoutubeJson3('{not json'), { body: [] });
  assert.deepEqual(parseYoutubeJson3('   '), { body: [] });
});

test('parseYoutubeJson3：非对象入参（数字/JSON 解析出字符串）→ {body:[]}', () => {
  assert.deepEqual(parseYoutubeJson3(123), { body: [] });          // 数字直入
  assert.deepEqual(parseYoutubeJson3('"str"'), { body: [] });      // 合法 JSON 但解析结果是 string
  assert.deepEqual(parseYoutubeJson3(true), { body: [] });         // 布尔直入
});

test('parseYoutubeJson3：events 含非对象项被跳过（null/字符串/数字）', () => {
  const json3 = {
    events: [null, 'str', 42, { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'ok' }] }],
  };
  const body = parseYoutubeJson3(json3).body;
  assert.equal(body.length, 1);
  assert.equal(body[0].content, 'ok');
});

test('parseYoutubeJson3：tStartMs 缺失/非数 → from 兜底 0', () => {
  assert.equal(parseYoutubeJson3({ events: [{ dDurationMs: 1000, segs: [{ utf8: 'a' }] }] }).body[0].from, 0);
  assert.equal(parseYoutubeJson3({ events: [{ tStartMs: 'x', segs: [{ utf8: 'b' }] }] }).body[0].from, 0);
  assert.equal(parseYoutubeJson3({ events: [{ tStartMs: NaN, segs: [{ utf8: 'c' }] }] }).body[0].from, 0);
});

// ---------------- parseYoutubeXml ----------------

test('parseYoutubeXml：标准 transcript → 正确 cue（start/dur 秒制）', () => {
  const xml =
    '<transcript><text start="0.0" dur="5.0">Hello world</text><text start="5.0" dur="3.0">!</text></transcript>';
  assert.deepEqual(parseYoutubeXml(xml), {
    body: [
      { from: 0, to: 5, content: 'Hello world' },
      { from: 5, to: 8, content: '!' },
    ],
  });
});

test('parseYoutubeXml：HTML 实体解码（&amp; &#39; &lt; &gt; &quot; &apos;）', () => {
  const xml =
    '<transcript><text start="0" dur="1">A &amp; B &#39;C&#39; &lt;tag&gt; &quot;q&quot; &apos;s</text></transcript>';
  assert.equal(parseYoutubeXml(xml).body[0].content, 'A & B \'C\' <tag> "q" \'s');
});

test('parseYoutubeXml：十六进制数字实体 &#x27; → 单引号', () => {
  const xml = '<transcript><text start="0" dur="1">it&#x27;s</text></transcript>';
  assert.equal(parseYoutubeXml(xml).body[0].content, "it's");
});

test('parseYoutubeXml：缺 dur → to=from', () => {
  const xml = '<transcript><text start="3.5">no dur</text></transcript>';
  const cue = parseYoutubeXml(xml).body[0];
  assert.equal(cue.from, 3.5);
  assert.equal(cue.to, 3.5);
});

test('parseYoutubeXml：换行文本保留（仅 trim 首尾空白）', () => {
  const xml = '<transcript><text start="0" dur="1">  line1\nline2  </text></transcript>';
  assert.equal(parseYoutubeXml(xml).body[0].content, 'line1\nline2');
});

test('parseYoutubeXml：带 XML 声明/多 text 节点正常解析', () => {
  const xml =
    '<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0" dur="1">a</text><text start="1" dur="1">b</text></transcript>';
  const body = parseYoutubeXml(xml).body;
  assert.equal(body.length, 2);
  assert.deepEqual(body[0], { from: 0, to: 1, content: 'a' });
  assert.deepEqual(body[1], { from: 1, to: 2, content: 'b' });
});

test('parseYoutubeXml：无 text 节点 → {body:[]}', () => {
  assert.deepEqual(parseYoutubeXml('<transcript></transcript>'), { body: [] });
});

test('parseYoutubeXml：null/undefined/空串/纯空白 → {body:[]}', () => {
  for (const empty of [null, undefined, '', '   ']) {
    assert.deepEqual(parseYoutubeXml(empty), { body: [] });
  }
});

test('parseYoutubeXml：未知命名实体原样保留（&nbsp; 不在白名单）', () => {
  const xml = '<transcript><text start="0" dur="1">a&nbsp;b &unknownent; c</text></transcript>';
  assert.equal(parseYoutubeXml(xml).body[0].content, 'a&nbsp;b &unknownent; c');
});

test('parseYoutubeXml：越界码点数字实体原样保留（&#1114112; > 0x10FFFF）', () => {
  const xml = '<transcript><text start="0" dur="1">&#1114112;</text></transcript>';
  assert.equal(parseYoutubeXml(xml).body[0].content, '&#1114112;');
});

test('parseYoutubeXml：start/dur 非数字或空串 → toNumberOrNull null 兜底', () => {
  // start="abc"：Number 非有限 → null → from 兜底 0
  assert.equal(parseYoutubeXml('<transcript><text start="abc" dur="2">x</text></transcript>').body[0].from, 0);
  // start=""：空串 → null → from 0
  assert.equal(parseYoutubeXml('<transcript><text start="" dur="2">x</text></transcript>').body[0].from, 0);
  // dur 非数字 → to=from（dur null）
  const cue = parseYoutubeXml('<transcript><text start="1" dur="abc">y</text></transcript>').body[0];
  assert.equal(cue.to, cue.from);
  assert.equal(cue.from, 1);
});

test('parseYoutubeXml：<text> 无属性 / 空内容 → attrs 与 content 兜底仍产出条目', () => {
  const body = parseYoutubeXml('<transcript><text>no attrs</text><text start="1"></text></transcript>').body;
  assert.equal(body.length, 2);
  // 无 attrs → start/dur 均 null → from=0, to=0；content 空串
  assert.deepEqual(body[0], { from: 0, to: 0, content: 'no attrs' });
  assert.equal(body[1].content, ''); // 空内容的 text 节点
});

// ---------------- normalizeYoutubeTimedtext ----------------

test('normalizeYoutubeTimedtext：fmt=json3 走 json3 解析', () => {
  const raw = JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }],
  });
  assert.deepEqual(normalizeYoutubeTimedtext(raw, 'json3'), {
    body: [{ from: 0, to: 1, content: 'hi' }],
  });
});

test('normalizeYoutubeTimedtext：fmt=xml 走 xml 解析', () => {
  const raw = '<transcript><text start="0" dur="1">hi</text></transcript>';
  assert.deepEqual(normalizeYoutubeTimedtext(raw, 'xml'), {
    body: [{ from: 0, to: 1, content: 'hi' }],
  });
});

test('normalizeYoutubeTimedtext：fmt=null 嗅探 { → json3', () => {
  const raw = JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'x' }] }],
  });
  assert.equal(normalizeYoutubeTimedtext(raw, null).body[0].content, 'x');
});

test('normalizeYoutubeTimedtext：fmt=null 嗅探 < → xml', () => {
  const raw = '<transcript><text start="0" dur="1">y</text></transcript>';
  assert.equal(normalizeYoutubeTimedtext(raw, null).body[0].content, 'y');
});

test('normalizeYoutubeTimedtext：fmt=null 对象入参按 json3 处理', () => {
  const obj = { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'obj' }] }] };
  assert.equal(normalizeYoutubeTimedtext(obj, null).body[0].content, 'obj');
});

test('normalizeYoutubeTimedtext：fmt=null 带前导空白仍能嗅探', () => {
  const raw = '   \n  {"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"p"}]}]}';
  assert.equal(normalizeYoutubeTimedtext(raw, null).body[0].content, 'p');
});

test('normalizeYoutubeTimedtext：null/空入参（任意 fmt）→ {body:[]}', () => {
  for (const empty of [null, undefined, '']) {
    assert.deepEqual(normalizeYoutubeTimedtext(empty, 'json3'), { body: [] });
    assert.deepEqual(normalizeYoutubeTimedtext(empty, 'xml'), { body: [] });
    assert.deepEqual(normalizeYoutubeTimedtext(empty, null), { body: [] });
  }
});

test('normalizeYoutubeTimedtext：fmt=null 无法嗅探的内容 → {body:[]}', () => {
  assert.deepEqual(normalizeYoutubeTimedtext('plain text no structure', null), { body: [] });
});

test('normalizeYoutubeTimedtext：非串非对象入参（数字/布尔）→ {body:[]}', () => {
  assert.deepEqual(normalizeYoutubeTimedtext(123, null), { body: [] });
  assert.deepEqual(normalizeYoutubeTimedtext(123, 'json3'), { body: [] });
  assert.deepEqual(normalizeYoutubeTimedtext(false, null), { body: [] });
});

// ---------------- 产物与 subtitleFormat 串联（契约 Y1：可直接喂下游） ----------------

test('产物可直接喂 subtitleFormat：json3 → extractCues/subtitleToSRT 正确', async () => {
  const { extractCues, subtitleToSRT, subtitleToPlainText } = await import('../subtitleFormat.mjs');
  const normalized = parseYoutubeJson3({
    events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello' }] },
      { tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: 'world' }] },
    ],
  });
  assert.deepEqual(extractCues(normalized), normalized.body);
  const srt = subtitleToSRT(normalized);
  assert.ok(srt.includes('00:00:00,000 --> 00:00:02,000'), srt);
  assert.ok(srt.includes('00:00:02,000 --> 00:00:03,500'), srt);
  assert.ok(srt.includes('Hello') && srt.includes('world'), srt);
  assert.equal(subtitleToPlainText(normalized), 'Hello\nworld');
});

test('产物可直接喂 subtitleFormat：xml → SRT 含解码后的实体', async () => {
  const { subtitleToSRT } = await import('../subtitleFormat.mjs');
  const normalized = parseYoutubeXml(
    '<transcript><text start="0" dur="1">A &amp; B</text></transcript>',
  );
  const srt = subtitleToSRT(normalized);
  assert.ok(srt.includes('A & B'), srt);
});
