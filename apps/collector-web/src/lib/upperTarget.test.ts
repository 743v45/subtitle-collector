// upperTarget 纯函数测试：parseUpperTarget 输入矩阵（B 站 mid/空间链接、YouTube @handle/UC/频道页、
// douyin 裸 sec_uid//user/ 链接、非法/空输入）+ upperCreatorUid 三平台归属矩阵。
// 跑法：npx vitest run src/lib/upperTarget.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 抽出共享件（2026-08-29 douyin 接入）三平台全形态 + 归属矩阵 | 通过 | 行为与 CollectPage 内联版一致（页面测试另有集成断言） |
// | R2 | 审查 M3：sec_uid 前缀统一 ^MS4wLjAB（三处镜像）补拒 7 字符前缀用例 | 通过 | npx vitest run src/lib/upperTarget.test.ts |
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseUpperTarget, upperCreatorUid } from './upperTarget.ts';

const SEC = 'MS4wLjABAAAA2y53DZw7-0cG6yOfaZCJesMdyIdXhqLPu2abnCFjkUs';

test('parseUpperTarget：B 站——裸数字 mid 与 space 链接', () => {
  assert.deepEqual(parseUpperTarget('296399504'), { source: 'bilibili', mid: '296399504' });
  assert.deepEqual(parseUpperTarget('https://space.bilibili.com/296399504/upload/video'), { source: 'bilibili', mid: '296399504' });
});

test('parseUpperTarget：B 站空间链接非数字段 → 不识别', () => {
  assert.equal(parseUpperTarget('https://space.bilibili.com/xxx'), null);
});

test('parseUpperTarget：YouTube——@handle / UC ID / 频道页链接原样透传', () => {
  assert.deepEqual(parseUpperTarget('@testch'), { source: 'youtube', channel: '@testch' });
  assert.deepEqual(parseUpperTarget('UCtest_channel_id_000001'), { source: 'youtube', channel: 'UCtest_channel_id_000001' });
  assert.deepEqual(parseUpperTarget('https://www.youtube.com/@testch/videos'), { source: 'youtube', channel: 'https://www.youtube.com/@testch/videos' });
});

test('parseUpperTarget：douyin——裸 sec_uid 与 /user/ 主页链接（截出 sec_uid）', () => {
  assert.deepEqual(parseUpperTarget(SEC), { source: 'douyin', channel: SEC });
  assert.deepEqual(parseUpperTarget(`https://www.douyin.com/user/${SEC}?from=xxx`), { source: 'douyin', channel: SEC });
  // 裸域（无 www）同认
  assert.deepEqual(parseUpperTarget(`https://douyin.com/user/${SEC}`), { source: 'douyin', channel: SEC });
});

test('parseUpperTarget：douyin 非 /user/<sec_uid> 路径 → 不识别（视频页链接走单条提交，不进批量）', () => {
  assert.equal(parseUpperTarget('https://www.douyin.com/video/7300000000000000001'), null);
  // /user/ 但段不是 sec_uid 形态
  assert.equal(parseUpperTarget('https://www.douyin.com/user/someone'), null);
});

test('parseUpperTarget：sec_uid 前缀 8 字符（MS4wLjAB）为界，第 8 位非 B 拒（审查 M3 三处统一）', () => {
  // 与 server DOUYIN_SEC_UID_RE / 扩展 extractDouyinUpperKey 的 SEC_UID_RE 镜像
  assert.equal(parseUpperTarget('MS4wLjACAAAAabcdef123456'), null, '裸串第 8 位非 B');
  assert.equal(parseUpperTarget('https://www.douyin.com/user/MS4wLjA7AAAAabcdef123456'), null, '/user/ 路径同判');
});

test('parseUpperTarget：空 / 纯空白 / 乱串 → null', () => {
  assert.equal(parseUpperTarget(''), null);
  assert.equal(parseUpperTarget('   '), null);
  assert.equal(parseUpperTarget('不是UID'), null);
});

test('upperCreatorUid：B 站 mid / douyin sec_uid 输入即知；youtube 取展开回执（缺省 undefined）', () => {
  assert.equal(upperCreatorUid({ source: 'bilibili', mid: '296399504' }, 'UCx'), '296399504');
  assert.equal(upperCreatorUid({ source: 'douyin', channel: SEC }, null), SEC);
  assert.equal(upperCreatorUid({ source: 'youtube', channel: '@t' }, 'UCtest_channel_id_000001'), 'UCtest_channel_id_000001');
  assert.equal(upperCreatorUid({ source: 'youtube', channel: '@t' }, null), undefined);
  assert.equal(upperCreatorUid(null, 'UCx'), 'UCx');
  assert.equal(upperCreatorUid(null, null), undefined);
});
