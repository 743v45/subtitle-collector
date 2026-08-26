// HTTP handler：ASR 转写写回（asr submit）。
// 路由：POST /api/asr/submit——段级 cues → server 端校验 + 合成 B 站字幕 payload + 入库。
// 消费方是 CLI `asr backfill`（no-subtitle 兜底转写链路的写回步骤，fireredasr-ui 段级出参直接映射）。
// 轨标识 lan='asr-zh'（track_type=1 自动轨语义，对齐 schema 注释「1=AI/ASR」）；version
// origin='asr' + asr_engine（ingest 按 (track_id, origin, asr_engine, body_hash) 幂等去重，
// 重跑同结果零新增）；新 version 落库即摘 no-subtitle 系统标（圈出的恒为真无轨，同 ingestVideo 语义）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { getVideo } from '../db/queries.js';
import { insertTracksVersions } from '../db/ingest.js';
import { unmarkNoSubtitle } from '../db/tags.js';
import { json, readJsonBody } from './http-util.js';

// ASR 轨标识（与 db/queries.ts 轨排序、CLI asr backfill 共同约定；区别于平台 AI 轨 ai-zh / 补翻轨 zh-manual）
export const ASR_ZH_LAN = 'asr-zh';
export const ASR_ZH_LAN_DOC = '中文（ASR 转写）';

export interface AsrCue { from: number; to: number; content: string }

// 单条 cue 解析：0 ≤ from < to（秒）+ content 非空；错误以字符串返回（调用方归一 400）
function parseCue(c: unknown): AsrCue | string {
  if (typeof c !== 'object' || c === null) return 'cues entries must be objects';
  const { from, to, content } = c as Record<string, unknown>;
  if (typeof from !== 'number' || typeof to !== 'number' || typeof content !== 'string') {
    return 'cue needs number from/to and string content';
  }
  if (!(from >= 0) || !(to > from)) return `cue needs 0 ≤ from < to, got from=${from} to=${to}`;
  return { from, to, content };
}

// 请求体校验：source/vid/engine 非空字符串；cues 非空数组，每条 0 ≤ from < to（秒）、content 非空。
// 空文本段在此剔除（worker 侧已剔，端点再剔一层防御）；剔后为空 → 报错。
export function parseSubmitBody(b: unknown):
  { source: string; vid: string; engine: string; cues: AsrCue[] } | { error: string } {
  const body = b as { source?: unknown; vid?: unknown; engine?: unknown; cues?: unknown };
  for (const k of ['source', 'vid', 'engine'] as const) {
    const v = body[k];
    if (typeof v !== 'string' || !v) return { error: `${k} must be a non-empty string` };
  }
  if (!Array.isArray(body.cues) || body.cues.length === 0) return { error: 'cues: [{from,to,content}] required (non-empty)' };
  const cues: AsrCue[] = [];
  for (const c of body.cues) {
    const parsed = parseCue(c);
    if (typeof parsed === 'string') return { error: parsed };
    if (parsed.content.trim()) cues.push(parsed);
  }
  if (cues.length === 0) return { error: 'cues all empty after filtering blank content' };
  return { source: body.source as string, vid: body.vid as string, engine: body.engine as string, cues };
}

// 写入 + 同事务摘标（自 handler 抽出控复杂度：origin='asr' 走幂等去重——同引擎同内容重跑 skipped）
function writeAsrVersion(db: Database.Database, videoId: number, parsed: { source: string; vid: string; engine: string; cues: AsrCue[] }): { inserted: number; skipped: number; unmarked: boolean } {
  const payload = { type: 'AIsubtitle', lang: 'zh', body: parsed.cues.map((c) => ({ from: c.from, to: c.to, content: c.content })) };
  let inserted = 0;
  let skipped = 0;
  let unmarked = false;
  const tx = db.transaction(() => {
    ({ inserted, skipped } = insertTracksVersions(db, videoId, [{
      lan: ASR_ZH_LAN,
      lan_doc: ASR_ZH_LAN_DOC,
      track_type: 1,
      versions: [{ origin: 'asr', payload, asr_engine: parsed.engine, source_url: `asr://${parsed.engine}` }],
    }], Date.now()));
    if (inserted > 0) unmarked = unmarkNoSubtitle(db, { source: parsed.source, source_vid: parsed.vid }) > 0;
  });
  tx();
  return { inserted, skipped, unmarked };
}

export async function handleAsrHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/asr/submit' && req.method === 'POST') {
    const parsed = parseSubmitBody(await readJsonBody(req));
    if ('error' in parsed) { json(res, 400, { ok: false, error: parsed.error }); return; }

    // 1. 视频存在性（未入库视频无从挂轨——先经采集链路入库再谈 ASR 兜底）
    const detail = getVideo(db, parsed.source, parsed.vid);
    if (!detail) { json(res, 404, { ok: false, error: `video not found: ${parsed.source}/${parsed.vid}` }); return; }
    const videoId = detail.video.id as number;

    // 2. 写入（payload 合成遵循 extractBody 契约：number from/to + string content）
    const { inserted, skipped, unmarked } = writeAsrVersion(db, videoId, parsed);

    json(res, 200, {
      ok: true,
      source: parsed.source,
      vid: parsed.vid,
      lan: ASR_ZH_LAN,
      engine: parsed.engine,
      cues: parsed.cues.length,
      inserted,
      skipped,
      no_subtitle_unmarked: unmarked,
    });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}
