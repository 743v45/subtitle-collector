// ── 采集任务卡片统一出口（2026-10-05 拆分）──
// 共享逻辑（状态徽章/可重试判据/重试提交/toast 文案/格式化）→ taskCardShared.ts;
// 单任务卡 → TaskRow.tsx;批量聚合卡 → BatchTaskCard.tsx。
// 采集页（最近 30 条,轮询）与历史页（全量分页）及测试仍从本文件导入,路径不变。
// 重试:failed/limited 行与批次卡「重试未成功」按钮 → onRetry(该组未终态外的可重试任务);
// 上层经 resubmitTasks 重建任务(终态允许重采,pending/dispatched 由 server 去重跳过)。
export {
  STATUS_META,
  PLATFORM_LABEL,
  TIP_DELETE,
  TIP_RETRY,
  formatTs,
  resubmitTasks,
  resultSummary,
  retryable,
  retrySummary,
} from './taskCardShared';
export { TaskRow } from './TaskRow';
export { BatchTaskCard } from './BatchTaskCard';
