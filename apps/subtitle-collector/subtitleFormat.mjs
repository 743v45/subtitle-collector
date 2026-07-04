// apps/subtitle-collector/subtitleFormat.mjs
// 字幕格式化纯函数（不依赖 chrome.* / React / npm，便于 node:test）。
// 输入容错：B 站字幕 body 可能是 {body:[...]} / 直接数组 / null，extractCues 统一兜底。

export const SUBTITLE_FORMATS = ['text', 'timestamp', 'srt'];

/**
 * 从 B 站字幕正文提取字幕条目数组。
 * @param {{body?: Array<{from?: number, to?: number, content?: string}>} | Array<*> | null | undefined} body
 * @returns {Array<{from?: number, to?: number, content?: string}>}
 */
export function extractCues(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.body)) return body.body;
  return [];
}

/** 取条目 content 并去首尾空白（缺失按空串）。 */
function getContent(cue) {
  return (cue?.content ?? '').trim();
}

/** 秒 → mm:ss（分秒各 padStart 2 位）。非有限数/负数兜底为 0（防 NaN/负 → "NaN:NaN"）。 */
function formatMinSec(sec) {
  const safeSec = typeof sec === 'number' && Number.isFinite(sec) && sec >= 0 ? sec : 0;
  const total = Math.floor(safeSec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 秒 → HH:MM:SS,mmm（时/分/秒各 2 位，毫秒 3 位）。非有限数/负数兜底为 0；毫秒封顶 999 防 2.9995→,1000。 */
function formatSrtTime(sec) {
  const safeSec = typeof sec === 'number' && Number.isFinite(sec) && sec >= 0 ? sec : 0;
  const total = Math.floor(safeSec);
  const ms = Math.min(999, Math.round((safeSec - total) * 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const mmm = String(ms).padStart(3, '0');
  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * 纯文本：每条 content 去首尾空白后用 \n 拼接，过滤空白 content。
 * @param {{body?: Array<{from?: number, to?: number, content?: string}>} | Array<*> | null | undefined} body
 * @returns {string}
 */
export function subtitleToPlainText(body) {
  return extractCues(body)
    .map((c) => getContent(c))
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * 时间戳文本：每条形如 [mm:ss] <content>，from 缺失按 0，过滤空白 content。
 * @param {{body?: Array<{from?: number, to?: number, content?: string}>} | Array<*> | null | undefined} body
 * @returns {string}
 */
export function subtitleToTimestamped(body) {
  return extractCues(body)
    .filter((c) => getContent(c).length > 0)
    .map((c) => {
      const from = typeof c.from === 'number' ? c.from : 0;
      return `[${formatMinSec(from)}] ${getContent(c)}`;
    })
    .join('\n');
}

/**
 * 标准 SRT。每块 = 序号 + \n + 时间轴 + \n + content，块间额外空一行，文末换行。
 * from→起始，to→结束（缺失用 from）。无有效条目返回 ""。
 * @param {{body?: Array<{from?: number, to?: number, content?: string}>} | Array<*> | null | undefined} body
 * @returns {string}
 */
export function subtitleToSRT(body) {
  const blocks = extractCues(body)
    .filter((c) => getContent(c).length > 0)
    .map((c, i) => {
      const from = typeof c.from === 'number' ? c.from : 0;
      const to = typeof c.to === 'number' ? c.to : from;
      return `${i + 1}\n${formatSrtTime(from)} --> ${formatSrtTime(to)}\n${getContent(c)}`;
    });
  return blocks.length > 0 ? blocks.join('\n\n') + '\n' : '';
}

/**
 * 按 fmt 分发到对应格式化函数。
 * @param {{body?: Array<{from?: number, to?: number, content?: string}>} | Array<*> | null | undefined} body
 * @param {'text' | 'timestamp' | 'srt'} fmt
 * @returns {string}
 */
export function formatSubtitle(body, fmt) {
  if (fmt === 'text') return subtitleToPlainText(body);
  if (fmt === 'timestamp') return subtitleToTimestamped(body);
  if (fmt === 'srt') return subtitleToSRT(body);
  return '';
}
