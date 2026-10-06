// verify-full-chain.mjs 的单元测试 —— 生产全链路冒烟工具的纯逻辑必须被测试保护(CLAUDE.md
// 测试质量政策,对齐 verify-skill-sync.test.mjs 先例)。覆盖:目标选取(显式/列表扫描/批次
// 补全成员过滤)、轮询状态判定、created 分支决策(created:false 防线)、bundle 产物断言。
// main() 的端到端(真 server 派发/真 docker 快照)不在单测层——由生产实跑兜底,单测只注入数据。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BV_RE,
  pickBvid,
  classifyTaskStatus,
  decideCreatedBranch,
  auditBundleFiles,
  listFilesWithSize,
  validateArgs,
} from './verify-full-chain.mjs';

// ── 组:目标选取 pickBvid ──

test('pickBvid:显式 --bvid 合法格式直接采用,不查列表', () => {
  const picked = pickBvid('BV1xx411c7mD', []);
  // 断言:显式传参优先,from 标注来源便于日志追溯
  assert.deepEqual(picked, { ok: true, bvid: 'BV1xx411c7mD', from: '显式 --bvid' });
});

test('pickBvid:显式 --bvid 非 BV 形态 → ok:false 带格式说明', () => {
  const picked = pickBvid('av170001', []);
  assert.equal(picked.ok, false);
  assert.match(picked.error, /BV 号格式/);
  assert.match(picked.error, /av170001/);
});

test('pickBvid:无显式时取列表第一条 succeeded+bilibili+BV 形态任务', () => {
  const items = [
    { id: 1, source: 'bilibili', status: 'succeeded', source_vid: 'BV1AAA111111' },
    { id: 2, source: 'bilibili', status: 'succeeded', source_vid: 'BV1BBB222222' },
  ];
  const picked = pickBvid(null, items);
  // 断言:取第一条(调用侧已按 created_at 倒序传参,即最近一条);from 带 id 便于核对
  assert.equal(picked.ok, true);
  assert.equal(picked.bvid, 'BV1AAA111111');
  assert.match(picked.from, /id=1/);
});

test('pickBvid:跳过批次补全带出的非 succeeded 成员与异平台任务', () => {
  // 前置:listTasks 批次补全会跨状态拉齐整批,items 混有 dispatched/failed 与 youtube/douyin 行
  const items = [
    { id: 1, source: 'bilibili', status: 'dispatched', source_vid: 'BV1AAA111111' },
    { id: 2, source: 'youtube', status: 'succeeded', source_vid: 'dQw4w9WgXcQ' },
    { id: 3, source: 'douyin', status: 'succeeded', source_vid: '7123456789012345678' },
    { id: 4, source: 'bilibili', status: 'failed', source_vid: 'BV1CCC333333' },
    { id: 5, source: 'bilibili', status: 'succeeded', source_vid: 'BV1DDD444444' },
  ];
  const picked = pickBvid(null, items);
  // 断言:只有 id=5 同时满足 succeeded+bilibili+BV 形态
  assert.equal(picked.bvid, 'BV1DDD444444');
});

test('pickBvid:source_vid 非 BV 形态的脏行不采纳,列表全不合格 → ok:false', () => {
  const items = [{ id: 1, source: 'bilibili', status: 'succeeded', source_vid: 'not-a-bv' }];
  const picked = pickBvid(null, items);
  assert.equal(picked.ok, false);
  assert.match(picked.error, /无 succeeded/);
});

test('pickBvid:items 非数组(null/undefined)按空表处理不抛错', () => {
  assert.equal(pickBvid(null, null).ok, false);
  assert.equal(pickBvid(null, undefined).ok, false);
});

test('BV_RE:与 server 端 VID_RE.bilibili 同口径(BV + 10 位字母数字)', () => {
  assert.ok(BV_RE.test('BV1jQtx6rEd4')); // 生产实测最近 succeeded 任务的 source_vid
  assert.ok(!BV_RE.test('BV1jQtx6rEd')); // 9 位尾段不足
  assert.ok(!BV_RE.test('bv1jQtx6rEd4')); // 小写 bv 不收(与 server 一致)
});

// ── 组:参数校验 validateArgs ──

test('validateArgs:token+timeout 齐全即放行;缺 token / timeout 非正数各自报错退 1', () => {
  // 断言:合法参数原样透传(exitCode 字段不出现,区别于错误分支)
  const ok = validateArgs({ help: false, token: 't', timeoutSec: 135 });
  assert.equal(ok.error, undefined);
  assert.equal(ok.args.timeoutSec, 135);
  const noToken = validateArgs({ help: false, token: undefined, timeoutSec: 135 });
  assert.equal(noToken.exitCode, 1);
  assert.match(noToken.error, /缺 token/);
  const badTimeout = validateArgs({ help: false, token: 't', timeoutSec: 0 });
  assert.equal(badTimeout.exitCode, 1);
  assert.match(badTimeout.error, /--timeout 非法/);
  assert.equal(validateArgs({ help: false, token: 't', timeoutSec: NaN }).exitCode, 1);
});

test('validateArgs:--help 优先放行(help:true),不做 token 校验(先看用法再看参)', () => {
  const v = validateArgs({ help: true, token: undefined, timeoutSec: 135 });
  assert.equal(v.help, true);
  assert.equal(v.error, undefined);
});

// ── 组:轮询状态判定 classifyTaskStatus ──

test('classifyTaskStatus:五种任务状态各归其类', () => {
  // 断言:succeeded 唯一终态成功;failed/limited 同为失败档(都带 error 字段可打日志)
  assert.equal(classifyTaskStatus('succeeded'), 'done');
  assert.equal(classifyTaskStatus('failed'), 'fail');
  assert.equal(classifyTaskStatus('limited'), 'fail');
  assert.equal(classifyTaskStatus('pending'), 'wait');
  assert.equal(classifyTaskStatus('dispatched'), 'wait');
});

test('classifyTaskStatus:未知状态归 unknown(等满超时兜底,不误判成败)', () => {
  // 前置:server/扩展版本漂移可能引入新状态;归 unknown 让轮询继续+超时可见,而非静默通过
  assert.equal(classifyTaskStatus('reviewing'), 'unknown');
  assert.equal(classifyTaskStatus(undefined), 'unknown');
});

// ── 组:created 分支决策 decideCreatedBranch ──

test('decideCreatedBranch:created:true → created 分支,taskId 取 task.id', () => {
  const d = decideCreatedBranch({ ok: true, created: true, task: { id: 3852 } });
  assert.deepEqual(d, { branch: 'created', taskId: 3852 });
});

test('decideCreatedBranch:created:false → reused 分支(防线:绝不写/删该任务)', () => {
  // 前置:server findActiveTask 命中同视频 pending/dispatched 时返回既有任务 + created:false
  const d = decideCreatedBranch({ ok: true, created: false, task: { id: 777 } });
  assert.deepEqual(d, { branch: 'reused', taskId: 777 });
});

test('decideCreatedBranch:缺 ok/task.id/created 字段 → invalid(形态守卫)', () => {
  // 断言:created 字段缺失不能默认当 created:true——那会让清理逻辑误删别人的任务
  assert.equal(decideCreatedBranch(null).branch, 'invalid');
  assert.equal(decideCreatedBranch({ ok: true, task: { id: 1 } }).branch, 'invalid');
  assert.equal(decideCreatedBranch({ ok: false, created: true, task: { id: 1 } }).branch, 'invalid');
  assert.equal(decideCreatedBranch({ ok: true, created: true, task: {} }).branch, 'invalid');
});

// ── 组:bundle 产物断言 auditBundleFiles / listFilesWithSize ──

test('auditBundleFiles:manifest+ANALYZE+一条非空 txt → ok 且摘要齐全', () => {
  const entries = [
    { path: 'manifest.json', size: 1200 },
    { path: 'ANALYZE.md', size: 567 },
    { path: 'videos/3852-宇树一面.txt', size: 89 },
  ];
  const a = auditBundleFiles(entries);
  assert.equal(a.ok, true);
  assert.deepEqual(a.problems, []);
  // 断言:摘要行含三个构件的体积,供 [assert] 日志直接输出
  assert.equal(a.summary.length, 3);
  assert.match(a.summary[2], /1 个/);
});

test('auditBundleFiles:缺 manifest / ANALYZE 为 0 字节 / 单个 txt 空,问题全数上报不短路', () => {
  const entries = [
    { path: 'ANALYZE.md', size: 0 },
    { path: 'videos/3852-x.txt', size: 0 },
    { path: 'videos/3853-y.txt', size: 12 },
  ];
  const a = auditBundleFiles(entries);
  assert.equal(a.ok, false);
  // 断言:三类问题逐条列出(manifest 缺失 + ANALYZE 空 + 一个 txt 空),不因首项缺失短路(排障要看全貌)
  assert.equal(a.problems.length, 3);
  assert.ok(a.problems.some((p) => p.includes('缺少 manifest.json')));
  assert.ok(a.problems.some((p) => p.includes('ANALYZE.md 为空')));
  assert.ok(a.problems.some((p) => p === 'videos/3852-x.txt 为空(0 字节)'));
});

test('auditBundleFiles:videos/ 下无任何 txt → 报导出 0 条(链路断言失败)', () => {
  const a = auditBundleFiles([
    { path: 'manifest.json', size: 10 },
    { path: 'ANALYZE.md', size: 10 },
  ]);
  assert.equal(a.ok, false);
  assert.ok(a.problems.some((p) => p.includes('无任何 .txt')));
});

test('auditBundleFiles:非 videos/ 目录文件不计入 txt 断言(防误放行)', () => {
  const a = auditBundleFiles([
    { path: 'manifest.json', size: 10 },
    { path: 'ANALYZE.md', size: 10 },
    { path: 'notes.txt', size: 5 }, // 根目录散落文件不算 videos/*.txt
  ]);
  assert.equal(a.ok, false);
});

test('listFilesWithSize:递归列出相对路径与字节数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vfc-test-'));
  try {
    writeFileSync(join(dir, 'manifest.json'), '{"k":1}');
    writeFileSync(join(dir, 'ANALYZE.md'), '# 分析');
    mkdirSync(join(dir, 'videos'));
    writeFileSync(join(dir, 'videos', 'a.txt'), '内容');
    const files = listFilesWithSize(dir);
    // 断言:相对路径以 videos/ 前缀呈现,size 为字节(3 个中文字符 UTF-8 = 6B)
    assert.deepEqual(files.map((f) => f.path).sort(), ['ANALYZE.md', 'manifest.json', 'videos/a.txt'].sort());
    assert.equal(files.find((f) => f.path === 'videos/a.txt').size, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
