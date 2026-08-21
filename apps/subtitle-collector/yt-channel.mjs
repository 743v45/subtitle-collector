// YouTube 频道页解析纯函数（popup/background 共用，node:test 直测源码）。
// 数据源：频道 /videos tab 的 SSR HTML（ytInitialData）+ InnerTube browse 续页响应。
// 2026-08 实测结构：视频条目为 richItemRenderer → lockupViewModel（contentId=videoId、
// metadataParts 含 views/ago、时长在 thumbnailBadgeViewModel.text）；非旧 videoRenderer。
// 解析全部宽容降级：结构变化时返回 null/空数组，不抛错（background 转 error 标记透传 UI）。

// —— URL 识别：youtube.com 频道页（UP 主页）——
// 命中：/@handle、/@handle/videos 等任意子页；/channel/UCxxx/**；/c/xxx/**、/user/xxx/**（旧式自定义 URL）。
// 排除：/watch、顶层 /shorts/{vid}（短视频播放页，非频道页）、/results、/playlist、/feed 等功能页。
// 返回 {kind, key}：kind=handle（key '@mattpocockuk'）/ channel（key 'UCxxx'）/ custom（key 原样）。
export function extractYoutubeChannelKey(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com') return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length === 0) return null;
  // /@handle/**（handle：字母数字.-_，3-30 位）
  if (/^@[\w.-]{3,30}$/.test(seg[0])) return { kind: 'handle', key: seg[0] };
  // /channel/UCxxx/**（ channelId 固定 UC + 22 位）
  if (seg[0] === 'channel' && seg[1] && /^UC[\w-]{22}$/.test(seg[1])) {
    return { kind: 'channel', key: seg[1] };
  }
  // /c/xxx/**、/user/xxx/**（旧式自定义 URL，非空首段即收，fetch 后 YouTube 自会重定向归一）
  if ((seg[0] === 'c' || seg[0] === 'user') && seg[1] && /^[\w.-]+$/.test(seg[1])) {
    return { kind: 'custom', key: seg[1] };
  }
  return null;
}

// —— 计数文本解析："127K views" / "1.2M views" / "299" → number（K=1e3，M=1e6，去逗号）——
export function parseCountText(text) {
  if (typeof text !== 'string') return null;
  const m = text.replace(/,/g, '').match(/([\d.]+)\s*([KM])?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : 1;
  return Math.round(n * mult);
}

// —— 相对时间解析："2 weeks ago" / "9 months ago" / "Streamed 1 year ago" → 估算 unix 秒 ——
// 粗粒度估算（供「近半年/一年」过滤档位）；now 注入便于测试。
export function parseRelativeTime(text, now = Date.now()) {
  if (typeof text !== 'string') return null;
  const m = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unitSec = {
    second: 1, minute: 60, hour: 3600, day: 86400,
    week: 604800, month: 2592000, year: 31536000,
  }[m[2].toLowerCase()];
  return Math.floor(now / 1000) - n * unitSec;
}

// —— lockupViewModel → 视频条目（宽容：contentType 非 VIDEO / contentId 非 11 位 → null）——
// 返回 { vid, title, created(unix秒估), play, length("M:SS"), pic }。
// pic 不解析页面（直接拼 i.ytimg.com 稳定缩略图 URL）。
export function parseLockup(l) {
  if (!l || l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
  const vid = typeof l.contentId === 'string' && /^[\w-]{11}$/.test(l.contentId) ? l.contentId : null;
  if (!vid) return null;
  const md = l.metadata?.lockupMetadataViewModel ?? {};
  const title = typeof md.title?.content === 'string' && md.title.content ? md.title.content : null;
  // metadataRows → metadataParts：内容判别（views 结尾 / ago 结尾），顺序不依赖
  let play = null;
  let created = null;
  const rows = md.metadata?.contentMetadataViewModel?.metadataRows ?? [];
  for (const row of rows) {
    for (const p of row?.metadataParts ?? []) {
      const t = p?.text?.content ?? '';
      if (/views?$/i.test(t)) play = parseCountText(t);
      else if (/ago$/i.test(t)) created = parseRelativeTime(t);
    }
  }
  // 时长 badge："11:38"（thumbnailBottomOverlayViewModel.badges[].text，结构嵌套深用递归找）
  let length = null;
  const overlays = l.contentImage?.thumbnailViewModel?.overlays ?? [];
  const findDur = (node) => {
    if (length || node == null) return;
    if (Array.isArray(node)) { for (const x of node) findDur(x); return; }
    if (typeof node !== 'object') return;
    if (typeof node.text === 'string' && /^\d{1,3}(:\d{2}){1,2}$/.test(node.text)) { length = node.text; return; }
    for (const v of Object.values(node)) findDur(v);
  };
  findDur(overlays);
  return { vid, title, created, play, length, pic: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` };
}

// —— 递归收集指定 key 的子节点（JSON 树遍历，YouTube 结构层级不定）——
function collect(node, key, out) {
  if (Array.isArray(node)) {
    for (const v of node) collect(v, key, out);
  } else if (node && typeof node === 'object') {
    if (key in node) out.push(node[key]);
    for (const v of Object.values(node)) collect(v, key, out);
  }
}

// —— InnerTube 响应（browse 续页）→ { items, continuation } ——
export function parseYtBrowseResponse(json) {
  const locks = [];
  collect(json, 'lockupViewModel', locks);
  const items = locks.map(parseLockup).filter(Boolean);
  let continuation = null;
  const cmds = [];
  collect(json, 'continuationCommand', cmds);
  if (cmds.length && typeof cmds[0].token === 'string') continuation = cmds[0].token;
  return { items, continuation };
}

// —— 频道 /videos 页 SSR HTML → 全量首页信息 ——
// 返回 { channelId, channelName, inntertubeKey, clientVersion, total, ...parseYtBrowseResponse }。
// 任何一步缺失都宽容：channelId 缺 → null（已采标注不可用但不阻断列表）。
export function parseYtChannelHtml(html) {
  const out = {
    channelId: null, channelName: null,
    inntertubeKey: null, clientVersion: null,
    total: null, items: [], continuation: null,
  };
  if (typeof html !== 'string' || html.length === 0) return out;
  // ytInitialData（SSR 写入的 JSON，var ytInitialData = {...};</script>）
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return out;
  let d;
  try {
    d = JSON.parse(m[1]);
  } catch {
    return out;
  }
  const meta = d?.metadata?.channelMetadataRenderer ?? {};
  if (typeof meta.externalId === 'string') out.channelId = meta.externalId;
  if (typeof meta.title === 'string') out.channelName = meta.title;
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (key) out.inntertubeKey = key[1];
  const ver = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
  if (ver) out.clientVersion = ver[1];
  // 频道视频总数："299 videos" / "1.2K videos"（header 文本）
  const vc = html.match(/"([\d.,]+[KM]?) videos"/);
  if (vc) out.total = parseCountText(vc[1]);
  const parsed = parseYtBrowseResponse(d);
  out.items = parsed.items;
  out.continuation = parsed.continuation;
  return out;
}

// —— 频道标识 → /videos 页 URL（handle / channel / custom 三类）——
export function channelVideosUrl({ handle, channelId, custom }) {
  const base = 'https://www.youtube.com';
  if (handle) return `${base}/${handle}/videos`;
  if (channelId) return `${base}/channel/${channelId}/videos`;
  if (custom) return `${base}/c/${custom}/videos`;
  return null;
}
