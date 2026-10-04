// HTTP handler：文件下载通道（CLI 全功能 web 化 Phase 2，三个 GET 导出端点）。
//   GET /api/export/videos?format=csv|ndjson|json&<VideoFilter>&sort&desc —— CLI export videos 的 web 形态
//   GET /api/export/subtitle/:source/:vid?track=&version=&format=srt|vtt|txt|json —— CLI export subtitle 的 web 形态
//   GET /api/export/bundle?<VideoFilter>&limit=&name_order=&track= —— CLI export bundle 的 web 形态（zip 下载）
// 全 GET：web 端直接构造 URL 下载（筛选参数与 /api/videos 的 videoFilterUrl query 同构）。
// 下载响应统一走 sendFile（聚合内容 + Content-Disposition，RFC 5987 双文件名）；行/包口径以 CLI 为准：
// videos 输出 listVideosFiltered 原始行（CLI export videos 不 enrich），bundle 走 cli/bundle.ts buildBundle。
// 措辞：字幕（subtitle），非弹幕。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listVideosFiltered, VIDEO_SORT_KEYS, type VideoFilter, type VideoListItemAdvanced, type VideoSortKey } from '../db/advanced.js';
import { getVideo } from '../db/queries.js';
import { resolveSubtitle, type SubtitleFormat } from '../cli/subtitleFormat.js';
import { buildBundle, FILENAME_PARTS, type FilenamePart } from '../cli/bundle.js';
import type { VideosListOpts } from '../cli/commands/videos.js';
import { csvEscape } from '../cli/output.js';
import { parseVideoFilter } from './filter.js';
import { json, parseSortParams, sendFile } from './http-util.js';
import { createZip } from './zip.js';

const VIDEOS_FORMATS = ['csv', 'ndjson', 'json'] as const;
const SUBTITLE_FORMATS = ['srt', 'vtt', 'txt', 'json'] as const;
const BUNDLE_LIMIT_DEFAULT = 500;
const BUNDLE_LIMIT_MAX = 1000;
const EXPORT_PAGE_SIZE = 100;

// ── /api/export/videos ──

// 循环分页取全量（size=100 防「一次大查询」，聚合后一次写出——500 视频级 csv 仅数百 KB，
// 聚合内存安全；未来总量上到数十万行再改流式逐页 write）。防御：total 说还有但页返回空 → 断链退出（log）。
function fetchAllFiltered(db: Database.Database, filter: VideoFilter, sort: VideoSortKey, desc: boolean): { items: VideoListItemAdvanced[]; total: number } {
  const items: VideoListItemAdvanced[] = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const r = listVideosFiltered(db, { ...filter, sort, desc, page, size: EXPORT_PAGE_SIZE });
    total = r.total;
    items.push(...r.items);
    if (items.length >= r.total || r.items.length === 0) {
      if (items.length < r.total) console.warn(`[http:export:videos] 分页提前断链 page=${page} 取到=${items.length} total=${r.total}`);
      break;
    }
  }
  return { items, total };
}

// csv 表头字段：首条 items 的 keys（listVideosFiltered 行结构统一，首行即全量 schema）。
// 空结果时按 CLI 口径查一条 size=1 的探针行拿 keys（不带 filter——同 filter 必然同样为空），
// 仍无（空库）→ null，调用方回空文件。
function csvFields(db: Database.Database, items: VideoListItemAdvanced[]): string[] | null {
  if (items.length > 0) return Object.keys(items[0]);
  const probe = listVideosFiltered(db, { page: 1, size: 1 });
  return probe.items.length > 0 ? Object.keys(probe.items[0]) : null;
}

// items → csv（表头 + 各行；转义复用 cli/output.ts csvEscape，与 CLI stdout 同一口径）
function toCsv(items: VideoListItemAdvanced[], fields: string[]): string {
  const lines = [fields.map(csvEscape).join(',')];
  for (const row of items) {
    const r = row as unknown as Record<string, unknown>;
    lines.push(fields.map((f) => csvEscape(r[f])).join(','));
  }
  return lines.join('\n') + '\n';
}

function handleExportVideos(res: ServerResponse, db: Database.Database, p: URLSearchParams): void {
  const format = p.get('format') ?? 'json';
  if (!(VIDEOS_FORMATS as readonly string[]).includes(format)) {
    json(res, 400, { ok: false, error: `format must be one of ${VIDEOS_FORMATS.join('|')}, got: ${format}` });
    return;
  }
  const sp = parseSortParams(p, VIDEO_SORT_KEYS, 'first_seen');
  if ('error' in sp) { json(res, 400, { ok: false, error: sp.error }); return; }
  const filter = parseVideoFilter(p);
  const { items, total } = fetchAllFiltered(db, filter, sp.sort as VideoSortKey, sp.desc);

  let content: string;
  if (format === 'csv') {
    const fields = csvFields(db, items);
    content = fields ? toCsv(items, fields) : '';  // 空库：只回空文件（包络靠响应头）
  } else if (format === 'ndjson') {
    content = items.map((it) => JSON.stringify(it)).join('\n') + (items.length > 0 ? '\n' : '');
  } else {
    content = JSON.stringify({ total, items }, null, 2) + '\n';
  }
  res.setHeader('X-Export-Count', String(total));
  sendFile(res, {
    filename: `videos-export.${format}`,
    content,
    mime: format === 'csv' ? 'text/csv; charset=utf-8' : format === 'ndjson' ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8',
  });
}

// ── /api/export/subtitle/:source/:vid ──

// 字幕格式 → 下载 MIME（json 结构化，其余纯文本）
function subtitleMime(formatRaw: string): string {
  return formatRaw === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
}

// version query 解析：缺省 → {}；非正整数 → error（调用方 400，带关键变量日志）
function parseVersionParam(p: URLSearchParams): { id?: number; error?: string } {
  const raw = p.get('version');
  if (raw === null) return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `version must be a positive integer, got: ${raw}` };
  }
  return { id: n };
}

// resolveSubtitle 的 not_found → 404 JSON。轨/版本相关错误带 available_lans
//（对齐 http/translate.ts 先例：调用方直接看出拼写/缺轨）；视频不存在不带。
function notFoundResponse(res: ServerResponse, db: Database.Database, message: string, source: string, sourceVid: string, p: URLSearchParams): void {
  console.warn(`[http:export:subtitle] 404 source=${source} source_vid=${sourceVid} track=${p.get('track') ?? '(缺省)'} version=${p.get('version') ?? '(缺省)'} error=${message}`);
  const trackMissing = message.includes('track not found') || message.includes('无字幕轨') || message.includes('无字幕版本');
  const detail = trackMissing ? getVideo(db, source, sourceVid) : null;
  json(res, 404, { ok: false, error: message, ...(trackMissing ? { available_lans: detail ? detail.tracks.map((t) => t.lan) : [] } : {}) });
}

// 核心错误（resolveSubtitle 的 CLI 文案）映射 404（notFoundResponse）；payload 损坏
//（convertSubtitle 抛）由外层 catch 转 400。
function handleExportSubtitle(res: ServerResponse, db: Database.Database, source: string, sourceVid: string, p: URLSearchParams): void {
  const formatRaw = p.get('format') ?? 'srt';
  if (!(SUBTITLE_FORMATS as readonly string[]).includes(formatRaw)) {
    json(res, 400, { ok: false, error: `format must be one of ${SUBTITLE_FORMATS.join('|')}, got: ${formatRaw}` });
    return;
  }
  const vp = parseVersionParam(p);
  if (vp.error) {
    console.warn(`[http:export:subtitle] version 参数非法 ${vp.error} source=${source} source_vid=${sourceVid}`);
    json(res, 400, { ok: false, error: vp.error });
    return;
  }
  try {
    const r = resolveSubtitle(db, { source, sourceVid, track: p.get('track') ?? undefined, versionId: vp.id, format: formatRaw as SubtitleFormat });
    if (r.kind === 'not_found') { notFoundResponse(res, db, r.message, source, sourceVid, p); return; }
    // web 端提示用（可选头）：轨 lan / 版本 id（显式 version 路径无 trackLan，省略该头）
    res.setHeader('X-Version-Id', String(r.versionId));
    if (r.trackLan !== undefined) res.setHeader('X-Track-Lan', r.trackLan ?? '');
    sendFile(res, {
      filename: `${sourceVid}.${formatRaw}`,
      content: r.text,
      mime: subtitleMime(formatRaw),
    });
  } catch (e) {
    console.warn(`[http:export:subtitle] 字幕转换失败 source=${source} source_vid=${sourceVid} format=${formatRaw} error=${(e as Error).message}`);
    json(res, 400, { ok: false, error: (e as Error).message });
  }
}

// ── /api/export/bundle ──

// name_order query 解析（口径对齐 CLI parseNameOrder，但不用 emitError——HTTP 无 process.exit）：
// 逗号分隔组件（FILENAME_PARTS 无子集排列），空/非法组件/重复 → error（调用方 400 列合法值）。
function parseNameOrderParam(raw: string | null): { parts?: FilenamePart[]; error?: string } {
  if (raw === null) return {};
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { error: `name_order is empty (valid parts: ${FILENAME_PARTS.join('|')})` };
  const seen = new Set<string>();
  for (const part of parts) {
    if (!(FILENAME_PARTS as readonly string[]).includes(part)) {
      return { error: `invalid name_order part: ${part} (valid parts: ${FILENAME_PARTS.join('|')})` };
    }
    if (seen.has(part)) return { error: `duplicate name_order part: ${part}` };
    seen.add(part);
  }
  return { parts: parts as FilenamePart[] };
}

// VideoFilter（snake_case，HTTP 口径）→ VideosListOpts（camelCase，buildBundle/videosList 口径）。
// creator_id/creator_uid/tag_source/date_field 为 /api/videos 独有筛选，CLI bundle 的 videosList
// 不支持——对齐 CLI export bundle 口径丢弃（CLI 同样不收这些）。
function videoFilterToBundleOpts(f: VideoFilter): VideosListOpts {
  return {
    q: f.q, creator: f.creator, source: f.source, tid: f.tid, tname: f.tname,
    tag: f.tag, tags: f.tags, subtitleQ: f.subtitle_q, lang: f.lang,
    trackType: f.track_type, hasSubtitle: f.has_subtitle,
    since: f.since, until: f.until,
    minDuration: f.min_duration, maxDuration: f.max_duration,
    minView: f.min_view, maxView: f.max_view,
  };
}

function handleExportBundle(res: ServerResponse, db: Database.Database, p: URLSearchParams): void {
  // limit：默认 500、上限 1000（CLI 默认同 500；超限 400 而非静默夹取——「以为全量其实截断」是暗坑）
  let limit = BUNDLE_LIMIT_DEFAULT;
  if (p.get('limit') !== null) {
    const n = Number(p.get('limit'));
    if (!Number.isInteger(n) || n <= 0) {
      json(res, 400, { ok: false, error: `limit must be a positive integer, got: ${p.get('limit')}` });
      return;
    }
    if (n > BUNDLE_LIMIT_MAX) {
      json(res, 400, { ok: false, error: `limit must be <= ${BUNDLE_LIMIT_MAX}, got: ${n}` });
      return;
    }
    limit = n;
  }
  const nameOrder = parseNameOrderParam(p.get('name_order'));
  if (nameOrder.error) { json(res, 400, { ok: false, error: nameOrder.error }); return; }
  const sp = parseSortParams(p, VIDEO_SORT_KEYS, 'first_seen');
  if ('error' in sp) { json(res, 400, { ok: false, error: sp.error }); return; }

  const filters: VideosListOpts = { ...videoFilterToBundleOpts(parseVideoFilter(p)), sort: sp.sort as VideoSortKey, desc: sp.desc };
  const built = buildBundle(db, { filters, track: p.get('track') ?? undefined, limit, now: Date.now(), nameOrder: nameOrder.parts });
  // errors>0（缺字幕/payload 损坏被记 manifest.errors）也照常出包——部分成功语义，对齐 CLI
  const errors = built.manifest.errors?.length ?? 0;
  if (errors > 0) {
    console.warn(`[http:export:bundle] 部分成功 total=${built.manifest.total_matched} exported=${built.manifest.exported} errors=${errors} vids=${built.manifest.errors!.map((e) => e.source_vid).join(',')}`);
  }
  // 文件名时间戳：yyyymmdd-hhmmss（本地时间；ISO 去符号后截 15 位）
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  res.setHeader('X-Bundle-Total', String(built.manifest.total_matched));
  res.setHeader('X-Bundle-Exported', String(built.manifest.exported));
  res.setHeader('X-Bundle-Errors', String(errors));
  // BundleFile{path,content} → ZipInputFile{name,content}：zip 内路径即 bundle 相对根路径
  sendFile(res, {
    filename: `bundle-${stamp}.zip`,
    content: createZip(built.files.map((f) => ({ name: f.path, content: f.content }))),
    mime: 'application/zip',
  });
}

// 路由分发（main.ts API_ROUTES 以 '/api/export' 前缀进本 handler，内部再按 pathname 精确分支）
export async function handleExportHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  if (req.method !== 'GET') { json(res, 404, { ok: false, error: 'not found' }); return; }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/export/videos') { handleExportVideos(res, db, url.searchParams); return; }
  if (url.pathname === '/api/export/bundle') { handleExportBundle(res, db, url.searchParams); return; }
  const subMatch = url.pathname.match(/^\/api\/export\/subtitle\/([^/]+)\/([^/]+)$/);
  if (subMatch) {
    handleExportSubtitle(res, db, decodeURIComponent(subMatch[1]), decodeURIComponent(subMatch[2]), url.searchParams);
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}
