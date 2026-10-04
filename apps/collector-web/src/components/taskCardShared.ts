// ── 采集任务卡共享逻辑（2026-10-05 从 TaskCards.tsx 拆出：采集页/历史页共用契约）──
// 状态徽章元数据 / 平台标签 / 可重试判据 / 重试提交 / toast 汇总文案 / 时间与回执摘要格式化 /
// 操作图标 tooltip 统一文案。单任务卡见 TaskRow.tsx,批量聚合卡见 BatchTaskCard.tsx,
// 统一出口 TaskCards.tsx（页面 import 路径不变）。
// 重试:failed/limited 行与批次卡「重试未成功」按钮 → onRetry(该组可重试任务);
// 上层经 resubmitTasks 重建任务(终态允许重采,pending/dispatched 由 server 去重跳过)。
import { requestTaskNotifyPermission } from '@/lib/taskNotify';
import { retryCollectTasks } from '../api';
import type { CollectTask } from '../types';

// 任务状态徽章文案与配色（pending 细分「等待扩展上线/排队中」由客户端数区分,这里统一显示）。
// 暗色主题：x-500/15 底 + x-400 字（暗底对比 7-9:1）。
export const STATUS_META: Record<CollectTask['status'], { label: string; className: string }> = {
  pending: { label: '排队中', className: 'bg-amber-500/15 text-amber-400' },
  dispatched: { label: '采集中', className: 'bg-blue-500/15 text-blue-400' },
  succeeded: { label: '已完成', className: 'bg-emerald-500/15 text-emerald-400' },
  failed: { label: '失败', className: 'bg-red-500/15 text-red-400' },
  limited: { label: '受限', className: 'bg-amber-500/15 text-amber-400' },
};

export const PLATFORM_LABEL: Record<string, string> = { bilibili: 'B站', youtube: 'YouTube', douyin: '抖音' };

// 行尾操作图标 tooltip 统一文案（写清行为后果;单卡与批次卡子行共用,2026-10-05 全量补齐）
export const TIP_RETRY = '重试采集：该行重置回排队中重跑（不新建任务记录）';
export const TIP_DELETE = '删除任务：移除该条任务记录，不影响已入库视频与字幕';

// 可重试判据:终态且产出不全（failed / limited——字幕受限 0 轨）。succeeded 的 no_subtitle 是真无字幕,不可重试。
export function retryable(t: CollectTask): boolean {
  return t.status === 'failed' || t.status === 'limited';
}

// 重试提交（2026-08-22 抽取两页共用；同日改为原地重置）：failed/limited 行经 retry 端点重置回
// pending 原行重跑——不建新行，批次卡/聚焦视图/进度徽章随原行实时更新（旧方案新建行挂原批，
// 原失败行永不更新，批次徽章永远停在「失败」）。在途/succeeded 行 server 端逐个跳过。
// 返回统计供调用方 toast：alreadyOk=库内已有字幕直接标记成功（免重采），dispatched=重新下发。
// 顺带在用户手势内请求通知授权——重试后跑完要能弹系统提醒。
export async function resubmitTasks(list: CollectTask[]): Promise<{ dispatched: number; alreadyOk: number }> {
  const ids = list.filter(retryable).map((t) => t.id);
  if (ids.length === 0) return { dispatched: 0, alreadyOk: 0 };
  requestTaskNotifyPermission();
  const r = await retryCollectTasks(ids);
  const alreadyOk = r.tasks.filter((t) => t.status === 'succeeded').length; // already_collected 短路
  return { dispatched: r.retried - alreadyOk, alreadyOk };
}

// 重试结果 → toast 文案（两页共用）
export function retrySummary({ dispatched, alreadyOk }: { dispatched: number; alreadyOk: number }): string {
  if (dispatched > 0 && alreadyOk > 0) return `已重新下发 ${dispatched} 个任务；${alreadyOk} 个库内已有字幕，直接标记成功`;
  if (alreadyOk > 0) return `${alreadyOk} 个任务库内已有字幕，已直接标记成功（免重采）`;
  if (dispatched > 0) return `已重试 ${dispatched} 个任务（扩展在线即开始采集）`;
  return '没有可重试的任务（可能已在队列中）';
}

export function formatTs(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// 扩展回执 result（JSON 字符串）→ 摘要文案
export function resultSummary(task: CollectTask): string {
  if (task.status === 'failed') return task.error ?? '采集失败';
  if (task.status === 'limited') return '字幕受限（pot），0 轨入库；元信息已入库，可重试';
  if (task.status === 'pending') return '等待派发（扩展上线后自动开始）';
  if (!task.result) return task.status === 'dispatched' ? '已下发到扩展…' : '';
  try {
    const r = JSON.parse(task.result) as { captured?: number; tracks?: number; reason?: string };
    if (r.reason === 'no_subtitle') return '视频无字幕轨';
    if (r.reason === 'pot_limited') return '字幕受限（pot），0 轨入库';
    if (r.reason === 'already_collected') return `库内已有字幕（${r.tracks} 轨），重试免重采`; // retryTask 查库短路
    if (typeof r.captured === 'number') return `采到 ${r.captured} 轨字幕`; // YouTube 回执
    if (typeof r.tracks === 'number') return `采到 ${r.tracks} 轨字幕`;     // B 站回执
  } catch { /* 非预期结构忽略 */ }
  return '';
}
