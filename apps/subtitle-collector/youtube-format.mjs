// apps/subtitle-collector/youtube-format.mjs
// YouTube 字幕归一化纯函数（不依赖 chrome.* / React / npm，便于 node:test）。
// 输入：JSON3 对象/JSON 字符串 或 XML/srv3 字符串 → 输出 {body:[{from,to,content}]}。
// 产物可直接喂 subtitleFormat.mjs 的 extractCues/subtitleToSRT/subtitleToPlainText。

/** 常见命名实体表（数字实体由 decodeHtmlEntities 内联处理）。 */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * 解码 XML/srv3 文本中的 HTML 实体（&amp; &#39; &#x27; &quot; &apos; &lt; &gt; …）。
 * 覆盖常见命名实体与十/十六进制数字实体；未知/非法实体原样保留（不破坏数据）。
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const numStr = isHex ? body.slice(2) : body.slice(1);
      const code = parseInt(numStr, isHex ? 16 : 10);
      // 合法 Unicode 码点才解码，否则原样返回（防 NaN / 越界抛错）。
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
      ? NAMED_ENTITIES[body]
      : match;
  });
}

/**
 * 从属性串里读取 `name="value"` 的值（缺失返回 null，大小写不敏感）。
 * @param {string} attrs
 * @param {string} name
 * @returns {string | null}
 */
function readAttr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

/**
 * 字符串 → 有限数；非法/空返回 null（由调用方决定兜底，不在此默认 0）。
 * @param {string | null | undefined} value
 * @returns {number | null}
 */
function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从 JSON3 events 数组聚合 cue（spec §5.3 换算）。
 * from=tStartMs/1000；to=(tStartMs+dDurationMs)/1000（缺失→0，即 to=from）；
 * content=segs.filter(s=>s.utf8).map(s=>s.utf8).join(' ').trim()；忽略 tOffsetMs。
 * 无 segs 数组的 event 跳过（容错）。tStartMs 非法兜底为 0。
 * @param {Array<{tStartMs?: number, dDurationMs?: number, segs?: Array<{utf8?: string, tOffsetMs?: number}>}>} events
 * @returns {Array<{from: number, to: number, content: string}>}
 */
function cuesFromJson3Events(events) {
  if (!Array.isArray(events)) return [];
  const cues = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    // 无 segs 数组的 event 直接跳过（个别 event 无文本片段）。
    if (!Array.isArray(ev.segs)) continue;
    const tStartMs =
      typeof ev.tStartMs === 'number' && Number.isFinite(ev.tStartMs) ? ev.tStartMs : 0;
    const dDurationMs =
      typeof ev.dDurationMs === 'number' && Number.isFinite(ev.dDurationMs) ? ev.dDurationMs : 0;
    const content = ev.segs
      .filter((s) => s && s.utf8)
      .map((s) => s.utf8)
      .join(' ')
      .trim();
    cues.push({
      from: tStartMs / 1000,
      to: (tStartMs + dDurationMs) / 1000,
      content,
    });
  }
  return cues;
}

/**
 * 解析 YouTube JSON3 字幕为归一化 cue 数组。
 * 入参可为 JSON3 对象或 JSON 字符串；null/空/非法输入容错返回 {body:[]}。
 * @param {object | string | null | undefined} json3
 * @returns {{body: Array<{from: number, to: number, content: string}>}}
 */
export function parseYoutubeJson3(json3) {
  if (json3 == null || json3 === '') return { body: [] };
  let obj = json3;
  if (typeof json3 === 'string') {
    const trimmed = json3.trim();
    if (trimmed === '') return { body: [] };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // 非法 JSON（如 pot 受限返空/截断体）容错为空 body，不上报脏数据。
      return { body: [] };
    }
  }
  if (typeof obj !== 'object' || obj === null) return { body: [] };
  return { body: cuesFromJson3Events(obj.events) };
}

/**
 * 解析 YouTube XML/srv3 字幕（<transcript><text start dur>…</text></transcript>）。
 * start/dur 单位为秒；dur 缺失→to=from；text 内 HTML 实体解码后 trim。
 * @param {string | null | undefined} xml
 * @returns {{body: Array<{from: number, to: number, content: string}>}}
 */
export function parseYoutubeXml(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') return { body: [] };
  const cues = [];
  // 匹配所有 <text ...>…</text>；attrs 不含 '>'，content 非贪婪跨行。
  const textTagRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = textTagRe.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const rawText = m[2] || '';
    const start = toNumberOrNull(readAttr(attrs, 'start'));
    const dur = toNumberOrNull(readAttr(attrs, 'dur'));
    // start 缺失兜底为 0；dur 缺失→to=from。
    const from = start !== null ? start : 0;
    const to = from + (dur !== null ? dur : 0);
    cues.push({
      from,
      to,
      content: decodeHtmlEntities(rawText).trim(),
    });
  }
  return { body: cues };
}

/**
 * 按 fmt 分发归一化；产物 {body:[{from,to,content}]} 可直接喂 subtitleFormat.mjs。
 * fmt='json3' | 'xml' 走对应解析；fmt 为 null/未知时按内容嗅探：
 * trim 后首字符 '{' → json3、'<' → xml；对象入参按 json3 处理。
 * null/空输入 → {body:[]}。
 * @param {object | string | null | undefined} rawBody
 * @param {'json3' | 'xml' | null} [fmt]
 * @returns {{body: Array<{from: number, to: number, content: string}>}}
 */
export function normalizeYoutubeTimedtext(rawBody, fmt) {
  if (rawBody == null || rawBody === '') return { body: [] };
  if (fmt === 'json3') return parseYoutubeJson3(rawBody);
  if (fmt === 'xml') return parseYoutubeXml(rawBody);
  // fmt 为 null 或未知值：按内容嗅探（对象默认 json3，字符串看首字符）。
  if (typeof rawBody === 'string') {
    const sniff = rawBody.trim();
    if (sniff.startsWith('{')) return parseYoutubeJson3(rawBody);
    if (sniff.startsWith('<')) return parseYoutubeXml(rawBody);
    return { body: [] };
  }
  if (typeof rawBody === 'object') {
    // 对象入参只可能是 json3（xml 永远是字符串）。
    return parseYoutubeJson3(rawBody);
  }
  return { body: [] };
}

/**
 * 解析 YouTube/B站 公开统计数字串为整数。
 * 覆盖：千分位逗号（"6,137"→6137）、中文万/亿/萬（"1.2万"→12000）、英文 K/M/B（"1.2M"→1200000）。
 * 用途：YouTube 已从 ytInitialPlayerResponse.videoDetails 移除 likeCount（实测 keys 无此字段），
 *   点赞数仅 like 按钮 DOM 可见（like-button-view-model textContent / button aria-label）→ content-yt 读 DOM 后用本函数解析。
 * null/空/无数字 → null（由调用方决定兜底）。
 * @param {string | null | undefined} text
 * @returns {number | null}
 */
export function parseStatCount(text) {
  if (text == null) return null;
  const t = String(text);
  // 数字段（可含千分位逗号 + 小数）+ 紧跟的可选单位（中/英文）。
  const m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(亿|万|萬|[kmb])?/i);
  if (!m) return null;
  let num = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === '亿') num *= 1e8;
  else if (unit === '万' || unit === '萬') num *= 1e4;
  else if (unit === 'k') num *= 1e3;
  else if (unit === 'm') num *= 1e6;
  else if (unit === 'b') num *= 1e9;
  return Math.round(num);
}

/**
 * YouTube microformat 发布时间（ISO 串）→ 毫秒纪元。
 * 来源：ytInitialPlayerResponse.microformat.playerMicroformatRenderer.publishDate
 * （或 uploadDate），形如 "2009-10-25T06:57:33-07:00" / "2009-10-25"（日期段按 UTC 零点）。
 * 输出毫秒对齐 B 站 ingest-payload.js 的 pubdate×1000 口径（server published_at 列）。
 * null/空串/非串/不可解析 → null（缺失时字段不出现，不发明值；microformat 的 dateText
 * 是本地化人读串非 ISO，不在此处理）。
 * @param {string | null | undefined} raw
 * @returns {number | null}
 */
export function parseYtPublishDateMs(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
