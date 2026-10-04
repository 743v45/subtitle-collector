// HTTP handler：补翻工作流（translate）。
// 路由：POST /api/translate/fill——译文行数组 → server 端行对齐校验 + 时间轴拷贝 + 入库。
//       GET  /api/translate/pending——有轨无中文轨的待补翻清单（CLI translate pending 的 web 形态）。
//       GET  /api/translate/source/:source/:vid——源轨结构化行（CLI translate source 的 web 形态）。
// 消费方是 CLI `translate fill`（agent 会话补翻工作流的写回步骤，对齐 AI 打标链路「系统出工具、智能在会话」）
// 与 collector-web（CLI 全功能 web 化 Phase 1）。轨标识 lan='zh-manual'（track 层面区分补翻与原生 AI/CC）；
// version origin='manual'（沿用 schema 既有语义：不去重、保留每次导入快照）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { getVideo, getVersionPayload } from '../db/queries.js';
import { insertTracksVersions } from '../db/ingest.js';
import { extractBody } from '../cli/subtitleFormat.js';
import { translatePendingDb, translateSourceDb } from '../cli/commands/translate.js';
import { parseBool, parseTimeParam } from './filter.js';
import { json, readJsonBody } from './http-util.js';

// 补翻轨标识与元数据（与 db/queries.ts trackPriority 的 zh-manual 档、CLI translate source/fill 共同约定）
export const ZH_MANUAL_LAN = 'zh-manual';
export const ZH_MANUAL_LAN_DOC = '中文（补翻）';

// 请求体校验：source/source_vid/from_lan 非空字符串，lines 是非空 string 数组
// （空串元素合法——源字幕该行本就无文本时译文占位用，行数对齐优先）。
function parseFillBody(b: unknown): { source: string; source_vid: string; from_lan: string; lines: string[] } | { error: string } {
  const body = b as { source?: unknown; source_vid?: unknown; from_lan?: unknown; lines?: unknown };
  for (const k of ['source', 'source_vid', 'from_lan'] as const) {
    const v = body[k];
    if (typeof v !== 'string' || !v) return { error: `${k} must be a non-empty string` };
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) return { error: 'lines:string[] required (non-empty)' };
  if (!body.lines.every((l): l is string => typeof l === 'string')) return { error: 'lines must all be strings' };
  return { source: body.source as string, source_vid: body.source_vid as string, from_lan: body.from_lan as string, lines: body.lines };
}

export async function handleTranslateHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/translate/pending' && req.method === 'GET') {
    handleTranslatePending(res, url, db);
    return;
  }

  const sourceMatch = url.pathname.match(/^\/api\/translate\/source\/([^/]+)\/([^/]+)$/);
  if (sourceMatch && req.method === 'GET') {
    handleTranslateSource(res, db, decodeURIComponent(sourceMatch[1]), decodeURIComponent(sourceMatch[2]), url);
    return;
  }

  if (url.pathname === '/api/translate/fill' && req.method === 'POST') {
    const parsed = parseFillBody(await readJsonBody(req));
    if ('error' in parsed) { json(res, 400, { ok: false, error: parsed.error }); return; }

    // 1. 视频存在性
    const detail = getVideo(db, parsed.source, parsed.source_vid);
    if (!detail) { json(res, 404, { ok: false, error: `video not found: ${parsed.source}/${parsed.source_vid}` }); return; }
    const videoId = detail.video.id as number;

    // 2. 源轨定位（--from 精确匹配 lan）。失败时带上可用轨清单——调用方能直接看出拼写/缺轨（可观察性）。
    const track = detail.tracks.find((t) => t.lan === parsed.from_lan);
    if (!track) {
      json(res, 404, {
        ok: false,
        error: `source track not found: lan=${parsed.from_lan}`,
        available_lans: detail.tracks.map((t) => t.lan),
      });
      return;
    }

    // 3. 源默认版本 payload（getVideo 已按 versionPriority 排序，versions[0] 即默认）
    if (track.versions.length === 0) { json(res, 404, { ok: false, error: `source track has no versions: lan=${parsed.from_lan}` }); return; }
    const ver = getVersionPayload(db, track.versions[0].id);
    if (!ver) { json(res, 500, { ok: false, error: `source version not readable: id=${track.versions[0].id}` }); return; }

    // 4. payload 结构校验（extractBody 抛错 → 400 透传结构特征）
    let bodyRows: Array<Record<string, unknown>>;
    try {
      extractBody(ver.payload);
      const raw = (ver.payload as { body: unknown }).body;
      bodyRows = raw as Array<Record<string, unknown>>;
    } catch (e) {
      json(res, 400, { ok: false, error: `源字幕 payload 结构不符: ${(e as Error).message}` });
      return;
    }

    // 5. 行数强校验——补翻契约核心：一行译文 ↔ 一行源字幕，时间轴由 server 从源轨拷贝
    if (parsed.lines.length !== bodyRows.length) {
      json(res, 400, {
        ok: false,
        error: `译文行数不符: 源字幕 ${bodyRows.length} 行, 收到 ${parsed.lines.length} 行`,
        expected: bodyRows.length,
        got: parsed.lines.length,
        hint: '用 translate source 导出的行号对齐；空译文行保留占位不可省略',
      });
      return;
    }

    // 6. 合成 payload：源 body 逐行展开保留全部字段（from/to/sid/location/music...），仅 content 换译文；
    //    顶层元数据（字体/版本等）沿用源 payload。
    const newPayload = {
      ...(ver.payload as Record<string, unknown>),
      body: bodyRows.map((row, i) => ({ ...row, content: parsed.lines[i] })),
    };

    // 7. 写入前统计已有补翻版本数（manual 不去重会堆积快照，响应里带出让调用方感知）
    const before = (db.prepare(
      `SELECT COUNT(*) AS c FROM subtitle_versions v JOIN subtitle_tracks t ON v.track_id = t.id
       WHERE t.video_id = ? AND t.lan = ?`,
    ).get(videoId, ZH_MANUAL_LAN) as { c: number }).c;

    const tx = db.transaction(() => insertTracksVersions(db, videoId, [{
      lan: ZH_MANUAL_LAN,
      lan_doc: ZH_MANUAL_LAN_DOC,
      versions: [{ origin: 'manual', payload: newPayload, source_url: `translate://${parsed.from_lan}` }],
    }], Date.now()));
    tx();

    json(res, 200, {
      ok: true,
      source: parsed.source,
      source_vid: parsed.source_vid,
      from_lan: parsed.from_lan,
      lan: ZH_MANUAL_LAN,
      lines: bodyRows.length,
      zh_manual_versions_before: before,
    });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}

// GET /api/translate/pending：待补翻清单（translatePendingDb 直用 server 进程内 db）。
// 抽出降 handleTranslateHttp 圈复杂度（对齐 clients.ts handleListClients 先例）。
function handleTranslatePending(res: ServerResponse, url: URL, db: Database.Database): void {
  const p = url.searchParams;
  // since/until：毫秒数字（对齐 /api/videos 口径）；非法 → 400（静默忽略会让「以为筛了其实没筛」）
  const since = parseTimeParam(p.get('since'), 'since');
  if (since.error) { json(res, 400, { ok: false, error: since.error }); return; }
  const until = parseTimeParam(p.get('until'), 'until');
  if (until.error) { json(res, 400, { ok: false, error: until.error }); return; }
  const sort = p.get('sort') ?? 'first_seen';
  if (sort !== 'first_seen' && sort !== 'published_at') {
    json(res, 400, { ok: false, error: 'sort must be first_seen|published_at' });
    return;
  }
  // page/size：非法（NaN）回落默认，page≥1，size 夹 1..100（对齐 /api/videos 口径）
  const page = Math.max(1, Math.floor(Number(p.get('page') ?? '1')) || 1);
  const size = Math.min(100, Math.max(1, Math.floor(Number(p.get('size') ?? '20')) || 20));
  const r = translatePendingDb(db, {
    source: p.get('source') ?? undefined,
    from: p.get('from') ?? undefined,
    creator: p.get('creator') ?? undefined,
    since: since.value,
    until: until.value,
    page,
    size,
    sort,
    asc: parseBool(p.get('asc')) ?? false,
  });
  json(res, 200, { ok: true, total: r.total, page: r.page, size: r.size, items: r.items });
}

// GET /api/translate/source/:source/:vid：源轨结构化行（lines:[{line,text}] web 双栏直用 + text 拼回 tab 文本）。
// 核心错误（CLI 文案）按语义映射 HTTP 状态：404 视频/轨不存在（带 available_lans，对齐 fill 先例）、400 默认轨已中文。
function handleTranslateSource(res: ServerResponse, db: Database.Database, source: string, sourceVid: string, url: URL): void {
  const fromLan = url.searchParams.get('from') ?? undefined;
  try {
    const r = translateSourceDb(db, source, sourceVid, fromLan);
    json(res, 200, {
      ok: true,
      source,
      source_vid: sourceVid,
      lan: r.lan,
      version_id: r.versionId,
      lines: r.rows,
      text: r.text,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('视频不存在')) {
      console.warn(`[http:translate:source] 视频不存在 source=${source} source_vid=${sourceVid}`);
      json(res, 404, { ok: false, error: msg });
      return;
    }
    if (msg.includes('源轨不存在') || msg.includes('没有任何字幕轨') || msg.includes('没有任何版本')) {
      // 带可用轨清单（可观察性：调用方直接看出拼写/缺轨）；视频都查不到时给空数组
      const detail = getVideo(db, source, sourceVid);
      json(res, 404, { ok: false, error: msg, available_lans: detail ? detail.tracks.map((t) => t.lan) : [] });
      return;
    }
    if (msg.includes('已是中文')) { json(res, 400, { ok: false, error: msg }); return; }
    // 剩余为 payload 结构不符（extractBody 抛错）等可预期失败 → 400 透传结构特征（对齐 fill 先例）
    console.warn(`[http:translate:source] 取源字幕失败 source=${source} source_vid=${sourceVid} from=${fromLan ?? '(缺省)'} error=${msg}`);
    json(res, 400, { ok: false, error: msg });
  }
}
