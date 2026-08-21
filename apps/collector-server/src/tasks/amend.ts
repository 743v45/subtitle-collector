import type Database from 'better-sqlite3';

// 迟到回执改判：命令超时已落 failed 的任务，扩展实际执行完成（result 迟到、INGEST 可能已落库）
// → 改判 succeeded。独立模块（不 import ws/server）：ws/server 迟到 result 处理调用本函数，
// 放 tasks.ts 会与 tasks → ws/server 的 import 构成循环。
//
// 定位方式：命令 params 携带 (bvid | videoId) → (source, source_vid)，匹配该视频最近一条
// 「超时失败」任务（error 精确等于 dispatchTask 超时落库的固定文案「扩展执行超时」；普通失败
// 是扩展 error 原文，可能恰含「超时」二字，子串匹配会把别人的失败行误改判成功）；只有 ok 的
// 迟到回执才改判（迟到失败不改变已落的 failed）。
// 改判成功后的 task-update 推送由调用方（ws/server）做——本模块保持无 ws 依赖。

export interface LateResultParams {
  bvid?: unknown;
  videoId?: unknown;
}
export interface LateResultPayload {
  ok: boolean;
  data?: unknown;
  error?: unknown; // 迟到失败回执携带（当前不改判，保留形状与真实回执一致）
}

// @returns 改判的任务 id（未改判为 null）；调用方据此推送 task-update 并打日志
export function amendLateResult(db: Database.Database, params: LateResultParams, result: LateResultPayload): number | null {
  const source = params.videoId != null ? 'youtube' : params.bvid != null ? 'bilibili' : null;
  if (!source) return null;
  const vid = String(source === 'youtube' ? params.videoId : params.bvid);
  if (!vid) return null;
  if (!result.ok) return null; // 迟到失败回执：failed 已落，不改判
  const row = db.prepare(
    "SELECT id FROM collect_tasks WHERE source = ? AND source_vid = ? AND status = 'failed' AND error = '扩展执行超时' ORDER BY id DESC LIMIT 1",
  ).get(source, vid) as { id: number } | undefined;
  if (!row) return null;
  db.prepare(
    "UPDATE collect_tasks SET status = 'succeeded', result = ?, error = NULL, finished_at = ? WHERE id = ? AND status = 'failed'",
  ).run(JSON.stringify(result.data ?? {}), Date.now(), row.id);
  return row.id;
}
