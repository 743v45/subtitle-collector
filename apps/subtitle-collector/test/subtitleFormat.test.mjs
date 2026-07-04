import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBTITLE_FORMATS,
  extractCues,
  subtitleToPlainText,
  subtitleToTimestamped,
  subtitleToSRT,
  formatSubtitle,
} from '../subtitleFormat.mjs';

test('SUBTITLE_FORMATS 常量稳定', () => {
  assert.deepEqual(SUBTITLE_FORMATS, ['text', 'timestamp', 'srt']);
});

const standardBody = {
  body: [
    { from: 0, to: 2.5, content: '大家好' },
    { from: 2.5, to: 5, content: '今天天气' },
  ],
  font_size: 0.4,
};

test('subtitleToPlainText：标准 body → 换行拼接', () => {
  assert.equal(subtitleToPlainText(standardBody), '大家好\n今天天气');
});

test('subtitleToTimestamped：from:0 → [00:00] 大家好', () => {
  assert.equal(
    subtitleToTimestamped({ body: [{ from: 0, to: 2.5, content: '大家好' }] }),
    '[00:00] 大家好',
  );
});

test('subtitleToTimestamped：from:65 → [01:05] xxx', () => {
  assert.equal(
    subtitleToTimestamped({ body: [{ from: 65, to: 70, content: 'xxx' }] }),
    '[01:05] xxx',
  );
});

test('subtitleToSRT：含序号 / 时间轴 / 块间空行', () => {
  const out = subtitleToSRT(standardBody);
  assert.ok(out.startsWith('1\n'), '序号从 1 开始');
  assert.ok(out.includes('00:00:00,000 --> 00:00:02,500'), '第一块时间轴');
  assert.ok(out.includes('00:00:02,500 --> 00:00:05,000'), '第二块时间轴');
  assert.ok(out.includes('大家好'), '第一块 content');
  // 块之间额外空一行：大家好 与 2 之间是 \n\n
  assert.ok(out.includes('大家好\n\n2\n'), '块间空行');
  assert.ok(out.endsWith('今天天气\n'), '文末换行');
});

test('subtitleToSRT：from:3661.5 → 起始 01:01:01,500', () => {
  const out = subtitleToSRT({ body: [{ from: 3661.5, to: 3663, content: '跨小时' }] });
  assert.ok(out.startsWith('1\n01:01:01,500 --> '), '跨小时时间格式');
});

test('空 body：三函数都返回空串', () => {
  for (const empty of [{}, { body: [] }, null, undefined]) {
    assert.equal(subtitleToPlainText(empty), '');
    assert.equal(subtitleToTimestamped(empty), '');
    assert.equal(subtitleToSRT(empty), '');
  }
});

test('空白 content 条目被过滤（content: "  " 不出现在输出）', () => {
  const body = { body: [{ from: 0, to: 1, content: '  ' }, { from: 1, to: 2, content: '有效' }] };
  assert.equal(subtitleToPlainText(body), '有效');
  assert.equal(subtitleToTimestamped(body), '[00:01] 有效');
  assert.equal(subtitleToSRT(body), '1\n00:00:01,000 --> 00:00:02,000\n有效\n');
});

test('from 缺失：按时间 0 处理', () => {
  const body = { body: [{ to: 2, content: '无from' }] };
  assert.equal(subtitleToTimestamped(body), '[00:00] 无from');
  assert.equal(subtitleToSRT(body), '1\n00:00:00,000 --> 00:00:02,000\n无from\n');
});

test('to 缺失：SRT 结束时间用 from', () => {
  const body = { body: [{ from: 3, content: '无to' }] };
  assert.equal(subtitleToSRT(body), '1\n00:00:03,000 --> 00:00:03,000\n无to\n');
});

test('非标准输入（直接传数组）：extractCues 兜底，三函数正常输出', () => {
  const arr = [
    { from: 0, to: 1, content: '甲' },
    { from: 1, to: 2, content: '乙' },
  ];
  assert.deepEqual(extractCues(arr), arr);
  assert.equal(subtitleToPlainText(arr), '甲\n乙');
  assert.equal(subtitleToTimestamped(arr), '[00:00] 甲\n[00:01] 乙');
  assert.ok(subtitleToSRT(arr).includes('1\n00:00:00,000 --> 00:00:01,000\n甲'));
});

test('formatSubtitle：按 fmt 分发', () => {
  const body = { body: [{ from: 0, to: 2.5, content: '大家好' }] };
  assert.equal(formatSubtitle(body, 'text'), subtitleToPlainText(body));
  assert.equal(formatSubtitle(body, 'timestamp'), subtitleToTimestamped(body));
  assert.equal(formatSubtitle(body, 'srt'), subtitleToSRT(body));
});

test('formatSubtitle：未知 fmt 返回空串', () => {
  assert.equal(formatSubtitle({ body: [{ from: 0, content: 'x' }] }, 'nope'), '');
});

test('负数/NaN from：兜底为 0（不产生 "-01:-05" / "NaN:NaN"）', () => {
  assert.equal(subtitleToTimestamped({ body: [{ from: -5, to: 1, content: 'x' }] }), '[00:00] x');
  assert.equal(subtitleToTimestamped({ body: [{ from: NaN, to: 1, content: 'y' }] }), '[00:00] y');
  assert.ok(
    subtitleToSRT({ body: [{ from: -5, to: 1, content: 'x' }] }).startsWith('1\n00:00:00,000 --> '),
  );
});

test('毫秒封顶 999（2.9995 不产生 ,1000 非法 SRT）', () => {
  const out = subtitleToSRT({ body: [{ from: 2.9995, to: 4, content: 'm' }] });
  assert.ok(out.includes('00:00:02,999 --> '), `期望 ,999 实际 ${out}`);
});

test('to < from：SRT 时间轴原样反映数据（格式层不强制纠正）', () => {
  const out = subtitleToSRT({ body: [{ from: 5, to: 2, content: '倒' }] });
  assert.ok(out.includes('00:00:05,000 --> 00:00:02,000'), out);
});

test('非 ASCII content（中文/emoji）保留', () => {
  const body = { body: [{ from: 0, to: 1, content: '中文🎉 tests' }] };
  assert.equal(subtitleToPlainText(body), '中文🎉 tests');
  assert.equal(subtitleToTimestamped(body), '[00:00] 中文🎉 tests');
});
