import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIXIN_KEY_ENC_TAB, getMixinKey, encWbi, extractKeysFromNav } from '../wbi.js';

test('MIXIN_KEY_ENC_TAB 长度 64', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64);
});

// 测试向量来自 bilibili-API-collect wbi.md（Rust demo tests）
test('getMixinKey 对已知 img_key+sub_key 得固定 mixin_key', () => {
  const img = '7cd084941338484aae1ad9425b84077c';
  const sub = '4932caff0ff746eab6f01bf08b70ac45';
  assert.equal(getMixinKey(img + sub), 'ea1db124af3c7062474693fa704f4ff8');
});

test('encWbi 固定 wts 得固定 w_rid', () => {
  const img = '7cd084941338484aae1ad9425b84077c';
  const sub = '4932caff0ff746eab6f01bf08b70ac45';
  const out = encWbi({ foo: '114', bar: '514', zab: 1919810 }, img, sub, 1702204169);
  assert.equal(out, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
});

test('encWbi 过滤 value 中的 !\'()* 字符', () => {
  const out = encWbi({ k: "a'b(c)" }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169);
  assert.match(out, /k=abc/); // !'()* 被过滤
});

test('extractKeysFromNav 从 nav 响应抽 img_key/sub_key', () => {
  const nav = { data: { wbi_img: {
    img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  } } };
  assert.deepEqual(extractKeysFromNav(nav), {
    img_key: '7cd084941338484aae1ad9425b84077c',
    sub_key: '4932caff0ff746eab6f01bf08b70ac45',
  });
});
