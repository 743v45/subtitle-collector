// apps/subtitle-collector/task-dispatch.mjs
// 任务派发开关（关 = 仅上报状态）的纯逻辑（不依赖 chrome.*，便于 node:test）。
// storage key 用 camelCase 对齐现有 reportingEnabled；WS 协议字段用 snake_case
// （hello.task_dispatch_enabled / task-dispatch-state / set-task-dispatch），由 background 转换。

export const TASK_DISPATCH_KEY = "taskDispatchEnabled";

/** 决定是否接受 server 任务派发；flag 非 false 一律放行（fail-open，默认开，对齐 shouldReport） */
export function shouldAcceptTasks(flag) {
  return flag !== false;
}

/**
 * 防御拒绝回执文案：开关关闭期间收到 fetch-subtitle / fetch-youtube-subtitle
 * （旧 server 不识别新字段照派 / 旁路派发）时按此回执失败。会落 collect_tasks.error
 * 展示给用户，改动需同步评估 server/web 展示侧。
 */
export const TASK_DISPATCH_DISABLED_ERROR = "任务派发已关闭（仅上报状态）";
