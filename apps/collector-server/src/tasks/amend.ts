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

// 迟到 INGEST 改判：与迟到回执互补的另一条补救路径——扩展自限超时（「YouTube 采集超时（Ns）」，
// 数字随 timeoutMs 变）落 failed 后 tab 仍开着，content-yt 的被动 INGEST 稍后把字幕轨实际
// 入库，此时没有任何 result 回执可等，只能靠 INGEST 本身触发改判。
export interface LateIngestInfo {
  source: string;
  source_vid: string;
  inserted_tracks: number; // 本次 INGEST 实际新增轨数（ingestVideo 返回值）
}

// 触发门槛：inserted_tracks > 0——0 产出（仅元信息/全部已存在）不证明任务实际完成，不改判。
// 超时类匹配在「扩展执行超时」之外加前缀 LIKE「YouTube 采集超时（%」：该文案仅由扩展
// collectYoutubeViaNavigate 的自限超时抛出（秒数可变，无法精确匹配），普通业务失败文案
// （如「请求超时」）不会以「YouTube 采集超时（」开头，前缀匹配足够精确。
//
// @returns 改判的任务 id（未改判为 null）；调用方据此推送 task-update 并打日志
export function amendLateIngest(db: Database.Database, ingest: LateIngestInfo): number | null {
  if (ingest.inserted_tracks <= 0) return null;
  const row = db.prepare(
    "SELECT id FROM collect_tasks WHERE source = ? AND source_vid = ? AND status = 'failed' AND (error = '扩展执行超时' OR error LIKE 'YouTube 采集超时（%') ORDER BY id DESC LIMIT 1",
  ).get(ingest.source, ingest.source_vid) as { id: number } | undefined;
  if (!row) return null;
  // result 与扩展真实回执同形状（web 端 TaskCards resultSummary 读 captured/tracks）：
  // captured = 本次新增轨数，tracks = 该视频库内当前总轨数（JOIN videos 定位 source_vid）
  const tracks = (db.prepare(
    'SELECT COUNT(*) AS n FROM subtitle_tracks st JOIN videos v ON v.id = st.video_id WHERE v.source = ? AND v.source_vid = ?',
  ).get(ingest.source, ingest.source_vid) as { n: number }).n;
  const result = {
    ...(ingest.source === 'youtube' ? { videoId: ingest.source_vid } : { bvid: ingest.source_vid }),
    captured: ingest.inserted_tracks,
    tracks,
    navigated: true,
    reused: false,
    amended: 'late-ingest', // 标记改判来源，区别于真实回执
  };
  db.prepare(
    "UPDATE collect_tasks SET status = 'succeeded', result = ?, error = NULL, finished_at = ? WHERE id = ? AND status = 'failed'",
  ).run(JSON.stringify(result), Date.now(), row.id);
  return row.id;
}
