import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertSubtitle, type SubtitleFormat } from './subtitleFormat.js';

// 用 info/body.json（B 站真实字幕样本）作为输入
const here = dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(readFileSync(join(here, '../../../../info/body.json'), 'utf-8')) as {
  body: Array<{ from: number; to: number; content: string }>;
};
const bodyLen = payload.body.length;
const firstContent = payload.body[0].content.trim();

// 标准时间戳行正则（仅时间戳，不含序号 —— SRT 序号在上一行）
const srtStamp = /\d{2}:\d{2}:\d{2},\d{3}/; // SRT：逗号毫秒
const vttStamp = /\d{2}:\d{2}:\d{2}\.\d{3}/; // VTT：小数点毫秒
const srtLine = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/;

test('json: 可往返（parse 回来 deepEqual 原 payload）', () => {
  const out = convertSubtitle(payload, 'json');
  assert.deepEqual(JSON.parse(out), payload);
});

test('json: 不校验 body 结构（任意对象也原样美化）', () => {
  const obj = { hello: 'world', n: [1, 2, 3] };
  assert.equal(convertSubtitle(obj, 'json'), JSON.stringify(obj, null, 2));
});

test('srt: 头部序号 + 时间戳 + content，逗号毫秒', () => {
  const out = convertSubtitle(payload, 'srt');
  // 第一块：1 + 00:00:00,360 --> 00:00:02,560 + 第一句字幕
  // payload.body[0] = { from: 0.36, to: 2.56, content: "前几期我一直在讲AI编程工程化" }
  assert.ok(
    out.startsWith(`1\n00:00:00,360 --> 00:00:02,560\n${firstContent}`),
    `srt 头块不符: ${out.slice(0, 80)}`,
  );
});

test('srt: 末尾换行 + 块数等于 body 长度', () => {
  const out = convertSubtitle(payload, 'srt');
  assert.ok(out.endsWith('\n'));
  // 去掉末尾 \n 后按空行切块；每块首行是序号
  const blocks = out.replace(/\n$/, '').split('\n\n');
  assert.equal(blocks.length, bodyLen);
  blocks.forEach((blk, i) => {
    const lines = blk.split('\n');
    assert.equal(lines[0], String(i + 1), `第 ${i + 1} 块序号不对`);
    assert.match(lines[1], srtLine, `第 ${i + 1} 块时间戳行不符`);
  });
});

test('srt: 分钟/小时段进位正确（取一条 from>60s 的验证）', () => {
  // body 中存在 from=124.82（sid 53），应渲染成 00:02:04,820
  const item = payload.body.find((b) => Math.abs(b.from - 124.82) < 1e-6);
  if (item) {
    const out = convertSubtitle({ body: [item] }, 'srt');
    assert.ok(out.includes('00:02:04,820 -->'), `分钟进位出错: ${out}`);
  }
});

test('vtt: WEBVTT 头 + 小数点毫秒时间戳', () => {
  const out = convertSubtitle(payload, 'vtt');
  assert.ok(out.startsWith('WEBVTT\n'), `vtt 缺 WEBVTT 头: ${out.slice(0, 40)}`);
  // 紧接头后是第一个 cue：00:00:00.360 --> 00:00:02.560
  assert.ok(
    out.startsWith(`WEBVTT\n\n00:00:00.360 --> 00:00:02.560\n${firstContent}`),
    `vtt 头 cue 不符: ${out.slice(0, 80)}`,
  );
});

test('vtt: cue 数等于 body 长度，时间戳全用小数点', () => {
  const out = convertSubtitle(payload, 'vtt');
  assert.ok(out.endsWith('\n'));
  const parts = out.replace(/\n$/, '').split('\n\n');
  assert.equal(parts.length, bodyLen + 1); // 首段是 WEBVTT
  assert.equal(parts[0], 'WEBVTT');
  // 每个 cue 第一行匹配 vtt 时间戳
  for (let i = 1; i < parts.length; i++) {
    const firstLine = parts[i].split('\n')[0];
    assert.match(firstLine, /^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/, `cue ${i} 时间戳: ${firstLine}`);
  }
  // 全文不应出现 SRT 风格的逗号毫秒
  assert.ok(!srtStamp.test(out), 'vtt 误用逗号毫秒');
});

test('txt: 仅 content 每条一行，无时间戳无 WEBVTT 头', () => {
  const out = convertSubtitle(payload, 'txt');
  assert.ok(out.endsWith('\n'));
  const lines = out.replace(/\n$/, '').split('\n');
  assert.equal(lines[0], firstContent);
  // 该样本所有 content 非空 → 行数等于 body 长度
  assert.equal(lines.length, bodyLen);
  // 不含时间戳和序号
  assert.ok(!srtStamp.test(out));
  assert.ok(!vttStamp.test(out));
  assert.ok(!out.includes('WEBVTT'));
});

test('txt: 跳过空 content 条目', () => {
  const out = convertSubtitle(
    { body: [{ from: 0, to: 1, content: '   ' }, { from: 1, to: 2, content: 'a' }] },
    'txt',
  );
  assert.equal(out, 'a\n');
});

test('错误：null / 非对象 → 抛清晰错误', () => {
  assert.throws(() => convertSubtitle(null, 'srt'), /body 字段/);
  assert.throws(() => convertSubtitle(undefined, 'srt'), /body 字段/);
  assert.throws(() => convertSubtitle('字符串', 'srt'), /body 字段/);
});

test('错误：缺 body / body 非数组 / 空数组 → 抛清晰错误', () => {
  assert.throws(() => convertSubtitle({}, 'srt'), /body 字段/);
  assert.throws(() => convertSubtitle({ body: 'x' }, 'srt'), /非空数组/);
  assert.throws(() => convertSubtitle({ body: [] }, 'srt'), /非空数组/);
});

test('错误：body 条目缺字段或类型错 → 抛清晰错误', () => {
  assert.throws(() => convertSubtitle({ body: [{ from: 0, to: 1 }] }, 'srt'), /content/);
  assert.throws(
    () => convertSubtitle({ body: [{ from: 'x', to: 1, content: 'a' }] }, 'srt'),
    /from\/to/,
  );
  assert.throws(
    () => convertSubtitle({ body: [{ from: 0, to: 1, content: 123 }] }, 'vtt'),
    /content/,
  );
  assert.throws(() => convertSubtitle({ body: [null] }, 'txt'), /不是对象/);
});

test('负 from/to 归零（不抛、不渲染负时间）', () => {
  const out = convertSubtitle({ body: [{ from: -1.5, to: 1, content: 'x' }] }, 'srt');
  assert.ok(out.includes('00:00:00,000 --> 00:00:01,000'), `负值未归零: ${out}`);
});

test('所有 SubtitleFormat 值都能产出非空字符串', () => {
  const formats: SubtitleFormat[] = ['json', 'srt', 'vtt', 'txt'];
  for (const f of formats) {
    const out = convertSubtitle(payload, f);
    assert.ok(out.length > 0, `${f} 输出为空`);
  }
});
