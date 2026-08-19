// test/vid-extract.test.mjs
// 回归：从平台视频页 URL 提取 videoId 的纯函数（抽自 platforms.ts，供 popup + 测试共用）。
// 覆盖：B 站 /video/BVxxx（旧页）、/list/*?bvid=（列表播放页：稍后再看/收藏夹）、非视频页、脏值；
//       YouTube watch?v=（含桌面版 ?app=desktop&v=）、非 watch。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBiliVid, extractYoutubeVid } from '../vid-extract.mjs';

// ---- B 站：旧 /video/BVxxx 路径（零行为变更，必须保持）----
test('bili：旧 /video/BVxxx 路径提取 BV', () => {
  assert.equal(
    extractBiliVid('https://www.bilibili.com/video/BV1FyVv6TE5o'),
    'BV1FyVv6TE5o',
  );
});

test('bili：带 query 参数的 /video/ 页仍只取路径里的 BV', () => {
  assert.equal(
    extractBiliVid('https://www.bilibili.com/video/BV1FyVv6TE5o/?spm_id_from=333&vd_source=abc'),
    'BV1FyVv6TE5o',
  );
});

// ---- B 站：列表型播放页（本次新增支持）----
test('bili：稍后再看 /list/watchlater?bvid= 提取 BV', () => {
  // 用户上报的真实 URL（历史记录/稍后再看列表页）
  assert.equal(
    extractBiliVid('https://www.bilibili.com/list/watchlater?oid=116677635212528&bvid=BV1FyVv6TE5o&spm_id_from=333.1007.top_right_bar_window_view_later.content.click&vd_source=f527d7278d3dc02d7590116bd722bf44'),
    'BV1FyVv6TE5o',
  );
});

test('bili：收藏夹 /list/ml{id}?bvid= 提取 BV', () => {
  assert.equal(
    extractBiliVid('https://www.bilibili.com/list/ml1234567?bvid=BV15HgE6TEdk&oid=117084180713950'),
    'BV15HgE6TEdk',
  );
});

test('bili：bvid 不是 query 首参数（前后都有其他参数）也能提取', () => {
  assert.equal(
    extractBiliVid('https://www.bilibili.com/list/watchlater?spm_id_from=x&bvid=BV1abc123456&p=2'),
    'BV1abc123456',
  );
});

// ---- B 站：非视频页 / 脏值 → null ----
test('bili：无 bvid 的 list 列表首页 → null', () => {
  assert.equal(extractBiliVid('https://www.bilibili.com/list/watchlater'), null);
});

test('bili：脏 query（bvid 不是合法 BV 格式）→ null', () => {
  assert.equal(extractBiliVid('https://www.bilibili.com/list/watchlater?bvid=notabvid'), null);
  assert.equal(extractBiliVid('https://www.bilibili.com/list/watchlater?bvid=12345'), null);
});

test('bili：首页 / 搜索 / 动态（无 player）→ null', () => {
  assert.equal(extractBiliVid('https://www.bilibili.com/'), null);
  assert.equal(extractBiliVid('https://search.bilibili.com/all?keyword=test'), null);
  assert.equal(extractBiliVid('https://www.bilibili.com/opus/BV1abc'), null);
});

test('bili：空 / 非字符串 / 非 absolute URL → null（安全兜底）', () => {
  assert.equal(extractBiliVid(''), null);
  assert.equal(extractBiliVid(undefined), null);
  assert.equal(extractBiliVid(null), null);
  // 故意传非字符串测 typeof 兜底
  assert.equal(extractBiliVid(123), null);
  // 相对路径非 absolute URL：new URL 抛 → 无 query 可提 → null（但 path 正则也不匹配）
  assert.equal(extractBiliVid('/list/watchlater?bvid=BV1abc'), null);
});

// ---- YouTube：逻辑不变（仅包装，回归保护）----
test('youtube：标准 watch?v= 提取 11 位 id', () => {
  assert.equal(
    extractYoutubeVid('https://www.youtube.com/watch?v=abcdefghijk'),
    'abcdefghijk',
  );
});

test('youtube：桌面版 watch?app=desktop&v= 也能提取', () => {
  assert.equal(
    extractYoutubeVid('https://www.youtube.com/watch?app=desktop&v=AbCdEfGhI1k'),
    'AbCdEfGhI1k',
  );
});

test('youtube：v 参数在后 / 含其他参数 → 取 v', () => {
  assert.equal(
    extractYoutubeVid('https://www.youtube.com/watch?list=PL123&t=10&v=_abcdefghij'),
    '_abcdefghij',
  );
});

test('youtube：非 watch 页 / 无 v → null', () => {
  assert.equal(extractYoutubeVid('https://www.youtube.com/'), null);
  assert.equal(extractYoutubeVid('https://www.youtube.com/feed/subscriptions'), null);
});

test('youtube：空 / 非字符串 → null', () => {
  assert.equal(extractYoutubeVid(''), null);
  assert.equal(extractYoutubeVid(undefined), null);
  // 故意传 null 测 typeof 兜底
  assert.equal(extractYoutubeVid(null), null);
});
