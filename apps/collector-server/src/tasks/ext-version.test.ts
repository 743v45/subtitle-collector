// ext-version.ts 单测：扩展版本感知共享层——compareExtVersion 数字段比较（版本门槛判定输入）
// 与 extNeedsUpdate 回执分类（「扩展版本过旧」两种回执形态）。
// 夹具：纯函数直测，无 db / ws 依赖。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | compareExtVersion 数字段比较边界（非字典序/null=0.0.0/段缺失）+ extNeedsUpdate 两形态 | 通过 | 2026-08-30 多机版本参差事故抽出（失败态：模块未建时 import 失败，先红后绿实证） |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareExtVersion, extNeedsUpdate, EXT_NEEDS_UPDATE_ERROR } from './ext-version.js';

// ── compareExtVersion：数字段比较（门槛判定唯一输入，错判 = 派发事故）──

test('compareExtVersion：数字段比较非字典序——0.1.9 < 0.1.10（事故核心：字典序会判 9 > 10）', () => {
  // '9' vs '10' 字符串比较 '9' 更大 → 版本门槛会错放 0.1.9 过关，必须按数值比
  assert.equal(compareExtVersion('0.1.9', '0.1.10'), -1);
  assert.equal(compareExtVersion('0.1.10', '0.1.9'), 1);
});

test('compareExtVersion：事故版本对——0.1.18 < 0.1.24 < 0.1.25 < 0.1.26（门槛判定的实测区间）', () => {
  assert.equal(compareExtVersion('0.1.18', '0.1.24'), -1);
  assert.equal(compareExtVersion('0.1.24', '0.1.25'), -1);
  assert.equal(compareExtVersion('0.1.25', '0.1.26'), -1);
});

test('compareExtVersion：相等版本 → 0；跨数量级 1.0.0 > 0.99.99', () => {
  assert.equal(compareExtVersion('0.1.25', '0.1.25'), 0);
  assert.equal(compareExtVersion('1.0.0', '0.99.99'), 1);
});

test('compareExtVersion：null/undefined 视为 0.0.0（旧扩展 hello 不带 ext_version 按最旧处理）', () => {
  assert.equal(compareExtVersion(null, '0.0.1'), -1);
  assert.equal(compareExtVersion(undefined, '0.0.0'), 0);
  assert.equal(compareExtVersion(null, null), 0);
  // 门槛场景：无版本客户端必被 ≥0.1.25 门槛拦下
  assert.equal(compareExtVersion(undefined, '0.1.25'), -1);
});

test('compareExtVersion：段缺失/非数字段容错（缺段补 0，垃圾段当 0，仅认 x.y.z 点分形态）', () => {
  assert.equal(compareExtVersion('0.1', '0.1.0'), 0);      // 缺尾段 → 0
  assert.equal(compareExtVersion('0.2', '0.1.99'), 1);     // 高位定胜负，不看缺失段
  assert.equal(compareExtVersion('0.1.x', '0.1.0'), 0);    // 非数字段 → 0
  assert.equal(compareExtVersion('dev', '0.0.0'), 0);      // 全垃圾 = 0.0.0
});

// ── extNeedsUpdate：回执「版本过旧」分类（门槛漏网时的兜底判据）──

test('extNeedsUpdate：旧扩展回 "unknown action" 字符串 → true（2026-08-30 事故实际回执形态）', () => {
  assert.equal(extNeedsUpdate({ ok: false, error: 'unknown action: expand-douyin-upper' }), true);
});

test('extNeedsUpdate：新扩展显式 needs_update:true（顶层 / data 内两种位置）→ true', () => {
  assert.equal(extNeedsUpdate({ ok: false, needs_update: true }), true);
  assert.equal(extNeedsUpdate({ ok: false, data: { needs_update: true } }), true);
});

test('extNeedsUpdate：普通失败（need_login/风控）→ false，不误伤可重试错误', () => {
  assert.equal(extNeedsUpdate({ ok: false, error: 'post 列表 200 空体：该浏览器未登录抖音' }), false);
  assert.equal(extNeedsUpdate({ ok: false, error: 'arc/search -412' }), false);
  assert.equal(extNeedsUpdate(undefined), false);
});

test('EXT_NEEDS_UPDATE_ERROR：文案指向更新而非重试（与 tasks.ts 派发侧共用同一常量）', () => {
  assert.equal(EXT_NEEDS_UPDATE_ERROR, '扩展版本过旧，请更新扩展后重试');
});
