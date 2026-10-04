// asr-backfill worker（CLI 全功能 web 化 Phase 4）：把 CLI `asr backfill` 的编排装配进 server 进程。
// 复用而不复制：圈定/下载/转写全链路直接跑 cli/commands/asr.ts 的 runBackfill（纯依赖注入），
// server 侧只装配 BackfillClient 的 server-internal 实现（直查 DB + 复用 http/asr.ts 的写回），
// 与 CLI 走 HTTP 自调用的形态零行为分叉（同一套分类码：need_login / risk_control / no_audio /
// missing_play_uri / video_too_large / asr_error / submit_error / truncated / asr_empty）。
// 环境装配（容器部署无需改代码）：COLLECTOR_ASR_BASE_URL（默认 DEFAULT_ASR_API fireredasr 地址）、
// COLLECTOR_BILI_COOKIE_FILE（B 站 Cookie 文件；未配置 + bilibili → 提交时带 warning，不硬拦——
// douyin 无 cookie 依赖）、COLLECTOR_ASR_ENGINE（默认 DEFAULT_ENGINE）。
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { listVideosFiltered, type VideoSortKey } from '../db/advanced.js';
import { getVideo } from '../db/queries.js';
import { writeAsrVersion } from '../http/asr.js';
import {
  runBackfill, BILI_API, DEFAULT_ASR_API, DEFAULT_ENGINE,
  type BackfillClient, type BackfillDeps, type BackfillSummary,
} from '../cli/commands/asr.js';
import type { JobCtx } from './runner.js';

// 提交参数（http/jobs.ts 校验后入队；worker 内再防御性归一，双保险对齐 CLI 缺省值）
export interface AsrBackfillParams {
  source?: 'bilibili' | 'douyin';
  size?: number;        // 1..50，默认 5
  page?: number;        // >=1，默认 1
  max_duration?: number; // 秒，可选
  dry_run?: boolean;    // true 走同步圈定（handler 直答，不建 job——不会进 worker）
}

// ── 环境装配（http/jobs.ts 的 warning 判定也用 biliCookieConfigured）──

export function asrApiFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLLECTOR_ASR_BASE_URL ?? DEFAULT_ASR_API;
}
export function engineFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLLECTOR_ASR_ENGINE ?? DEFAULT_ENGINE;
}
// Cookie 文件读入（trim 后空/不可读 → undefined，按未配置处理——提交不拦，转写时 need_login 归因）
export function biliCookieFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const f = env.COLLECTOR_BILI_COOKIE_FILE;
  if (!f) return undefined;
  try { return readFileSync(f, 'utf-8').trim() || undefined; }
  catch (e) {
    console.warn(`[jobs:asr] cookie 文件不可读: ${f}（按未配置处理）: ${(e as Error).message}`);
    return undefined;
  }
}
export function biliCookieConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.COLLECTOR_BILI_COOKIE_FILE;
}

// ── BackfillClient 的 server-internal 实现（直查 DB，不经 HTTP 自调用）──
// 导出仅供测试直测映射分支（缺省参数回退 / 详情缺失归因）
export function serverBackfillClient(db: Database.Database): BackfillClient {
  return {
    // runBackfill 圈定参数 {tags:'no-subtitle', source, sort:'first_seen', desc:true, page, size, max_duration?}
    // → ListFilter 映射（tags 单值 → [单值]；sort 键集合与 CLI 同源 VIDEO_SORT_KEYS）
    async listVideos(params) {
      const p = params as { tags?: string; source?: string; sort?: string; desc?: boolean; page?: number; size?: number; max_duration?: number };
      const r = listVideosFiltered(db, {
        ...(p.tags ? { tags: [p.tags] } : {}),
        ...(p.source ? { source: p.source } : {}),
        ...(p.max_duration !== undefined ? { max_duration: p.max_duration } : {}),
        sort: (p.sort ?? 'first_seen') as VideoSortKey,
        desc: p.desc !== false,
        page: p.page ?? 1,
        size: p.size ?? 20,
      });
      return { total: r.total, items: r.items as unknown as Array<Record<string, unknown>> };
    },
    // 详情：对齐 ServerClient.getVideo 契约——回平视频行（extra 在行上，douyin 取 extra.play_uri），
    // 不是 {video,tracks} 包裹形态（包裹形态的 .extra 是 undefined → 恒 missing_play_uri）
    async getVideo(source, vid) {
      const detail = getVideo(db, source, vid);
      return detail ? (detail.video as Record<string, unknown>) : null;
    },
    // 写回 = 复用 HTTP POST /api/asr/submit 的同事务写入口径（insertTracksVersions + 摘标）。
    // 视频缺失抛错 → runBackfill 归类 submit_error（与 HTTP 404 语义对齐进失败计数）。
    async asrSubmit(source, vid, engine, cues) {
      const detail = getVideo(db, source, vid);
      if (!detail) throw new Error(`video not found: ${source}/${vid}`);
      return writeAsrVersion(db, detail.video.id as number, { source, vid, engine, cues });
    },
  };
}

// 圈定直答（POST /api/jobs dry_run=true 同步分支）：不建 job、不下载不转写，只回圈定清单。
// 与 client.listVideos 同一 SQL 口径（tags=no-subtitle + first_seen 倒序）。
export interface AsrDryRunItem { source_vid: string; title: string | null; duration: number | null }
export function dryRunCircle(db: Database.Database, p: AsrBackfillParams): AsrDryRunItem[] {
  const r = listVideosFiltered(db, {
    tags: ['no-subtitle'],
    ...(p.source ? { source: p.source } : {}),
    ...(p.max_duration !== undefined ? { max_duration: p.max_duration } : {}),
    sort: 'first_seen',
    desc: true,
    page: p.page ?? 1,
    size: p.size ?? 5,
  });
  return r.items.map((it) => ({ source_vid: it.source_vid, title: it.title, duration: it.duration }));
}

// worker 主入口（runner 按 type='asr-backfill' 分派）
export async function runAsrBackfillJob(ctx: JobCtx, rawParams: Record<string, unknown>): Promise<BackfillSummary> {
  const p = (rawParams ?? {}) as AsrBackfillParams;
  const source = p.source === 'douyin' ? 'douyin' : 'bilibili';
  const size = clampInt(p.size, 1, 50, 5);
  const page = clampInt(p.page, 1, Number.MAX_SAFE_INTEGER, 1);
  const maxDuration = typeof p.max_duration === 'number' && Number.isFinite(p.max_duration) && p.max_duration > 0
    ? p.max_duration : undefined;

  // 每视频步进 → progress_json {done,total,failed}（failed: 失败分类码 → 计数，实时累计）
  const liveFailed: Record<string, number> = {};
  const deps: BackfillDeps = {
    client: serverBackfillClient(ctx.db),
    biliApi: BILI_API,
    asrApi: asrApiFromEnv(),
    cookie: source === 'bilibili' ? biliCookieFromEnv() : undefined, // douyin 直链零 cookie（对齐 CLI）
    engine: engineFromEnv(),
    log: (msg) => console.log(`[jobs:asr job=${ctx.jobId}] ${msg}`),
    onStep: (info) => {
      if (!info.ok && info.code) liveFailed[info.code] = (liveFailed[info.code] ?? 0) + 1;
      ctx.onProgress({ done: info.done, total: info.total, failed: { ...liveFailed } });
    },
  };
  ctx.onProgress({ done: 0, total: 0, failed: {} });
  console.log(`[jobs:asr job=${ctx.jobId}] 执行 source=${source} size=${size} page=${page}${maxDuration !== undefined ? ` max_duration=${maxDuration}s` : ''} asrApi=${deps.asrApi} engine=${deps.engine}${source === 'bilibili' && !deps.cookie ? '（未配置 cookie，B 站转写将 need_login）' : ''}`);
  return await runBackfill(deps, { source, size, page, ...(maxDuration !== undefined ? { maxDuration } : {}), dryRun: !!p.dry_run });
}

// 正整数夹取（非法/越界 → 缺省）
function clampInt(v: unknown, min: number, max: number, dft: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) return dft;
  return Math.min(v, max);
}
