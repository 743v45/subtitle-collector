// 任务派发开关（关 = 仅上报状态）纯逻辑的测试：storage key 稳定 + fail-open 判定 +
// 防御拒绝回执文案稳定（background 拒任务时原样回执该文案，server 落任务 failed.error）。
// 协议链路：popup/options 开关（SET_TASK_DISPATCH）→ hello.task_dispatch_enabled →
// server 调度器过滤（pickClientForTask）→ 扩展端防御拒绝（fetch-subtitle / fetch-youtube-subtitle）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAcceptTasks, TASK_DISPATCH_KEY, TASK_DISPATCH_DISABLED_ERROR } from '../task-dispatch.mjs';

test('shouldAcceptTasks：true/未设→接受，false→仅上报（fail-open，默认开）', () => {
  assert.equal(shouldAcceptTasks(true), true);
  assert.equal(shouldAcceptTasks(false), false);
  assert.equal(shouldAcceptTasks(undefined), true); // 未设置默认开（对齐 shouldReport 的 fail-open）
});

test('storage key 常量稳定（camelCase 对齐 reportingEnabled）', () => {
  assert.equal(TASK_DISPATCH_KEY, 'taskDispatchEnabled');
});

test('防御拒绝文案稳定：任务类命令被拒时的回执 error（server 任务行展示）', () => {
  // 文案即协议：server 端 extNeedsUpdate 按回执 error 分类（不含 "unknown action" 即普通失败），
  // 该文案会落 collect_tasks.error 给用户看，改动需同步评估展示侧
  assert.equal(TASK_DISPATCH_DISABLED_ERROR, '任务派发已关闭（仅上报状态）');
});
