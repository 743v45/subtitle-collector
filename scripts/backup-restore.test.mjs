// backup-restore.mjs 的单元测试 —— 恢复工具硬化的纯函数层保护（改造项 A4）。
// 覆盖范围:数据卷名解析 resolveDataVolume / --pick 参数解析 parsePick / 验收日志行格式 formatAcceptanceRow。
// main() 的端到端(真实 docker 链路)不在此测——由 --drill 机器实测兜底,单元层只测纯函数。
// 本文件 import backup-restore.mjs 本身即隐式验证 isMain 守卫:import 不应触发任何 docker 调用或退出。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import {
  ACCEPTANCE_LOG_HEADER,
  formatAcceptanceRow,
  parsePick,
  resolveDataVolume,
} from './backup-restore.mjs';

// ── 组:resolveDataVolume(数据卷名解析)──

test('resolveDataVolume:inspect 输出含 /data 挂载 → 返回卷名(去尾换行)', () => {
  // docker inspect --format range 模板:每个 Destination=/data 的挂载输出一行 .Name
  const stdout = 'subtitle-collector_collector-data\n';
  assert.equal(resolveDataVolume(stdout), 'subtitle-collector_collector-data');
});

test('resolveDataVolume:inspect 输出含 /data 挂载 → 前后空白容忍', () => {
  assert.equal(resolveDataVolume('  my-data  \n\n'), 'my-data');
});

test('resolveDataVolume:inspect 输出不含 /data 挂载(空输出)→ null', () => {
  assert.equal(resolveDataVolume(''), null);
  assert.equal(resolveDataVolume('\n'), null);
});

test('resolveDataVolume:输出多个候选(歧义)→ null(宁失败不猜)', () => {
  assert.equal(resolveDataVolume('vol-a\nvol-b\n'), null);
});

// ── 组:parsePick(--pick/--sample 历史抽验参数解析)──

test('parsePick:k=1 → 下标 0(最新份)', () => {
  assert.equal(parsePick('1', 8), 0);
});

test('parsePick:k=5 → 下标 4(第 5 新)', () => {
  assert.equal(parsePick('5', 8), 4);
});

test('parsePick:k=末位(count)→ 下标 count-1(最老份仍在范围内)', () => {
  assert.equal(parsePick('8', 8), 7);
});

test('parsePick:k 越界(999>8)→ 抛错且消息含合法范围 1..8', () => {
  assert.throws(() => parsePick('999', 8), (err) => /1\.\.8/.test(err.message) && /999/.test(err.message));
});

test('parsePick:k=0 → 越界抛错(k 从 1 起算)', () => {
  assert.throws(() => parsePick('0', 8), /1\.\.8/);
});

test('parsePick:非数字(abc)→ 抛错且消息含合法范围与 random', () => {
  assert.throws(() => parsePick('abc', 8), (err) => /1\.\.8/.test(err.message) && /random/.test(err.message));
});

test('parsePick:spec=undefined(传了 --pick 缺值)→ 抛错不静默取最新', () => {
  assert.throws(() => parsePick(undefined, 8), /1\.\.8/);
});

test('parsePick:spec=null(未传 --pick)→ 下标 0(缺省行为不变,验最新)', () => {
  assert.equal(parsePick(null, 8), 0);
});

test('parsePick:random → 取注入 rng 的返回值(可注入便于测试)', () => {
  assert.equal(parsePick('random', 8, () => 3), 3);
});

test('parsePick:random 默认 rng(crypto.randomInt)→ 恒落在 [0, count) 且无偏置抽 50 次', () => {
  for (let i = 0; i < 50; i++) {
    const idx = parsePick('random', 8);
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx < 8, `idx=${idx} 越界`);
  }
  // 抽样够多时应覆盖多个不同下标(证明不是恒定值)
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(parsePick('random', 8, (n) => randomInt(n)));
  assert.ok(seen.size > 1, `200 次抽样仅见 ${seen.size} 个下标,疑似有偏`);
});

// ── 组:formatAcceptanceRow(验收日志行格式)──

test('formatAcceptanceRow:六个字段按表头顺序成行,耗时带 ms 单位', () => {
  const row = formatAcceptanceRow({
    timestamp: '2026-10-04T08:30:00.000Z',
    mode: 'drill',
    file: 'bilibili-collector-backup-20261004-043710.db',
    integrity: 'ok',
    videos: '1234',
    ms: 4523,
  });
  assert.equal(row, '| 2026-10-04T08:30:00.000Z | drill | bilibili-collector-backup-20261004-043710.db | ok | 1234 | 4523 ms |');
  assert.equal(row.split('|').length - 2, 6, '应恰好 6 列,与表头一致');
});

test('formatAcceptanceRow:失败行(integrity=失败原因,videos=-)同格式', () => {
  const row = formatAcceptanceRow({
    timestamp: '2026-10-04T08:31:00.000Z',
    mode: 'drill',
    file: 'bilibili-collector-backup-20261004-042210.db',
    integrity: '失败:演练容器 15s 内未通过 /ping',
    videos: '-',
    ms: 16021,
  });
  assert.match(row, /^\| 2026-10-04T08:31:00\.000Z \| drill \| .+ \| 失败:.+ \| - \| \d+ ms \|$/);
});

test('ACCEPTANCE_LOG_HEADER:表头列名与行格式字段一一对应', () => {
  assert.equal(ACCEPTANCE_LOG_HEADER, '| 日期 | 模式 | 备份文件 | integrity | videos 行数 | 耗时 |');
});
