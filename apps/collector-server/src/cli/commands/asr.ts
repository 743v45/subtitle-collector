// asr backfill：no-subtitle 兜底转写编排（圈定 → B 站音轨 → fireredasr 转写 → server 写回 asr-zh 轨）。
// 架构（对齐 translate fill）：全程走 server HTTP（圈定 GET /api/videos + 写回 POST /api/asr/submit）——
// 生产库在 docker volume，宿主 CLI 直读有 virtiofs 损库风险，读写一律经 server。
// 依赖注入的可测编排函数（runBackfill 接 client/fetchImpl/日志，CLI 装配注入真实现，测试注入 mock）；
// 分层：B 站解析 [asr-bili.ts](../asr-bili.ts) / 网络 [asr-net.ts](../asr-net.ts) /
// 转写轮询 [asr-transcribe.ts](../asr-transcribe.ts)。措辞：字幕（subtitle），非弹幕。
//
// 可观察性（CLAUDE.md §9）：[circle]/[bili]/[download]/[asr]/[submit] 分步 stderr 日志 +
// 失败分类计数（need_login / risk_control / no_audio / asr_error / submit_error / other），
// 汇总样例 vid——禁止「转写失败」这类无上下文报告。
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { getCliContext } from '../context.js';
import { emitResult, emitError, logInfo } from '../output.js';
import { ServerClient } from '../http.js';
import { segmentsToCues } from '../subtitleFormat.js';
import { parseViewCid, parsePlayurlAudio, wbiKeysFromNav } from '../asr-bili.js';
import { fetchBiliJson, downloadAudio, defaultSleep } from '../asr-net.js';
import { transcribeAt } from '../asr-transcribe.js';
import { buildPlayurlQuery } from '../wbi.js';

const BILI_API = 'https://api.bilibili.com';
const DEFAULT_ASR_API = 'http://127.0.0.1:5079';
export const DEFAULT_ENGINE = 'fireredasr-aed-l';
export { defaultSleep };

// ── 编排依赖（CLI 装配注入真实现；测试注入 mock）──
export interface BackfillClient {
  listVideos(params: Record<string, string | number | boolean>): Promise<{ total: number; items: Array<Record<string, unknown>> }>;
  asrSubmit(source: string, vid: string, engine: string, cues: Array<{ from: number; to: number; content: string }>): Promise<unknown>;
}

export interface BackfillDeps {
  client: BackfillClient;
  biliApi?: string;          // 默认 BILI_API（测试指向 mock B 站）
  asrApi: string;            // fireredasr-ui 基地址
  cookie?: string;           // Cookie 头原样值（cookie-file 内容）
  engine: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  pollDeadlineMs?: number;   // 转写轮询上限（默认 POLL_DEADLINE_MS；测试注入 0 触发超时分支）
}

export interface BackfillSummary {
  circled: number;
  done: number;
  dry_run: boolean;
  failed: Record<string, number>;
  samples: Record<string, string[]>;
}

type WbiKeys = { img_key: string; sub_key: string } | null;
type StepResult = { ok: true; wbiKeys: WbiKeys } | { ok: false; code: string; message: string; wbiKeys: WbiKeys };

// nav → wbi keys（进程内缓存；实测 2026-08 匿名 nav 恒 -101，cookie 必配）
async function resolveWbiKeys(deps: BackfillDeps, biliApi: string, cached: WbiKeys): Promise<{ keys: WbiKeys; error?: { code: string; message: string } }> {
  if (cached && cached.img_key) return { keys: cached };
  const nav = await fetchBiliJson(deps, `${biliApi}/x/web-interface/nav`);
  if (!nav.ok) return { keys: cached, error: { code: nav.code, message: `nav: ${nav.message}` } };
  const keys = wbiKeysFromNav(nav.data);
  if (!keys.img_key) return { keys: cached, error: { code: 'no_wbi_keys', message: 'nav 响应缺 wbi_img（风控页特征）' } };
  return { keys };
}

// view→cid → playurl→音轨来源（dash/durl 双形态解析在 asr-bili）
async function resolveAudioUrl(deps: BackfillDeps, biliApi: string, vid: string, keys: NonNullable<WbiKeys>): Promise<{ url: string; kind: string; id: number; cid: number; duration: number; partCount: number } | { error: { code: string; message: string } }> {
  const log = deps.log ?? logInfo;
  const view = await fetchBiliJson(deps, `${biliApi}/x/web-interface/view?bvid=${encodeURIComponent(vid)}`);
  if (!view.ok) return { error: { code: view.code, message: `view: ${view.message}` } };
  const v = parseViewCid(view.data);
  if ('error' in v) return { error: { code: 'no_cid', message: v.error } };
  if (v.part_count > 1) log(`[bili] ${vid} 多 P 视频（${v.part_count} P），仅转 P1`);
  const playurl = await fetchBiliJson(deps, `${biliApi}/x/player/wbi/playurl?${buildPlayurlQuery(vid, v.cid, keys.img_key, keys.sub_key)}`);
  if (!playurl.ok) return { error: { code: playurl.code, message: `playurl: ${playurl.message}` } };
  const audio = parsePlayurlAudio(playurl.data);
  if ('error' in audio) return { error: { code: 'no_audio', message: audio.error } };
  return { url: audio.base_url, kind: audio.kind, id: audio.id, cid: v.cid, duration: v.duration, partCount: v.part_count };
}

// 单视频全链路：view→cid、playurl→音轨 URL、下载、转写、写回。返回恒带 wbiKeys（编排层跨视频缓存）。
async function processVideo(deps: BackfillDeps, item: Record<string, unknown>, wbiKeys: WbiKeys): Promise<StepResult> {
  const log = deps.log ?? logInfo;
  const biliApi = deps.biliApi ?? BILI_API;
  const vid = String(item.source_vid ?? '');
  const title = String(item.title ?? '').slice(0, 30);

  const { keys, error: navErr } = await resolveWbiKeys(deps, biliApi, wbiKeys);
  if (navErr) return { ok: false, code: navErr.code, message: navErr.message, wbiKeys };
  const audio = await resolveAudioUrl(deps, biliApi, vid, keys!);
  if ('error' in audio) return { ok: false, code: audio.error.code, message: audio.error.message, wbiKeys: keys };
  log(`[bili] ${vid} cid=${audio.cid} 《${title}》 时长 ${audio.duration}s`);

  const dl = await downloadAudio(deps, audio.url);
  if (!dl.ok) return { ok: false, code: dl.code, message: dl.message, wbiKeys: keys };
  log(`[download] ${vid} 音轨 ${(dl.buf.length / 1024 / 1024).toFixed(1)}MB（${audio.kind}${audio.kind === 'dash' ? ` id=${audio.id}` : ' 音视频合一,ffmpeg 抽轨'}）`);

  const t = await transcribeAt(deps, { buf: dl.buf, filename: `${vid}.${audio.kind === 'dash' ? 'm4s' : 'mp4'}` });
  if (!t.ok) return { ok: false, code: t.code, message: t.message, wbiKeys: keys };
  const cues = segmentsToCues(t.segments);
  log(`[asr] ${vid} 转写完成 ${cues.length} 段`);
  if (cues.length === 0) return { ok: false, code: 'asr_empty', message: '转写完成但无有效段（全静音？）', wbiKeys: keys };

  try {
    const out = await deps.client.asrSubmit('bilibili', vid, deps.engine, cues);
    log(`[submit] ${vid} 写回 ${JSON.stringify(out)}`);
    return { ok: true, wbiKeys: keys };
  } catch (e) {
    return { ok: false, code: 'submit_error', message: (e as Error).message, wbiKeys: keys };
  }
}

// ── 编排主函数（纯依赖注入，可测）──
export async function runBackfill(
  deps: BackfillDeps,
  opts: { size: number; page: number; maxDuration?: number; dryRun?: boolean },
): Promise<BackfillSummary> {
  const log = deps.log ?? logInfo;
  // 圈定走 server HTTP（GET /api/videos，tags=no-subtitle 精确匹配，system 档 2026-08-26 起可查）；
  // 最新入库优先（first_seen 倒序）。转写成功即摘标 → 重跑自动只剩未完成的（天然断点续跑）。
  const page = await deps.client.listVideos({
    tags: 'no-subtitle', source: 'bilibili', sort: 'first_seen', desc: true, page: opts.page, size: opts.size,
    ...(opts.maxDuration !== undefined ? { max_duration: opts.maxDuration } : {}),
  });
  log(`[circle] no-subtitle + bilibili 圈定 ${page.items.length}/${page.total}（page=${opts.page} size=${opts.size}${opts.maxDuration !== undefined ? ` max_duration=${opts.maxDuration}s` : ''}）`);
  const summary: BackfillSummary = {
    circled: page.items.length, done: 0, dry_run: !!opts.dryRun,
    failed: {}, samples: {},
  };
  if (opts.dryRun) {
    for (const it of page.items) log(`[circle] ${it.source_vid} 时长${it.duration ?? '?'}s 《${String(it.title ?? '').slice(0, 30)}》`);
    return summary;
  }
  let wbiKeys: WbiKeys = null;
  for (const it of page.items) {
    const r = await processVideo(deps, it, wbiKeys);
    if (r.wbiKeys) wbiKeys = r.wbiKeys; // 成败都回传（成功不更新缓存会重复拉 nav）
    if (r.ok) { summary.done++; continue; }
    summary.failed[r.code] = (summary.failed[r.code] ?? 0) + 1;
    (summary.samples[r.code] ??= []).push(String(it.source_vid));
    log(`[fail] ${String(it.source_vid)} ${r.code}: ${r.message}`);
  }
  log(`[summary] 圈定 ${summary.circled}，成功 ${summary.done}，失败 ${JSON.stringify(summary.failed)}`);
  return summary;
}

// ── commander 装配 ──
export function buildAsrCommand(): Command {
  const cmd = new Command('asr')
    .description('无字幕视频兜底转写（no-subtitle 圈定 → B 站音轨 → fireredasr 本地转写 → 写回 asr-zh 轨）');

  cmd.command('backfill')
    .description('批量转写入库：no-subtitle 圈定的 B 站视频（转写成功即摘标，重跑自动跳过已完成）')
    .option('--size <n>', '本轮处理条数（默认 5；先小样本实测速度再放量）', '5')
    .option('--page <n>', '圈定分页（默认 1，按入库时间倒序）', '1')
    .option('--max-duration <sec>', '只转不长于该秒数的视频（音轨时长上限，控批量耗时）')
    .option('--dry-run', '只圈定并打印清单，不下载不转写（预检圈定口径）')
    .option('--cookie-file <path>', 'B 站 Cookie 文件（文本原样作 Cookie 头；默认 $COLLECTOR_BILI_COOKIE_FILE）')
    .option('--asr-url <url>', `fireredasr 服务地址（默认 ${DEFAULT_ASR_API}）`, DEFAULT_ASR_API)
    .option('--engine <name>', `asr_engine 标记值（默认 ${DEFAULT_ENGINE}）`, DEFAULT_ENGINE)
    .action(async (opts: { size?: string; page?: string; maxDuration?: string; dryRun?: boolean; cookieFile?: string; asrUrl?: string; engine?: string }) => {
      const ctx = getCliContext();
      const cookieFile = opts.cookieFile ?? process.env.COLLECTOR_BILI_COOKIE_FILE;
      let cookie: string | undefined;
      if (cookieFile) {
        try { cookie = readFileSync(cookieFile, 'utf-8').trim() || undefined; }
        catch { emitError(`cookie 文件不可读: ${cookieFile}`, 'ARGS'); return; }
      }
      if (!cookie) {
        logInfo('[bili] 未配置 cookie（--cookie-file / $COLLECTOR_BILI_COOKIE_FILE）——nav 取 wbi keys 即需登录态（2026-08-26 实测匿名 nav -101），无 cookie 必然 need_login');
      }
      try {
        const out = await runBackfill(
          {
            client: new ServerClient(ctx.serverUrl, ctx.token),
            asrApi: opts.asrUrl ?? DEFAULT_ASR_API, cookie, engine: opts.engine ?? DEFAULT_ENGINE,
          },
          {
            size: Number(opts.size ?? 5), page: Number(opts.page ?? 1),
            maxDuration: opts.maxDuration !== undefined ? Number(opts.maxDuration) : undefined,
            dryRun: opts.dryRun === true,
          },
        );
        emitResult(out, ctx.format);
      } catch (err) {
        emitError(`asr backfill 失败: ${(err as Error).message}`, 'RUNTIME');
      }
    });

  return cmd;
}
