// asr backfill 的抖音侧：直链解析纯函数 + mp4 流式下载。拆层对齐 [asr-bili.ts](./asr-bili.ts)
// （B 站是 view/playurl 两跳 API 解析出音轨 URL；抖音是入库 extra.play_uri 直构直链，无需在线解析）；
// 网络退避复用 [asr-net.ts](./asr-net.ts) withRiskRetry；编排在 [commands/asr.ts](./commands/asr.ts)；
// 转写轮询 [asr-transcribe.ts](./asr-transcribe.ts) 平台无关直接复用。
//
// 直链主链（S1 spike 实测 2026-08-29，[spike-findings.md](../../../docs/plans/douyin/spike-findings.md) §4）：
//   extra.play_uri（= detail 响应 video.play_addr.uri，稳定 video_id）
//   → https://aweme.snssdk.com/aweme/v1/play/?video_id=<uri>&ratio=1080p&line=0
//   → 302 → douyinvod CDN → 206 video/mp4（H.264+AAC）。裸 curl 零 UA 零 cookie 即通——UA/Referer
//   是礼貌头而非通过条件。抖音无独立音轨 URL，mp4 整段上传由 fireredasr 内部 ffmpeg 抽音轨。
// 降级链预留（未实现）：extra.play_addr.url_list 现取——URL 带过期参数短时效，须扩展在线重解析
//   （web 端 URL 无 playwm，playwm→play 替换不需要）；主链直构即可，降级归扩展代理链路（DOUYIN-PROGRESS R2）。
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { BILI_HEADERS, withRiskRetry, type NetDeps } from './asr-net.js';

// 礼貌头（非通过条件，见文件头）：Chrome UA 复用 B 站侧常量，Referer 换抖音站
export const DOUYIN_HEADERS: Record<string, string> = {
  'User-Agent': BILI_HEADERS['User-Agent']!,
  'Referer': 'https://www.douyin.com/',
};

// 直构参数（spike §4 #5：ratio 换档生效、line 双线路都通）。1080p 是实测主链档位——
// ASR 只需音轨，若下载体量成为瓶颈可降 540p（档位已验证可用，体积约减半）
const DOUYIN_PLAY_ORIGIN = 'https://aweme.snssdk.com/aweme/v1/play/';
export const DOUYIN_PLAY_RATIO = '1080p';
export const DOUYIN_PLAY_LINE = 0;

// 抖音无独立音轨，mp4 整段下载再上传——几十上百 MB 是常态。上限 500MB：fireredasr 内部要
// 全量转 16k wav 再落盘，超大视频会同时占满本机磁盘与转写队列（30min 音频转写就要 ~6min）；
// 超限跳过计 video_too_large（不重试——重试不会变小的体积问题），确需转写人工分段处理。
export const DOUYIN_MAX_VIDEO_BYTES = 500 * 1024 * 1024;

/** extra.play_uri（稳定 video_id）直构 snssdk 直链（spike 实测主链 #1）。 */
export function buildDouyinPlayUrl(playUri: string): string {
  const qs = new URLSearchParams({ video_id: playUri, ratio: DOUYIN_PLAY_RATIO, line: String(DOUYIN_PLAY_LINE) });
  return `${DOUYIN_PLAY_ORIGIN}?${qs.toString()}`;
}

// extra 兼容双形态：server 详情端点的 video.extra 是 JSON 字符串（TEXT 列），编排层 mock 常直接给对象。
// 非法 JSON / 非对象 → null（调用方归一为 missing_play_uri 分类）。
function parseDouyinExtra(extra: unknown): Record<string, unknown> | null {
  if (typeof extra === 'string') {
    try {
      const parsed: unknown = JSON.parse(extra);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch { return null; }
  }
  return extra && typeof extra === 'object' ? (extra as Record<string, unknown>) : null;
}

/** 视频行 extra → 直链。无 play_uri → 带可观察上下文的 error（键名列表助判结构漂移，分类 missing_play_uri）。 */
export function resolveDouyinVideoUrl(extra: unknown): { url: string } | { error: string } {
  const obj = parseDouyinExtra(extra);
  const playUri = obj?.play_uri;
  if (typeof playUri !== 'string' || !playUri) {
    return { error: `extra 无 play_uri（采集入库未存或结构变化；extra 键: ${obj ? Object.keys(obj).slice(0, 8).join(',') : '解析失败/空'}）` };
  }
  return { url: buildDouyinPlayUrl(playUri) };
}

// 下载超上限专用错误（与网络异常区分：分类 video_too_large 而非 download_error）
class DouyinTooLargeError extends Error {
  constructor(bytes: number, maxBytes: number) {
    super(`视频已收 ${bytes} 字节超过上限 ${maxBytes}，断流`);
  }
}

// 流式落盘（不进内存）+ 边下边计数，超限即 cb(error) 断流（pipeline 冒泡为 TooLarge）
async function writeCappedFile(body: ReadableStream<Uint8Array> | null, dest: string, maxBytes: number): Promise<number> {
  if (!body) throw new Error('下载响应无 body');
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(body as unknown as NodeWebReadableStream),
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) cb(new DouyinTooLargeError(bytes, maxBytes));
        else cb(null, chunk);
      },
    }),
    createWriteStream(dest),
  );
  return bytes;
}

export type DouyinDownloadResult =
  | { ok: true; bytes: number }
  | { ok: false; code: string; message: string };

// 单次下载尝试。403/412 视作可退避重试的拦截形态（复用 B 站 412 的 withRiskRetry 三档序列）——
// 抖音直链实测零 cookie 即通，403 更可能是偶发拦截，退避后仍失败归 download_http_XXX；
// 其余非 2xx 不重试（404=uri 失效、5xx=CDN 故障，重试无意义）。
async function attemptDouyinDownload(
  deps: NetDeps & { maxBytes: number }, url: string, dest: string,
): Promise<{ ok: true; bytes: number; risk: boolean } | { ok: false; code: string; message: string; risk: boolean }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, { headers: DOUYIN_HEADERS });
    if (res.status === 403 || res.status === 412) {
      return { ok: false, code: `download_http_${res.status}`, message: `mp4 下载 HTTP ${res.status}`, risk: true };
    }
    if (!res.ok) return { ok: false, code: `download_http_${res.status}`, message: `mp4 下载 HTTP ${res.status}`, risk: false };
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > deps.maxBytes) {
      return { ok: false, code: 'video_too_large', message: `视频 ${lenHeader} 字节超上限 ${deps.maxBytes}（content-length 预检拦截，未下载）`, risk: false };
    }
    try {
      const bytes = await writeCappedFile(res.body, dest, deps.maxBytes);
      return { ok: true, bytes, risk: false };
    } catch (e) {
      if (e instanceof DouyinTooLargeError) return { ok: false, code: 'video_too_large', message: e.message, risk: false };
      return { ok: false, code: 'download_error', message: `mp4 落盘失败: ${(e as Error).message}`, risk: false };
    }
  } catch (e) {
    return { ok: false, code: 'download_error', message: (e as Error).message, risk: false };
  }
}

/** mp4 流式下载到 dest（磁盘文件不进内存，上传时才读回 Buffer）。失败清残留半文件。 */
export async function downloadDouyinVideo(
  deps: NetDeps & { maxBytes?: number }, url: string, dest: string,
): Promise<DouyinDownloadResult> {
  const full: NetDeps & { maxBytes: number } = { ...deps, maxBytes: deps.maxBytes ?? DOUYIN_MAX_VIDEO_BYTES };
  const r = await withRiskRetry(full, () => attemptDouyinDownload(full, url, dest), '[douyin]');
  if (r.ok) return { ok: true, bytes: r.bytes };
  await rm(dest, { force: true }).catch(() => { /* 清理失败不掩盖主错误 */ });
  return r.risk ? { ok: false, code: r.code, message: `${r.message}（三档退避后仍失败）` } : { ok: false, code: r.code, message: r.message };
}
