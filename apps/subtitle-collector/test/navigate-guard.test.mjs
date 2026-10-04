// navigate 命令目标 URL/host 白名单（C6 兜底闸）纯逻辑的测试。
// server 端同款校验在 apps/collector-server/src/http/clients.ts（validateNavigateUrl）——两端
// 同一份清单字面量（注释互指），本文件锁字面量稳定性 + 判定的正反例（子域放行/伪装域拒）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAVIGATE_HOST_SUFFIXES, isAllowedNavigateHost, isAllowedNavigateUrl } from '../navigate-guard.mjs';

test('isAllowedNavigateHost：白名单域本身与子域放行，伪装域/外部域/非字符串拒', () => {
  // 域本身（裸域，如 bilibili.com 主站搜索页）
  assert.equal(isAllowedNavigateHost('bilibili.com'), true);
  assert.equal(isAllowedNavigateHost('youtube.com'), true);
  assert.equal(isAllowedNavigateHost('douyin.com'), true);
  // 常用子域（www 视频/m 移动/search 搜索/space 空间页）
  assert.equal(isAllowedNavigateHost('www.bilibili.com'), true);
  assert.equal(isAllowedNavigateHost('m.bilibili.com'), true);
  assert.equal(isAllowedNavigateHost('search.bilibili.com'), true);
  assert.equal(isAllowedNavigateHost('www.youtube.com'), true);
  assert.equal(isAllowedNavigateHost('www.douyin.com'), true);
  // 大小写不敏感（URL hostname 已小写化，直调防御）
  assert.equal(isAllowedNavigateHost('WWW.BILIBILI.COM'), true);
  // 伪装域：前缀拼接（evil-bilibili.com）与后缀拼接（bilibili.com.evil.com）都不是子域
  assert.equal(isAllowedNavigateHost('evil-bilibili.com'), false);
  assert.equal(isAllowedNavigateHost('bilibili.com.evil.com'), false);
  assert.equal(isAllowedNavigateHost('example.com'), false);
  // 非法/缺省入参防御（String(null ?? '') → 空串，不在白名单）
  assert.equal(isAllowedNavigateHost(''), false);
  assert.equal(isAllowedNavigateHost(null), false);
  assert.equal(isAllowedNavigateHost(undefined), false);
});

test('isAllowedNavigateUrl：合法三平台 http(s) 页放行，解析失败/协议/host 非法拒', () => {
  // 合法：三平台典型视频/搜索页
  assert.equal(isAllowedNavigateUrl('https://www.bilibili.com/video/BV1xxx411c7mD'), true);
  assert.equal(isAllowedNavigateUrl('http://bilibili.com/search?keyword=x'), true, '裸域 http 放行');
  assert.equal(isAllowedNavigateUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isAllowedNavigateUrl('https://www.douyin.com/video/7123456789012345678'), true);
  // URL 解析失败（background 侧打日志带原值后丢弃）
  assert.equal(isAllowedNavigateUrl('not a url'), false);
  assert.equal(isAllowedNavigateUrl(''), false);
  assert.equal(isAllowedNavigateUrl(undefined), false, '缺 url 字段');
  // 协议收紧：只放行 http(s)
  assert.equal(isAllowedNavigateUrl('ftp://www.bilibili.com/video/BV1xxx'), false);
  assert.equal(isAllowedNavigateUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedNavigateUrl('chrome://extensions'), false);
  // host 收紧：外部域与伪装域
  assert.equal(isAllowedNavigateUrl('https://evil.com/video/BV1xxx'), false);
  assert.equal(isAllowedNavigateUrl('https://bilibili.com.evil.com/video/BV1xxx'), false);
});

test('白名单清单稳定：三平台域名，与 server 端 clients.ts 保持同一份字面量', () => {
  // 字面量锁死：改动须同步 server 端 clients.ts 的 NAVIGATE_HOST_SUFFIXES（两端注释互指）
  assert.deepEqual(NAVIGATE_HOST_SUFFIXES, ['bilibili.com', 'youtube.com', 'douyin.com']);
});
