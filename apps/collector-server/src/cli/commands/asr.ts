// asr backfill：no-subtitle 兜底转写编排（圈定 → 平台音/视频获取 → fireredasr 转写 → server 写回 asr-zh-<engine> 轨）。
// --source 定平台（默认 bilibili 兼容既有用法）：bilibili 走 wbi/view/playurl 在线解析音轨；
// douyin 走入库 extra.play_uri 直构 snssdk 直链下载 mp4（R2 定案，2026-08-29 douyin 平台化）。
// 架构（对齐 translate fill）：全程走 server HTTP（圈定 GET /api/videos + 详情 GET /api/videos/:source/:vid
// + 写回 POST /api/asr/submit）——生产库在 docker volume，宿主 CLI 直读有 virtiofs 损库风险，读写一律经 server。
// 依赖注入的可测编排函数（runBackfill 接 client/fetchImpl/日志，CLI 装配注入真实现，测试注入 mock）；
// 分层：B 站解析 [asr-bili.ts](../asr-bili.ts) / 抖音解析+下载 [asr-douyin.ts](../asr-douyin.ts) /
// 网络 [asr-net.ts](../asr-net.ts) / 转写轮询 [asr-transcribe.ts](../asr-transcribe.ts)。措辞：字幕（subtitle），非弹幕。
//
// 可观察性（CLAUDE.md §9）：[circle]/[bili]/[douyin]/[download]/[asr]/[submit] 分步 stderr 日志 +
// 失败分类计数（need_login / risk_control / no_audio / missing_play_uri / video_too_large / asr_error /
// submit_error / other），汇总样例 vid——禁止「转写失败」这类无上下文报告。
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { getCliContext } from '../context.js';
import { emitResult, emitError, logInfo } from '../output.js';
import { ServerClient } from '../http.js';
import { segmentsToCues } from '../subtitleFormat.js';
import { parseViewCid, parsePlayurlAudio, wbiKeysFromNav } from '../asr-bili.js';
import { fetchBiliJson, downloadAudio, defaultSleep } from '../asr-net.js';
import { resolveDouyinVideoUrl, downloadDouyinVideo } from '../asr-douyin.js';
import { transcribeAt } from '../asr-transcribe.js';
import { buildPlayurlQuery } from '../wbi.js';

const BILI_API = 'https://api.bilibili.com';
const DEFAULT_ASR_API = 'http://127.0.0.1:5079';
export const DEFAULT_ENGINE = 'fireredasr-aed-l';
export { defaultSleep };

/** asr backfill 支持的平台（youtube 无本链路——其 no-subtitle 兜底不在 asr backfill 范围）。 */
export type AsrSource = 'bilibili' | 'douyin';

/** --source 参数校验：非法（含 youtube）→ null，调用方 emitError ARGS。 */
export function parseAsrSource(v: string): AsrSource | null {
  return v === 'bilibili' || v === 'douyin' ? v : null;
}

// ── 编排依赖（CLI 装配注入真实现；测试注入 mock）──
export interface BackfillClient {
  listVideos(params: Record<string, string | number | boolean>): Promise<{ total: number; items: Array<Record<string, unknown>> }>;
  getVideo(source: string, vid: string): Promise<Record<string, unknown> | null>; // 详情行（douyin 取 extra.play_uri）
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
  source: AsrSource;
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

// 单视频全链路（bilibili）：view→cid、playurl→音轨 URL、下载、转写、写回。返回恒带 wbiKeys（编排层跨视频缓存）。
async function processBiliVideo(deps: BackfillDeps, item: Record<string, unknown>, wbiKeys: WbiKeys): Promise<StepResult> {
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
  // 覆盖率校验（2026-08-26 实测踩坑）：playurl 降级 durl 可能给 30s 试看片段（音轨仅开头），
  // 转写末段远早于视频时长 → 拒入库（入了库会摘标，错误固化且不再可圈定）
  const covered = cues[cues.length - 1].to;
  if (covered < audio.duration * 0.5) {
    return { ok: false, code: 'truncated', message: `疑似试看片段：转写仅覆盖 ${Math.round(covered)}s / 视频 ${audio.duration}s（音轨被 B 站降级截断？）`, wbiKeys: keys };
  }

  try {
    const out = await deps.client.asrSubmit('bilibili', vid, deps.engine, cues);
    log(`[submit] ${vid} 写回 ${JSON.stringify(out)}`);
    return { ok: true, wbiKeys: keys };
  } catch (e) {
    return { ok: false, code: 'submit_error', message: (e as Error).message, wbiKeys: keys };
  }
}

// 单视频全链路（douyin）：详情取 extra.play_uri → 直构 snssdk 直链（asr-douyin）→ mp4 下载临时文件
// → 转写（fireredasr 内部 ffmpeg 抽音轨）→ 写回。无 wbi/cookie 依赖；mp4 走临时文件（几十上百 MB 是
// 常态，对齐磁盘缓冲形态；上传时才读回 Buffer，体积受 DOUYIN_MAX_VIDEO_BYTES 上限约束）。
async function processDouyinVideo(deps: BackfillDeps, item: Record<string, unknown>): Promise<StepResult> {
  const log = deps.log ?? logInfo;
  const vid = String(item.source_vid ?? '');
  const title = String(item.title ?? '').slice(0, 30);
  const duration = typeof item.duration === 'number' ? item.duration : 0; // 库存已是秒（S2/S3 入库归一）

  // 列表项不带 extra（server /api/videos 只富化标签/封面），play_uri 走详情端点取
  let video: Record<string, unknown> | null;
  try {
    video = await deps.client.getVideo('douyin', vid);
  } catch (e) {
    return { ok: false, code: 'detail_fetch_error', message: `详情拉取失败: ${(e as Error).message}`, wbiKeys: null };
  }
  const resolved = resolveDouyinVideoUrl(video?.extra);
  if ('error' in resolved) return { ok: false, code: 'missing_play_uri', message: resolved.error, wbiKeys: null };
  log(`[douyin] ${vid} 《${title}》 时长 ${duration > 0 ? `${duration}s` : '?'} → 直构直链下载 mp4`);

  const tmpDir = await mkdtemp(join(tmpdir(), 'collector-asr-douyin-'));
  try {
    const dest = join(tmpDir, `${vid}.mp4`);
    const dl = await downloadDouyinVideo(deps, resolved.url, dest);
    if (!dl.ok) return { ok: false, code: dl.code, message: dl.message, wbiKeys: null };
    log(`[download] ${vid} mp4 ${(dl.bytes / 1024 / 1024).toFixed(1)}MB（抖音无独立音轨，整段上传由 fireredasr 抽轨）`);

    const t = await transcribeAt(deps, { buf: await readFile(dest), filename: `${vid}.mp4` });
    if (!t.ok) return { ok: false, code: t.code, message: t.message, wbiKeys: null };
    const cues = segmentsToCues(t.segments);
    log(`[asr] ${vid} 转写完成 ${cues.length} 段`);
    if (cues.length === 0) return { ok: false, code: 'asr_empty', message: '转写完成但无有效段（全静音？）', wbiKeys: null };
    // 覆盖率校验（对齐 B 站 30s 试看防线）：末段 < duration×0.5 → truncated 拒入库（入库会摘标固化错误）；
    // duration 缺失（0）无从校验，放行入库
    const covered = cues[cues.length - 1].to;
    if (duration > 0 && covered < duration * 0.5) {
      return { ok: false, code: 'truncated', message: `疑似片段：转写仅覆盖 ${Math.round(covered)}s / 视频 ${duration}s（直链给的是片段？）`, wbiKeys: null };
    }
    try {
      const out = await deps.client.asrSubmit('douyin', vid, deps.engine, cues);
      log(`[submit] ${vid} 写回 ${JSON.stringify(out)}`);
      return { ok: true, wbiKeys: null };
    } catch (e) {
      return { ok: false, code: 'submit_error', message: (e as Error).message, wbiKeys: null };
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* 临时目录清理失败不掩盖主结果 */ });
  }
}

// ── 编排主函数（纯依赖注入，可测）──
export async function runBackfill(
  deps: BackfillDeps,
  opts: { size: number; page: number; maxDuration?: number; dryRun?: boolean; source?: AsrSource },
): Promise<BackfillSummary> {
  const log = deps.log ?? logInfo;
  const source = opts.source ?? 'bilibili'; // 缺省 bilibili 保底兼容既有用法
  // 圈定走 server HTTP（GET /api/videos，tags=no-subtitle 精确匹配，system 档 2026-08-26 起可查）；
  // 最新入库优先（first_seen 倒序）。转写成功即摘标 → 重跑自动只剩未完成的（天然断点续跑）。
  const page = await deps.client.listVideos({
    tags: 'no-subtitle', source, sort: 'first_seen', desc: true, page: opts.page, size: opts.size,
    ...(opts.maxDuration !== undefined ? { max_duration: opts.maxDuration } : {}),
  });
  log(`[circle] no-subtitle + ${source} 圈定 ${page.items.length}/${page.total}（page=${opts.page} size=${opts.size}${opts.maxDuration !== undefined ? ` max_duration=${opts.maxDuration}s` : ''}）`);
  const summary: BackfillSummary = {
    source, circled: page.items.length, done: 0, dry_run: !!opts.dryRun,
    failed: {}, samples: {},
  };
  if (opts.dryRun) {
    for (const it of page.items) log(`[circle] ${it.source_vid} 时长${it.duration ?? '?'}s 《${String(it.title ?? '').slice(0, 30)}》`);
    return summary;
  }
  let wbiKeys: WbiKeys = null; // B 站侧 nav→wbi keys 跨视频缓存；douyin 不用（恒 null 透传）
  for (const it of page.items) {
    const r: StepResult = source === 'douyin' ? await processDouyinVideo(deps, it) : await processBiliVideo(deps, it, wbiKeys);
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
    .description('无字幕视频兜底转写（no-subtitle 圈定 → 平台音/视频获取 → fireredasr 本地转写 → 写回 asr-zh-<engine> 轨）');

  cmd.command('backfill')
    .description('批量转写入库：no-subtitle 圈定的视频（--source 定平台；转写成功即摘标，重跑自动跳过已完成）')
    .option('--size <n>', '本轮处理条数（默认 5；先小样本实测速度再放量）', '5')
    .option('--page <n>', '圈定分页（默认 1，按入库时间倒序）', '1')
    .option('--max-duration <sec>', '只转不长于该秒数的视频（音/视频时长上限，控批量耗时）')
    .option('--source <src>', '视频来源平台：bilibili（默认，B 站 API 在线解析音轨）| douyin（extra.play_uri 直构直链下载 mp4）', 'bilibili')
    .option('--dry-run', '只圈定并打印清单，不下载不转写（预检圈定口径）')
    .option('--cookie-file <path>', 'B 站 Cookie 文件（文本原样作 Cookie 头；默认 $COLLECTOR_BILI_COOKIE_FILE；仅 --source bilibili）')
    .option('--asr-url <url>', `fireredasr 服务地址（默认 ${DEFAULT_ASR_API}）`, DEFAULT_ASR_API)
    .option('--engine <name>', `asr_engine 标记值，兼定轨名 asr-zh-<name>（默认 ${DEFAULT_ENGINE}）`, DEFAULT_ENGINE)
    .action(async (opts: { size?: string; page?: string; maxDuration?: string; dryRun?: boolean; source?: string; cookieFile?: string; asrUrl?: string; engine?: string }) => {
      const ctx = getCliContext();
      const source = parseAsrSource(opts.source ?? 'bilibili');
      if (!source) {
        emitError(`--source 必须是 bilibili/douyin（youtube 无 ASR backfill 链路）: ${opts.source}`, 'ARGS');
        return;
      }
      let cookie: string | undefined; // 仅 bilibili 需要（nav 取 wbi keys 要登录态）；douyin 直链零 cookie
      if (source === 'bilibili') {
        const cookieFile = opts.cookieFile ?? process.env.COLLECTOR_BILI_COOKIE_FILE;
        if (cookieFile) {
          try { cookie = readFileSync(cookieFile, 'utf-8').trim() || undefined; }
          catch { emitError(`cookie 文件不可读: ${cookieFile}`, 'ARGS'); return; }
        }
        if (!cookie) {
          logInfo('[bili] 未配置 cookie（--cookie-file / $COLLECTOR_BILI_COOKIE_FILE）——nav 取 wbi keys 即需登录态（2026-08-26 实测匿名 nav -101），无 cookie 必然 need_login');
        }
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
            dryRun: opts.dryRun === true, source,
          },
        );
        emitResult(out, ctx.format);
      } catch (err) {
        emitError(`asr backfill 失败: ${(err as Error).message}`, 'RUNTIME');
      }
    });

  return cmd;
}
