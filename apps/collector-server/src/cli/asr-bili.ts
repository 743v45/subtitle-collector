// asr backfill 的 B 站侧纯函数层（解析/判定，无 IO——网络在 [asr-net.ts](./asr-net.ts)，
// 转写在 [asr-transcribe.ts](./asr-transcribe.ts)，编排在 [commands/asr.ts](../commands/asr.ts)）。
// 语义对齐扩展 [subtitle-collector/bili-fetch.js](../../../subtitle-collector/bili-fetch.js) 的
// parseBiliResponse（code:0 → data；-101 need_login；-412 risk_control），移植到 CLI 侧 TS。
// 分层：宿主 CLI 直连 B 站只在 asr 兜底链路（server 不直连平台的分工不变）。
import { extractKeysFromNav } from './wbi.js';

/** B 站 API 响应归一化：ok=true 带 data；否则带分类码（need_login / risk_control / bili_xxx）。 */
export function parseBiliJson(body: unknown):
  { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const b = body as { code?: unknown; message?: unknown; data?: unknown };
  if (!b || typeof b.code !== 'number') return { ok: false, code: 'malformed', message: 'non-json or missing code' };
  if (b.code === 0 && b.data && typeof b.data === 'object') return { ok: true, data: b.data as Record<string, unknown> };
  if (b.code === -101) return { ok: false, code: 'need_login', message: 'cookie 失效或未登录' };
  if (b.code === -412) return { ok: false, code: 'risk_control', message: '请求被风控（-412）' };
  return { ok: false, code: `bili_${b.code}`, message: typeof b.message === 'string' ? b.message : '' };
}

/** view 接口响应 → 视频定位信息（P1 cid；多 P 视频标注 part_count 供编排层决策）。 */
export function parseViewCid(data: Record<string, unknown>): { cid: number; part_count: number; duration: number } | { error: string } {
  const cid = data.cid;
  const pages = data.pages;
  const duration = data.duration;
  if (typeof cid !== 'number' || !(cid > 0)) return { error: `view 响应缺 cid: cid=${String(cid)}` };
  const partCount = Array.isArray(pages) ? pages.length : 1;
  if (typeof duration !== 'number') return { error: `view 响应缺 duration: ${String(duration)}` };
  return { cid, part_count: partCount, duration };
}

type AudioPick = { base_url: string; id: number; kind: 'dash' | 'durl' } | { error: string };

// dash.audio[0]：DASH 纯音轨（首选，体积小）
function pickDashAudio(data: Record<string, unknown>): AudioPick | null {
  const first = (data.dash as { audio?: Array<{ baseUrl?: unknown; id?: unknown }> })?.audio?.[0];
  if (!(first && typeof first.baseUrl === 'string' && first.baseUrl)) return null;
  return { base_url: first.baseUrl, id: typeof first.id === 'number' ? first.id : -1, kind: 'dash' };
}

// durl[0]：整段音视频合一（FLV/MP4，ffmpeg 可抽音轨）——该账号 playurl 恒被降级到 durl
// （DASH 仅正常播放判定下发，2026-08-26 实测），单段可用；多段（长视频 FLV 分段）当前不支持
function pickDurlAudio(data: Record<string, unknown>): AudioPick | null {
  const durl = data.durl as Array<{ url?: unknown }> | undefined;
  if (!Array.isArray(durl) || durl.length === 0) return null;
  if (durl.length > 1) return { error: `playurl 走 durl 且分 ${durl.length} 段（FLV 分段长视频，当前仅支持单段）` };
  const url0 = durl[0]?.url;
  if (!(typeof url0 === 'string' && url0)) return null;
  return { base_url: url0, id: -1, kind: 'durl' };
}

/** playurl 响应 → 音轨来源（dash 首选 / durl 单段兜底；全无 → 带命中计数的可观察 error）。 */
export function parsePlayurlAudio(data: Record<string, unknown>): AudioPick {
  const dash = data.dash as { audio?: unknown[] } | undefined;
  const durl = data.durl as unknown[] | undefined;
  return pickDashAudio(data) ?? pickDurlAudio(data)
    ?? { error: `playurl 无可用音轨: dash.audio.length=${dash?.audio?.length ?? -1} durl.length=${durl?.length ?? -1}（充电视频加密墙或响应形态变化）` };
}

/** nav 接口的 data 层 → wbi keys（复用 wbi.ts extractKeysFromNav——其吃完整响应体，这里包一层 data；
 * 空串 = 匿名 nav 无 wbi_img（风控页特征），调用方应判空）。 */
export function wbiKeysFromNav(navData: Record<string, unknown>): { img_key: string; sub_key: string } {
  return extractKeysFromNav({ data: navData });
}

/** HTTP 412 / fetch 异常之外，B 站响应体级别的风控码判定（asr-net 退避决策用）。
 * 类型谓词：true 时收窄为失败形态（其 code 字段必然存在可读）。 */
export function isRiskControl(parsed: { ok: boolean; code?: string }): parsed is { ok: false; code?: string } {
  return !parsed.ok && (parsed.code === 'risk_control' || parsed.code === 'bili_-412');
}
