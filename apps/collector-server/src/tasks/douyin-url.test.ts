// douyin-url.ts 单测：博主标识解析（sec_uid 直传 / 主页 URL 提取 / 无法识别抛错）。
// parseDouyinUrl 的三形态归一与 19 位边界经 tasks.test.ts 的 parseVideoUrl 用例覆盖（host 白名单
// 在 tasks.ts 侧先行分流）；本文件补 douyin-url.ts 自身的直接出口。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | parseDouyinSecUid 三分支 + DOUYIN_AWEME_ID_RE 形态 | 通过 | 2026-08-29 S2 douyin 平台化 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDouyinSecUid, DOUYIN_AWEME_ID_RE, douyinWatchUrl } from './douyin-url.js';

test('parseDouyinSecUid：sec_uid 直传（MS4wLjA… base64 形态）原样返回', () => {
  const uid = 'MS4wLjABAAAAabcdef123456-_';
  assert.equal(parseDouyinSecUid(uid), uid);
  // 首尾空白宽容（复制粘贴常见）
  assert.equal(parseDouyinSecUid(`  ${uid}  `), uid);
});

test('parseDouyinSecUid：用户主页 URL → 提取 /user/<sec_uid> 段（S5 web 端可直接透传粘贴链接）', () => {
  const uid = 'MS4wLjABAAAAabcdef123456';
  assert.equal(parseDouyinSecUid(`https://www.douyin.com/user/${uid}?from=web_share`, ), uid);
  assert.equal(parseDouyinSecUid(`https://www.douyin.com/user/${uid}/`), uid);
});

test('parseDouyinSecUid：无法识别（非 sec_uid 非 URL / 主页 URL 无 user 段）→ 抛错（http 层转 400）', () => {
  assert.throws(() => parseDouyinSecUid('not-a-uid'), /无法识别的抖音博主参数/);
  assert.throws(() => parseDouyinSecUid(''), /无法识别的抖音博主参数/);
  assert.throws(() => parseDouyinSecUid('https://www.douyin.com/video/7123456789012345678'), /无法识别的抖音博主参数/);
});

test('DOUYIN_AWEME_ID_RE / douyinWatchUrl：19 位数字判据与 watch URL 形态', () => {
  // 边界：18/20 位不收（与 tasks.ts VID_RE、parseDouyinUrl 同源判据）
  assert.equal(DOUYIN_AWEME_ID_RE.test('7123456789012345678'), true);
  assert.equal(DOUYIN_AWEME_ID_RE.test('712345678901234567'), false);
  assert.equal(DOUYIN_AWEME_ID_RE.test('71234567890123456789'), false);
  assert.equal(douyinWatchUrl('7123456789012345678'), 'https://www.douyin.com/video/7123456789012345678');
});
