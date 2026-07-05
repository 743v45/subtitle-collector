// HTTP query string → VideoFilter 解析（videos list 与 stats aggregate 共用，保证参数口径一致）。
// 数字/布尔非法一律忽略该过滤项（不抛错、不 500）。措辞：字幕（subtitle），非弹幕。
import type { VideoFilter } from '../db/advanced.js';

// 字符串 → 整数；空串/非有限数 → undefined（调用方据此跳过该过滤项）。
function toInt(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// 字符串 → 布尔；'true'/'1'/'yes' → true、'false'/'0'/'no' → false，其余或缺省 → undefined（忽略）。
export function parseBool(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return undefined;
}

// 从 query string 解析 VideoFilter（q/creator/source/tid/tname/tag/lang/track_type/has_subtitle/
// since/until/min_duration/max_duration）。非法值忽略，绝不抛错。
export function parseVideoFilter(p: URLSearchParams): VideoFilter {
  const f: VideoFilter = {};
  const q = p.get('q');
  if (q) f.q = q;
  const creator = p.get('creator');
  if (creator) f.creator = creator;
  const creator_id = toInt(p.get('creator_id'));
  if (creator_id !== undefined) f.creator_id = creator_id;
  const source = p.get('source');
  if (source) f.source = source;
  const tid = toInt(p.get('tid'));
  if (tid !== undefined) f.tid = tid;
  const tname = p.get('tname');
  if (tname) f.tname = tname;
  const tag = p.get('tag');
  if (tag) f.tag = tag;
  const subtitle_q = p.get('subtitle_q');
  if (subtitle_q) f.subtitle_q = subtitle_q;
  const lang = p.get('lang');
  if (lang) f.lang = lang;
  const track_type = toInt(p.get('track_type'));
  if (track_type !== undefined) f.track_type = track_type;
  const has_subtitle = parseBool(p.get('has_subtitle'));
  if (has_subtitle !== undefined) f.has_subtitle = has_subtitle;
  const since = toInt(p.get('since'));
  if (since !== undefined) f.since = since;
  const until = toInt(p.get('until'));
  if (until !== undefined) f.until = until;
  const min_duration = toInt(p.get('min_duration'));
  if (min_duration !== undefined) f.min_duration = min_duration;
  const max_duration = toInt(p.get('max_duration'));
  if (max_duration !== undefined) f.max_duration = max_duration;
  const min_view = toInt(p.get('min_view'));
  if (min_view !== undefined) f.min_view = min_view;
  const max_view = toInt(p.get('max_view'));
  if (max_view !== undefined) f.max_view = max_view;
  const dateFieldRaw = p.get('date_field');
  if (dateFieldRaw === 'first_seen' || dateFieldRaw === 'published_at') f.date_field = dateFieldRaw;
  return f;
}
