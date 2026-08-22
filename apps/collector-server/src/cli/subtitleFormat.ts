import type Database from 'better-sqlite3';
import { getVideo, getVersionPayload } from '../db/queries.js';

/**
 * 字幕格式转换 + 字幕版本解析（resolveSubtitle 下沉于此，2026-08-23 断环：原在 commands/export.ts，
 * bundle.ts 引用会构成 bundle ↔ export 循环依赖；本模块是两侧共同依赖的字幕处理层）。
 * 把 B 站字幕 payload 转成 srt / vtt / txt / json。
 *
 * payload 真实结构（参考 info/body.json 样本 + subtitle-collector/inject.js 拦截到的响应体）：
 * {
 *   font_size: 0.4, font_color: "#FFFFFF", background_alpha: 0.5,
 *   background_color: "#9C27B0", Stroke: "none", type: "AIsubtitle",
 *   lang: "zh", version: "v1.7.0.4",
 *   body: [
 *     { from: 0.36, to: 2.56, sid: 1, location: 2, content: "字幕文本", music: 0.0 },
 *     ...
 *   ]
 * }
 *
 * body 每条：from / to 是秒（浮点）；content 是该时间段内的字幕文本。
 * payload 在 db 里以 TEXT 存原始 JSON，见 [db/queries.ts:getVersionPayload](../db/queries.ts)，
 * 调用方 JSON.parse 还原成对象后传入本模块。
 */

/** 支持的字幕输出格式。 */
export type SubtitleFormat = 'json' | 'srt' | 'vtt' | 'txt';

interface BodyItem {
  from: number;
  to: number;
  content: string;
}

/**
 * 把秒（浮点）转成 `HH:MM:SS<sep>mmm`。
 * sep=',' → SRT 时间戳；sep='.' → VTT 时间戳。
 * 负值归零，四舍五入到毫秒。
 */
function secsToStamp(seconds: number, sep: ',' | '.'): string {
  const total = seconds < 0 ? 0 : Math.round(seconds * 1000);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1_000);
  const ms = total % 1_000;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const mmm = String(ms).padStart(3, '0');
  return `${hh}:${mm}:${ss}${sep}${mmm}`;
}

/**
 * 从 payload 中校验并提取 body 数组。
 * 结构不符（非对象、缺 body、body 非数组/空、条目缺字段或类型不对）时抛清晰错误。
 * 导出供 bundle.ts 复用（stamped txt 行格式，见 [bundle.ts](../bundle.ts)）。
 */
export function extractBody(payload: unknown): BodyItem[] {
  if (typeof payload !== 'object' || payload === null || !('body' in payload)) {
    throw new Error('字幕 payload 结构不符：期望 B 站字幕 JSON 对象（含 body 字段）');
  }
  const body = (payload as { body: unknown }).body;
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error('字幕 payload 结构不符：body 不是非空数组');
  }
  const items: BodyItem[] = [];
  body.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`字幕 payload 结构不符：body[${i}] 不是对象`);
    }
    const { from, to, content } = raw as Record<string, unknown>;
    if (typeof from !== 'number' || typeof to !== 'number' || typeof content !== 'string') {
      throw new Error(
        `字幕 payload 结构不符：body[${i}] 需含 number 类型 from/to 与 string 类型 content`,
      );
    }
    items.push({ from, to, content });
  });
  return items;
}

/** SRT：序号 + `HH:MM:SS,mmm --> HH:MM:SS,mmm` + content，块间空行，末尾换行。 */
function toSrt(body: BodyItem[]): string {
  const blocks = body.map((item, idx) => {
    const start = secsToStamp(item.from, ',');
    const end = secsToStamp(item.to, ',');
    return `${idx + 1}\n${start} --> ${end}\n${item.content.trim()}`;
  });
  return `${blocks.join('\n\n')}\n`;
}

/** VTT：`WEBVTT` 头 + `HH:MM:SS.mmm --> HH:MM:SS.mmm` + content，块间空行，末尾换行。 */
function toVtt(body: BodyItem[]): string {
  const blocks = body.map((item) => {
    const start = secsToStamp(item.from, '.');
    const end = secsToStamp(item.to, '.');
    return `${start} --> ${end}\n${item.content.trim()}`;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/** TXT：仅拼接每条 content（去首尾空白，跳过空串），每条一行，末尾换行。 */
function toTxt(body: BodyItem[]): string {
  const lines = body.map((item) => item.content.trim()).filter((s) => s.length > 0);
  return `${lines.join('\n')}\n`;
}

/**
 * 把字幕 payload 转成指定格式字符串。
 *
 * - `json`：`JSON.stringify(payload, null, 2)`（美化、可往返）
 * - `srt`：标准 SRT（逗号毫秒）
 * - `vtt`：标准 WebVTT（小数点毫秒）
 * - `txt`：纯文本（仅 content）
 *
 * @throws payload 结构不符时抛 Error
 */
export function convertSubtitle(payload: unknown, format: SubtitleFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(payload, null, 2);
    case 'srt':
      return toSrt(extractBody(payload));
    case 'vtt':
      return toVtt(extractBody(payload));
    case 'txt':
      return toTxt(extractBody(payload));
    default:
      // 运行时兜底（format 已是闭合联合类型，正常不会到这里）
      throw new Error(`未支持的字幕格式: ${String(format)}`);
  }
}

// ── 字幕版本解析（export subtitle 子命令与 export bundle 共用；自 commands/export.ts 下沉）──

export interface ExportSubtitleOpts {
  source: string;
  sourceVid: string;
  track?: string;        // --track <lan>，精确匹配 subtitle_tracks.lan
  versionId?: number;    // --version <id>，优先于 track
  format: SubtitleFormat;
}

export type SubtitleResolveResult =
  | {
    kind: 'ok'; payload: unknown; text: string; format: SubtitleFormat; versionId: number;
    // 轨信息（bundle 消费）：仅走 getVideo 的路径填充；显式 --version 直取时不填（可选，向后兼容）
    trackLan?: string | null; trackLanDoc?: string | null; trackType?: number | null; versionOrigin?: string;
  }
  | { kind: 'not_found'; message: string };

/**
 * 解析字幕版本 + 转格式。优先级：--version >（--track | 默认轨）的默认版本。
 * 视频 / 轨 / 版本不存在返回 { kind: 'not_found', message }，便于 action 直 emitError NOT_FOUND。
 * convertSubtitle 在 payload 结构不符时会抛（数据损坏，理论不会发生；若发生则向上冒泡为 RUNTIME）。
 *
 * 默认轨 / 默认版本的判定复用 queries.getVideo 的 is_default 标记：
 *   - 默认轨 = 排序后首个（CC中文 > AI中文 > en > 其他）
 *   - 每个轨各自的默认 version = origin 优先级（external > manual > asr）首个，不跨轨串台
 */
export function resolveSubtitle(db: Database.Database, opts: ExportSubtitleOpts): SubtitleResolveResult {
  const fmt = opts.format;

  // 1. 显式 version id 优先
  if (opts.versionId !== undefined) {
    const v = getVersionPayload(db, opts.versionId);
    if (!v) return { kind: 'not_found', message: `subtitle_version not found: id=${opts.versionId}` };
    return { kind: 'ok', payload: v.payload, text: convertSubtitle(v.payload, fmt), format: fmt, versionId: v.id };
  }

  // 2. 按 source + sourceVid 取视频详情（getVideo 已标 is_default 轨 / 每轨 is_default version）
  const detail = getVideo(db, opts.source, opts.sourceVid);
  if (!detail) return { kind: 'not_found', message: `video not found: ${opts.source}/${opts.sourceVid}` };

  // 3. 选轨：--track 精确匹配 lan；否则取 is_default 轨
  const track = opts.track !== undefined
    ? detail.tracks.find((t) => t.lan === opts.track)
    : detail.tracks.find((t) => (t as { is_default?: boolean }).is_default);
  if (!track) {
    const msg = opts.track !== undefined
      ? `track not found: lan=${opts.track} in ${opts.source}/${opts.sourceVid}`
      : `${opts.source}/${opts.sourceVid} 无字幕轨`;
    return { kind: 'not_found', message: msg };
  }

  // 4. 选版本：该轨 is_default version
  const ver = track.versions.find((v) => (v as { is_default?: boolean }).is_default);
  if (!ver) {
    return { kind: 'not_found', message: `track lan=${track.lan ?? '(无)'} 无字幕版本` };
  }

  const v = getVersionPayload(db, ver.id);
  if (!v) return { kind: 'not_found', message: `subtitle_version not found: id=${ver.id}` };
  return {
    kind: 'ok', payload: v.payload, text: convertSubtitle(v.payload, fmt), format: fmt, versionId: v.id,
    trackLan: track.lan, trackLanDoc: track.lan_doc, trackType: track.track_type, versionOrigin: ver.origin,
  };
}
