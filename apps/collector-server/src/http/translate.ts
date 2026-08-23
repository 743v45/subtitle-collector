// HTTP handler：补翻写回（translate）。
// 路由：POST /api/translate/fill——译文行数组 → server 端行对齐校验 + 时间轴拷贝 + 入库。
// 消费方是 CLI `translate fill`（agent 会话补翻工作流的写回步骤，对齐 AI 打标链路「系统出工具、智能在会话」）。
// 轨标识 lan='zh-manual'（track 层面区分补翻与原生 AI/CC）；version origin='manual'
// （沿用 schema 既有语义：不去重、保留每次导入快照）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { getVideo, getVersionPayload } from '../db/queries.js';
import { insertTracksVersions } from '../db/ingest.js';
import { extractBody } from '../cli/subtitleFormat.js';
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
