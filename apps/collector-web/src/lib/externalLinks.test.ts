// externalLinks 纯函数测试：videoUrl / creatorUrl 的平台分流（bilibili 默认 / youtube 分支）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | videoUrl + creatorUrl 双平台分支 | 通过 | |
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { videoUrl, creatorUrl } from './externalLinks.ts';

test('videoUrl：bilibili → /video/<BV>', () => {
  assert.equal(videoUrl('bilibili', 'BV1ab234567'), 'https://www.bilibili.com/video/BV1ab234567');
});

test('videoUrl：youtube → /watch?v=<id>', () => {
  assert.equal(videoUrl('youtube', 'dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('creatorUrl：bilibili → space/<mid>', () => {
  assert.equal(creatorUrl('bilibili', '12345'), 'https://space.bilibili.com/12345');
});

test('creatorUrl：youtube → /channel/<UC…>', () => {
  assert.equal(creatorUrl('youtube', 'UCxxxx'), 'https://www.youtube.com/channel/UCxxxx');
});
