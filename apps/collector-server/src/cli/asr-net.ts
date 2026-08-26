// asr backfill 的 B 站网络层（风控退避重试 + 音轨下载，2026-08-26 为控新文件复杂度自 commands/asr.ts 拆出）。
// 解析纯函数在 [asr-bili.ts](./asr-bili.ts)，转写轮询在 [asr-transcribe.ts](./asr-transcribe.ts)。
import { parseBiliJson, isRiskControl } from './asr-bili.js';

// 浏览器 UA + Referer：B 站 API 对裸 Node UA 敏感（对齐扩展 fetch 由 Chrome 发的请求特征）
export const BILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Accept': 'application/json',
};
// 412 风控退避序列（秒），照 [verify-audio-extract.mjs](../../../scripts/verify-audio-extract.mjs) 先例
export const RISK_BACKOFF_MS = [30_000, 120_000, 300_000];

export interface NetDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export function biliHeaders(cookie?: string): Record<string, string> {
  return { ...BILI_HEADERS, ...(cookie ? { Cookie: cookie } : {}) };
}

export function defaultSleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 风控退避通用重试：attempt 每轮跑一次 fn(result)，结果风控（isRiskControl 或 HTTP 412 标记）则退避重试。
 * fn 返回非风控结果即短路返回；三档退避（30s/2min/5min）后返回最后一次结果。
 */
export async function withRiskRetry<T extends { risk?: boolean }>(
  deps: NetDeps, fn: () => Promise<T>,
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? (() => {});
  let last = await fn();
  for (let attempt = 0; attempt < RISK_BACKOFF_MS.length && last.risk; attempt++) {
    log(`[bili] 风控，退避 ${RISK_BACKOFF_MS[attempt] / 1000}s 重试（第 ${attempt + 1}/${RISK_BACKOFF_MS.length} 次）`);
    await sleep(RISK_BACKOFF_MS[attempt]);
    last = await fn();
  }
  return last;
}

/** B 站 JSON API 请求：非 2xx/412/畸形体归一为 parseBiliJson 错误分类；风控走 withRiskRetry。 */
export async function fetchBiliJson(
  deps: NetDeps & { cookie?: string }, url: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return withRiskRetry(deps, async () => {
    try {
      const res = await fetchImpl(url, { headers: biliHeaders(deps.cookie) });
      if (res.status === 412) return { ok: false as const, code: 'risk_control', message: 'HTTP 412', risk: true };
      const parsed = parseBiliJson(await res.json().catch(() => null));
      return { ...parsed, risk: !parsed.ok && isRiskControl(parsed) };
    } catch (e) {
      return { ok: false as const, code: 'fetch_error', message: (e as Error).message, risk: false };
    }
  });
}

/** 音轨下载（带风控退避）：非 412 的 HTTP 失败/网络异常直接返回错误分类（不重试）。 */
export async function downloadAudio(
  deps: NetDeps & { cookie?: string }, url: string,
): Promise<{ ok: true; buf: Buffer } | { ok: false; code: string; message: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const r = await withRiskRetry(deps, async () => {
    try {
      const res = await fetchImpl(url, { headers: biliHeaders(deps.cookie) });
      if (res.status === 412) return { ok: false as const, code: 'risk_control', message: '音轨下载 HTTP 412', risk: true };
      if (!res.ok) return { ok: false as const, code: `download_http_${res.status}`, message: `音轨下载 HTTP ${res.status}`, risk: false };
      return { ok: true as const, buf: Buffer.from(await res.arrayBuffer()), risk: false };
    } catch (e) {
      return { ok: false as const, code: 'download_error', message: (e as Error).message, risk: false };
    }
  });
  return r.risk ? { ok: false, code: 'risk_control', message: `${r.message}（三次退避后仍风控）` } : r;
}
