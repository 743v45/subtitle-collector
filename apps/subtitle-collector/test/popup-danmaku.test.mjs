// test/popup-danmaku.test.mjs
// 测 popup 弹幕查看/一键复制的根目录纯逻辑模块 popup-danmaku.mjs（2026-10-07 弹幕采集树进
// popup，用户现场指令「popup 也要同步支持复制」）。该模块在 c8 口径内（--include '*.mjs'），
// 锁定线 99/99/98/99 全仓最严——负值/--:--/空内容等分支在此测满。
// 消费方：src/popup/hooks-danmaku.ts（fetch /api/danmaku/list）+ src/popup/DanmakuCard.tsx
//（折叠行 + 复制按钮 + 展开列表逐条渲染）。措辞红线：弹幕=时间轴弹幕，字幕=语音转写，不混用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { danmakuCopyStats, formatClock, formatDanmakuCopy, formatDanmakuLines } from '../popup-danmaku.mjs';

// 测试轮次记录（对齐项目 CLAUDE.md §3 / RULES §5）
// | 轮次 | 日期       | 范围                                                    | 结果 | 备注                                              |
// |------|------------|---------------------------------------------------------|------|---------------------------------------------------|
// | T1   | 2026-10-07 | formatClock 各档+边界 / formatDanmakuCopy 全分支 / stats | PASS | 随 popup 弹幕卡落盘；`node --test test/popup-danmaku.test.mjs` + c8 全绿 |
// | T2   | 2026-10-07 | formatDanmakuLines 全分支 + 与 copy 同口径回归            | PASS | 弹幕卡展开列表（用户现场指令「默认折叠+定高滚动」）；formatDanmakuCopy 重构复用 lines，单测全绿 |

// ---- formatClock：毫秒 → [MM:SS] / [H:MM:SS] 时间戳 ----

test('formatClock：0ms → 00:00', () => {
  assert.equal(formatClock(0), '00:00');
});

test('formatClock：秒档（1s）→ 00:01', () => {
  assert.equal(formatClock(1000), '00:01');
});

// 边界：59.9s floor 到 59s，不进位到下一分
test('formatClock：59.9s 边界 → 00:59（floor 不进位）', () => {
  assert.equal(formatClock(59900), '00:59');
});

// 边界：整 60s 进位到分；分位两位补零
test('formatClock：60s → 01:00', () => {
  assert.equal(formatClock(60000), '01:00');
});

// 边界：3599s（差 1s 一小时）仍是 MM:SS 形态
test('formatClock：3599s → 59:59', () => {
  assert.equal(formatClock(3599000), '59:59');
  assert.equal(formatClock(3599999), '59:59');
});

// 边界：整 3600s 进位小时，小时位不补零
test('formatClock：3600s → 1:00:00（H:MM:SS，小时不补零）', () => {
  assert.equal(formatClock(3600000), '1:00:00');
  assert.equal(formatClock(3661000), '1:01:01');
});

// null/undefined/非数 → 未定位占位 --:--（B 站历史弹幕 progress 缺失为 null）
test('formatClock：null/undefined/非数 → --:--', () => {
  assert.equal(formatClock(null), '--:--');
  assert.equal(formatClock(undefined), '--:--');
  assert.equal(formatClock(NaN), '--:--');
  assert.equal(formatClock(Infinity), '--:--');
  assert.equal(formatClock('5000'), '--:--');
});

// 负值（脏数据/未定位）→ --:--，不走负时间换算
test('formatClock：负值 → --:--', () => {
  assert.equal(formatClock(-1), '--:--');
  assert.equal(formatClock(-60000), '--:--');
});

// ---- formatDanmakuCopy：弹幕数组 → 每条一行 "[MM:SS] 内容" 复制文本 ----

test('formatDanmakuCopy：正常多行，行间 \\n、无尾随换行', () => {
  const text = formatDanmakuCopy([
    { progress_ms: 0, mode: 1, content: '前方高能', ctime_s: 1700000000 },
    { progress_ms: 65000, mode: 1, content: '哈哈哈哈', ctime_s: 1700000001 },
  ]);
  assert.equal(text, '[00:00] 前方高能\n[01:05] 哈哈哈哈');
  assert.equal(text.endsWith('\n'), false);
});

test('formatDanmakuCopy：progress_ms null → [--:--] 行', () => {
  assert.equal(
    formatDanmakuCopy([{ progress_ms: null, mode: null, content: '没有时间', ctime_s: null }]),
    '[--:--] 没有时间',
  );
});

test('formatDanmakuCopy：progress_ms 负值 → [--:--] 行（不走负时间换算）', () => {
  assert.equal(
    formatDanmakuCopy([{ progress_ms: -5, mode: 1, content: '脏数据', ctime_s: null }]),
    '[--:--] 脏数据',
  );
});

test('formatDanmakuCopy：超 1h → [H:MM:SS] 行', () => {
  assert.equal(
    formatDanmakuCopy([{ progress_ms: 3661000, mode: 1, content: '一小时后', ctime_s: null }]),
    '[1:01:01] 一小时后',
  );
});

// content null / undefined / 空串跳过，不产空行；数组内 null 元素同样安全跳过
test('formatDanmakuCopy：content null/空串跳过', () => {
  const text = formatDanmakuCopy([
    { progress_ms: 1000, mode: 1, content: null, ctime_s: null },
    { progress_ms: 2000, mode: 1, content: undefined, ctime_s: null },
    { progress_ms: 3000, mode: 1, content: '', ctime_s: null },
    null,
    { progress_ms: 4000, mode: 1, content: '唯一有效', ctime_s: null },
  ]);
  assert.equal(text, '[00:04] 唯一有效');
});

test('formatDanmakuCopy：空数组 → 空串', () => {
  assert.equal(formatDanmakuCopy([]), '');
});

// 非数组入参（调用方异常态兜底）→ 空串，不抛
test('formatDanmakuCopy：非数组入参 → 空串', () => {
  assert.equal(formatDanmakuCopy(null), '');
  assert.equal(formatDanmakuCopy(undefined), '');
});

// ---- formatDanmakuLines：弹幕数组 → 展开列表渲染条目 [{ clock, content }]（2026-10-07 弹幕卡展开）----

test('formatDanmakuLines：正常多条 → { clock, content } 数组，顺序=入参序（时间轴序不重排）', () => {
  const lines = formatDanmakuLines([
    { progress_ms: 0, mode: 1, content: '前方高能', ctime_s: 1700000000 },
    { progress_ms: 65000, mode: 1, content: '哈哈哈哈', ctime_s: 1700000001 },
  ]);
  assert.deepEqual(lines, [
    { clock: '00:00', content: '前方高能' },
    { clock: '01:05', content: '哈哈哈哈' },
  ]);
});

test('formatDanmakuLines：progress_ms null/负值 → clock 占位 --:--（与复制文本同归一）', () => {
  const lines = formatDanmakuLines([
    { progress_ms: null, mode: null, content: '没有时间', ctime_s: null },
    { progress_ms: -5, mode: 1, content: '脏数据', ctime_s: null },
  ]);
  assert.deepEqual(lines, [
    { clock: '--:--', content: '没有时间' },
    { clock: '--:--', content: '脏数据' },
  ]);
});

test('formatDanmakuLines：超 1h → H:MM:SS 档', () => {
  assert.deepEqual(formatDanmakuLines([{ progress_ms: 3661000, mode: 1, content: '一小时后', ctime_s: null }]), [
    { clock: '1:01:01', content: '一小时后' },
  ]);
});

// 与 formatDanmakuCopy 同一跳过口径：content null/undefined/空串、数组内 null 元素都不产条目
test('formatDanmakuLines：content null/undefined/空串及 null 元素跳过', () => {
  const lines = formatDanmakuLines([
    { progress_ms: 1000, mode: 1, content: null, ctime_s: null },
    { progress_ms: 2000, mode: 1, content: undefined, ctime_s: null },
    { progress_ms: 3000, mode: 1, content: '', ctime_s: null },
    null,
    { progress_ms: 4000, mode: 1, content: '唯一有效', ctime_s: null },
  ]);
  assert.deepEqual(lines, [{ clock: '00:04', content: '唯一有效' }]);
});

test('formatDanmakuLines：空数组 → 空数组；非数组入参 → 空数组（不抛）', () => {
  assert.deepEqual(formatDanmakuLines([]), []);
  assert.deepEqual(formatDanmakuLines(null), []);
  assert.deepEqual(formatDanmakuLines(undefined), []);
});

// 重构回归锚点：复制文本 = 展开条目逐行 "[clock] content" 拼接——两消费端口径永不漂移
test('formatDanmakuLines 与 formatDanmakuCopy 同口径：复制文本=条目逐行拼接', () => {
  const danmakus = [
    { progress_ms: 0, mode: 1, content: '前方高能', ctime_s: null },
    { progress_ms: null, mode: null, content: '没有时间', ctime_s: null },
    { progress_ms: 3000, mode: 1, content: '', ctime_s: null },
    { progress_ms: 3661000, mode: 1, content: '一小时后', ctime_s: null },
  ];
  const text = formatDanmakuLines(danmakus).map((l) => `[${l.clock}] ${l.content}`).join('\n');
  assert.equal(text, formatDanmakuCopy(danmakus));
});

// ---- danmakuCopyStats：复制成功反馈「已复制 N 条」的条数（按行数算） ----

test('danmakuCopyStats：多行文本按行数计', () => {
  assert.equal(danmakuCopyStats('a\nb\nc'), 3);
  assert.equal(danmakuCopyStats('[00:00] 前方高能\n[01:05] 哈哈哈哈'), 2);
});

test('danmakuCopyStats：单行 → 1', () => {
  assert.equal(danmakuCopyStats('only'), 1);
});

test('danmakuCopyStats：空串/非字符串 → 0', () => {
  assert.equal(danmakuCopyStats(''), 0);
  assert.equal(danmakuCopyStats(null), 0);
  assert.equal(danmakuCopyStats(undefined), 0);
});
