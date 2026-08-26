// asr backfill 的转写服务层（提交 + 轮询 + 超时取消，2026-08-26 为控新文件复杂度自 commands/asr.ts 拆出）。
// fireredasr-ui 异步 API：POST /v1/tasks → 轮询 GET /v1/tasks/{id}（segments 带段级时间戳）。
import { defaultSleep, type NetDeps } from './asr-net.js';

// 转写轮询：间隔 2s、上限 1900s（fireredasr config worker.task_timeout=1800s + 缓冲）
const POLL_INTERVAL_MS = 2_000;
export const POLL_DEADLINE_MS = 1_900_000;

export type TranscribeOutcome =
  | { ok: true; segments: unknown }
  | { ok: false; code: string; message: string };

/** 提交音频文件 → task_id；失败分类（服务不可达 / 提交被拒）。 */
async function submitTask(fetchImpl: typeof fetch, asrApi: string, audio: { buf: Buffer; filename: string }): Promise<string | { error: string; code: string }> {
  try {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(audio.buf)]), audio.filename);
    fd.append('response_format', 'verbose_json');
    fd.append('model', 'AED');
    const res = await fetchImpl(`${asrApi}/v1/tasks`, { method: 'POST', body: fd });
    const body = await res.json().catch(() => null) as { task_id?: string; error?: string } | null;
    if (!res.ok || !body?.task_id) {
      return { error: `转写提交失败: HTTP ${res.status} ${body?.error ?? ''}`, code: 'asr_submit' };
    }
    return body.task_id;
  } catch (e) {
    return { error: `转写服务不可达: ${(e as Error).message}（--asr-url ${asrApi} 对吗？）`, code: 'asr_unreachable' };
  }
}

/** 轮询到终态：done → segments；error → asr_error；超 deadline → DELETE 取消后 asr_timeout。 */
async function pollUntil(
  deps: NetDeps & { asrApi: string; pollDeadlineMs?: number }, taskId: string,
): Promise<TranscribeOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + (deps.pollDeadlineMs ?? POLL_DEADLINE_MS);
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    let row: { status?: string; segments?: unknown; error?: unknown } | null = null;
    try {
      const res = await fetchImpl(`${deps.asrApi}/v1/tasks/${taskId}`);
      row = await res.json().catch(() => null);
    } catch { /* 轮询瞬时网络抖动：下轮再试 */ }
    if (row?.status === 'done') return { ok: true, segments: row.segments };
    if (row?.status === 'error') return { ok: false, code: 'asr_error', message: `转写出错: ${String(row.error)}` };
    if (Date.now() > deadline) {
      try { await fetchImpl(`${deps.asrApi}/v1/tasks/${taskId}`, { method: 'DELETE' }); } catch { /* 放弃清理 */ }
      return { ok: false, code: 'asr_timeout', message: `转写轮询超时（>${POLL_DEADLINE_MS / 1000}s），已取消任务` };
    }
  }
}

/** 提交音频到 fireredasr 并轮询到终态。超时自动 DELETE 取消任务。 */
export async function transcribeAt(
  deps: NetDeps & { asrApi: string; pollDeadlineMs?: number },
  audio: { buf: Buffer; filename: string },
): Promise<TranscribeOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const submitted = await submitTask(fetchImpl, deps.asrApi, audio);
  if (typeof submitted !== 'string') return { ok: false, code: submitted.code, message: submitted.error };
  return pollUntil(deps, submitted);
}
