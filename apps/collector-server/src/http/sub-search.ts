// HTTP handler：字幕正文检索（GET /api/sub-search）——CLI `sub search` 的 web 形态。
// 复用 cli/commands/sub.ts 的 searchSubtitles 纯函数（db 句柄 + PayloadSource 注入，
// 生产 makeDbPayloadSource 直接用 server 进程内 db，避免 readonly 二次打开与路径不一致；
// http→cli 互引合法且无环，先例：http/translate.ts import cli/subtitleFormat.js）。
// 与 CLI 差异：不支持 plain/full/fullFormat（web 形态不要 --full 大文本，Phase 2 走下载）。
// 措辞：字幕（subtitle），非弹幕。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { VideoFilter } from '../db/advanced.js';
import { makeDbPayloadSource, searchSubtitles } from '../cli/commands/sub.js';
import { parseBool, parseTimeParam } from './filter.js';
import { json } from './http-util.js';

const MAX_KEYWORD_LEN = 200;
const MAX_VIDEOS_CAP = 500;

// 正数参数组解析（抽出降 handleSubSearchHttp 圈复杂度）：任一非数字/非正数 → error（调用方 400）。
// 缺省值对齐 CLI ARGS 默认（ctx 上下文秒 10 / 每视频片段 3 / 片段总数 30 / 视频数 100）。
function parsePositiveParams(
  p: URLSearchParams,
): { ctxSec: number; maxSnippetsPerVideo: number; maxSnippets: number; maxVideos: number } | { error: string } {
  const ctxSec = parsePositive(p.get('ctx'), 10);
  if (ctxSec === null) return { error: `ctx must be a positive number: ${p.get('ctx')}` };
  const maxSnippetsPerVideo = parsePositive(p.get('max_snippets_per_video'), 3);
  if (maxSnippetsPerVideo === null) return { error: `max_snippets_per_video must be a positive number: ${p.get('max_snippets_per_video')}` };
  const maxSnippets = parsePositive(p.get('max_snippets'), 30);
  if (maxSnippets === null) return { error: `max_snippets must be a positive number: ${p.get('max_snippets')}` };
  const maxVideosRaw = parsePositive(p.get('max_videos'), 100);
  if (maxVideosRaw === null) return { error: `max_videos must be a positive number: ${p.get('max_videos')}` };
  // max_videos：正数校验后夹 1..500（上限防全表扫 payload）
  return { ctxSec, maxSnippetsPerVideo, maxSnippets, maxVideos: Math.min(MAX_VIDEOS_CAP, Math.max(1, Math.floor(maxVideosRaw))) };
}

// keyword 校验（抽出降 handleSubSearchHttp 圈复杂度）：必填，≤200（超长 400——防误发全量正文当关键词拖垮检索）。
function parseKeyword(p: URLSearchParams): string | { error: string } {
  const keyword = p.get('keyword') ?? '';
  if (!keyword) return { error: 'keyword query param required' };
  if (keyword.length > MAX_KEYWORD_LEN) {
    console.warn(`[http:sub-search] keyword 超长被拒 len=${keyword.length} max=${MAX_KEYWORD_LEN}`);
    return { error: `keyword too long: ${keyword.length} > ${MAX_KEYWORD_LEN}` };
  }
  return keyword;
}

export async function handleSubSearchHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  if (req.method !== 'GET') { json(res, 404, { ok: false, error: 'not found' }); return; }
  const p = new URL(req.url ?? '/', 'http://localhost').searchParams;

  const keyword = parseKeyword(p);
  if (typeof keyword !== 'string') { json(res, 400, { ok: false, error: keyword.error }); return; }

  const pos = parsePositiveParams(p);
  if ('error' in pos) { json(res, 400, { ok: false, error: pos.error }); return; }

  // since/until：毫秒数字，非法 → 400（规格指定，与 parseVideoFilter 的「非法静默忽略」口径不同——
  // 检索页参数错了静默全量返回是暗坑）
  const since = parseTimeParam(p.get('since'), 'since');
  if (since.error) { json(res, 400, { ok: false, error: since.error }); return; }
  const until = parseTimeParam(p.get('until'), 'until');
  if (until.error) { json(res, 400, { ok: false, error: until.error }); return; }

  const videoFilter: VideoFilter = {
    source: p.get('source') ?? undefined,
    creator: p.get('creator') ?? undefined,
    since: since.value,
    until: until.value,
  };

  try {
    const r = searchSubtitles(db, makeDbPayloadSource(db), {
      keyword,
      regex: parseBool(p.get('regex')) ?? false,
      caseSensitive: parseBool(p.get('case_sensitive')) ?? false,
      ctxSec: pos.ctxSec,
      maxSnippetsPerVideo: pos.maxSnippetsPerVideo,
      maxSnippets: pos.maxSnippets,
      maxVideos: pos.maxVideos,
      allTracks: parseBool(p.get('all_tracks')) ?? false,
      videoFilter,
    });
    // 不传 full → items 天然无 full 字段（大文本 Phase 2 另走下载）
    json(res, 200, {
      ok: true,
      keyword: r.keyword,
      regex: r.regex,
      matched_videos: r.matched_videos,
      total_snippets: r.total_snippets,
      truncated: r.truncated,
      items: r.items,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('非法正则')) {
      console.warn(`[http:sub-search] 非法正则 keyword=${JSON.stringify(keyword)} regex=${p.get('regex')}`);
      json(res, 400, { ok: false, error: msg });
      return;
    }
    throw e; // 其余交 runHandler 兜底 500 + console.error（不吞栈）
  }
}

// 字符串 → 正数；缺省/空串 → dft；非有限数或 ≤0 → null（调用方 400）。
function parsePositive(raw: string | null, dft: number): number | null {
  if (raw === null || raw === '') return dft;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
