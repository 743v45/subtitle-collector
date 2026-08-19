// bundle.ts 纯函数单测：stampedTxt 行格式 + ANALYZE.md 模板锚点。
// 跑法：cd apps/collector-server && node --test --import tsx src/cli/bundle.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | stampedTxt / secsToClock / ANALYZE_MD | 通过 | 行格式含轻量时间戳 |
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secsToClock, stampedTxt, ANALYZE_MD } from './bundle.js';

const PAYLOAD = {
  body: [
    { from: 5.2, to: 8, content: ' 观点一 ' },
    { from: 65, to: 70, content: '观点二' },
    { from: 3661, to: 3665, content: '一小时后' },
    { from: 71, to: 72, content: '   ' }, // 纯空白，应跳过
  ],
};

test('secsToClock: 秒→分:秒 / 时:分:秒', () => {
  assert.equal(secsToClock(0), '00:00');
  assert.equal(secsToClock(5.2), '00:05');
  assert.equal(secsToClock(65), '01:05');
  assert.equal(secsToClock(3661), '1:01:01');
});

test('stampedTxt: 行格式 [分:秒] 字幕，跳过空白行，末尾换行', () => {
  const out = stampedTxt(PAYLOAD);
  assert.equal(out, '[00:05] 观点一\n[01:05] 观点二\n[1:01:01] 一小时后\n');
});

test('stampedTxt: payload 结构不符时抛错', () => {
  assert.throws(() => stampedTxt({ noBody: true }), /结构不符/);
});

test('ANALYZE_MD: 含三类产物模板锚点 + 产物写回约定', () => {
  for (const anchor of ['观点汇总.md', '面试题库.md', '理念整理.md', 'manifest.json', 'videos/', '来源:']) {
    assert.ok(ANALYZE_MD.includes(anchor), `ANALYZE_MD 缺锚点: ${anchor}`);
  }
});
