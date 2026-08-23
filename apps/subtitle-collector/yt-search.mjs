// YouTube 关键词搜索：解析纯函数 + 编排（background action "yt-search" / CLI collect yt-search 用）。
// 数据源与 yt-channel.mjs 同族：结果页 SSR HTML（ytInitialData）+ InnerTube search 续页响应。
// 2026-08-24 无 cookie 实测：搜索页条目为 videoRenderer（旧主结构，20/20 命中）；lockupViewModel
// 是频道页结构，此处兼容收集（YouTube 结构随端/语言/灰度漂移，双解析防打空）。
// InnerTube 公开客户端常量从 background.js 移到此处导出（单一来源，搜索/频道共用）。

import { parseCountText, parseRelativeTime, parseLockup } from './yt-channel.mjs';

// InnerTube WEB 客户端公开默认（页面抠不到 clientVersion 时兜底；key 是长期稳定的公开 WEB key）
export const YT_INNERTUBE_KEY_FALLBACK = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
export const YT_CLIENT_VERSION_FALLBACK = '2.20240101.00.00';

// —— 排序参数 sp（搜索 filter 的 protobuf base64 编码，稳定公开值） ——
// relevance 默认（不带 sp）；newest=上传日期（CAI=）；views=播放量（CAM=，2026-08-24 无 cookie
// 实测生效）。⚠ newest 在无 cookie 冒烟下未呈现时间序（疑似需登录态），扩展环境带 cookie 行为
// 待真实使用核对——回执 items 带 agoText，肉眼可验；排序不生效时降级 relevance 不影响采集。
export const YT_SEARCH_ORDER_SP = {
  relevance: null,
  newest: 'CAI=',
  views: 'CAM=',
};

// —— keyword + order → 结果页 URL（keyword 全量编码，防 & = 拼进 query 结构） ——
export function searchResultsUrl(keyword, order = 'relevance') {
  const sp = YT_SEARCH_ORDER_SP[order] ?? null; // 未知 order 宽容按 relevance
  const q = encodeURIComponent(keyword);
  return `https://www.youtube.com/results?search_query=${q}${sp ? `&sp=${encodeURIComponent(sp)}` : ''}`;
}

// —— 旧结构 videoRenderer → 视频条目（宽容：videoId 非 11 位 → null；字段缺失 → null 不炸） ——
// 返回形状与 parseLockup 对齐：{ vid, title, created(unix秒估), agoText, play, length("M:SS"), pic }。
export function parseVideoRenderer(r) {
  if (!r || typeof r.videoId !== 'string' || !/^[\w-]{11}$/.test(r.videoId)) return null;
  const runsText = (o) => (Array.isArray(o?.runs) ? o.runs.map((x) => x?.text ?? '').join('') : null);
  const title = runsText(r.title);
  const views = typeof r.viewCountText?.simpleText === 'string' ? r.viewCountText.simpleText : null;
  const ago = typeof r.publishedTimeText?.simpleText === 'string' ? r.publishedTimeText.simpleText : null;
  const lt = r.lengthText?.simpleText;
  return {
    vid: r.videoId,
    title: title || null,
    created: ago ? parseRelativeTime(ago) : null,
    agoText: ago,
    play: views ? parseCountText(views) : null,
    // 时长校验 M:SS / H:MM:SS（直播 "LIVE" 等非形态 → null）
    length: typeof lt === 'string' && /^\d{1,3}(:\d{2}){1,2}$/.test(lt) ? lt : null,
    pic: `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`,
  };
}

// —— 递归收集指定 key 的子节点（JSON 树遍历，YouTube 结构层级不定；对齐 yt-channel.mjs 内部同款） ——
function collect(node, key, out) {
  if (Array.isArray(node)) {
    for (const v of node) collect(v, key, out);
  } else if (node && typeof node === 'object') {
    if (key in node) out.push(node[key]);
    for (const v of Object.values(node)) collect(v, key, out);
  }
}

// —— InnerTube search 续页响应 / ytInitialData 通用 → { items, continuation, hitLockups, hitRenderers } ——
// 双结构收集（lockupViewModel 新 + videoRenderer 旧）+ vid 去重；channelRenderer 等非视频条目天然过滤。
// hit* 命中计数透传给调用方（§9 可观察性：结构漂移时可从回执直接看出解析打到哪层）。
export function parseYtSearchResponse(json) {
  const locks = [];
  const renderers = [];
  const cmds = [];
  collect(json, 'lockupViewModel', locks);
  collect(json, 'videoRenderer', renderers);
  collect(json, 'continuationCommand', cmds);
  const seen = new Set();
  const items = [...locks.map(parseLockup), ...renderers.map(parseVideoRenderer)]
    .filter(Boolean)
    .filter((it) => (seen.has(it.vid) ? false : seen.add(it.vid)));
  const continuation = cmds.length && typeof cmds[0].token === 'string' ? cmds[0].token : null;
  return { items, continuation, hitLockups: locks.length, hitRenderers: renderers.length };
}

// —— 搜索结果页 SSR HTML → 全量首页信息 ——
// 返回 { found, estimatedResults, inntertubeKey, clientVersion, ...parseYtSearchResponse }。
// found=false 表示页里没有 ytInitialData（反爬/consent 页特征），调用方据此抛带特征的错而非盲猜。
export function parseYtSearchHtml(html) {
  const out = {
    found: false, estimatedResults: null, inntertubeKey: null, clientVersion: null,
    items: [], continuation: null, hitLockups: 0, hitRenderers: 0,
  };
  if (typeof html !== 'string' || html.length === 0) return out;
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return out;
  let d;
  try {
    d = JSON.parse(m[1]);
  } catch {
    return out;
  }
  out.found = true;
  // estimatedResults 是字符串数字（"12345"）；非数字宽容 → null
  if (typeof d?.estimatedResults === 'string' && /^\d+$/.test(d.estimatedResults)) {
    out.estimatedResults = Number(d.estimatedResults);
  }
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (key) out.inntertubeKey = key[1];
  const ver = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
  if (ver) out.clientVersion = ver[1];
  const parsed = parseYtSearchResponse(d);
  out.items = parsed.items;
  out.continuation = parsed.continuation;
  out.hitLockups = parsed.hitLockups;
  out.hitRenderers = parsed.hitRenderers;
  return out;
}

// —— 编排：首页 HTML fetch + 可选 InnerTube search 续页（依赖注入，node:test 直测无网络） ——
// deps: { fetchHtml(url)→{status,text}, searchContinuation(key,ver,token)→{status,json}, sleep? }
//（searchContinuation 由 background 经 youtube tab 实现——MV3 SW 跨源 POST 的 Origin 被 InnerTube 403）。
// 返回 { keyword, order, raw_total, pages_fetched, items, diag }；diag 带 html_len 与解析命中计数。
// 失败路径全带上下文（HTTP 状态/页号/HTML 长度），对齐 CLAUDE.md §9 先可观察再排查。

// 首页：fetch + found 校验。失败带特征（HTTP 状态/长度/反爬标记），不盲猜。
async function fetchFirstPage(deps, keyword, order) {
  const res = await deps.fetchHtml(searchResultsUrl(keyword, order));
  if (!res || res.status !== 200 || typeof res.text !== 'string') {
    throw new Error(`results page HTTP ${res?.status ?? 'none'}（keyword=${keyword} html_len=${res?.text?.length ?? 0}）`);
  }
  const first = parseYtSearchHtml(res.text);
  if (!first.found) {
    throw new Error(`结果页无 ytInitialData（keyword=${keyword} html_len=${res.text.length}，疑似反爬/consent 页）`);
  }
  return { res, first };
}

// vid 去重合并（lockup/renderer 双来源与续页位移重叠时防重复）。
function mergeUnique(items, seen, list) {
  for (const it of list) {
    if (!seen.has(it.vid)) { seen.add(it.vid); items.push(it); }
  }
}

// 续页循环：continuation 驱动，直到无 token / 翻满 maxPages / 失败抛错（带页号）。
// 返回续页数（首页已计入 maxPages，续页可用额度 = maxPages - 1）。
async function fetchContinuationPages(deps, first, items, seen, maxPages, gapMs, keyword) {
  let continuation = first.continuation;
  let fetched = 0;
  const key = first.inntertubeKey || YT_INNERTUBE_KEY_FALLBACK;
  const ver = first.clientVersion || YT_CLIENT_VERSION_FALLBACK;
  while (continuation && fetched + 1 < maxPages) {
    const page = await deps.searchContinuation(key, ver, continuation);
    if (!page || page.status !== 200 || !page.json) {
      throw new Error(`search continuation HTTP ${page?.status ?? 'parse'}（keyword=${keyword} page=${fetched + 2}）`);
    }
    const parsed = parseYtSearchResponse(page.json);
    mergeUnique(items, seen, parsed.items);
    continuation = parsed.continuation;
    fetched++;
    if (!continuation) break;
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(gapMs); // 页间节流防风控
  }
  return fetched;
}

export async function runYtSearch(deps, { keyword, order = 'relevance', pages = 1, gapMs = 500 }) {
  const { res, first } = await fetchFirstPage(deps, keyword, order);
  const items = [];
  const seen = new Set();
  mergeUnique(items, seen, first.items);
  const maxPages = Math.max(1, Math.min(Number.isFinite(pages) ? pages : 1, 10));
  const contPages = await fetchContinuationPages(deps, first, items, seen, maxPages, gapMs, keyword);
  return {
    keyword,
    order,
    raw_total: first.estimatedResults,
    pages_fetched: 1 + contPages,
    items,
    diag: { html_len: res.text.length, hit_lockups: first.hitLockups, hit_renderers: first.hitRenderers },
  };
}

// —— background action "yt-search" 的执行体（background 只留薄分支 + chrome 依赖注入，全逻辑在此可测） ——
// msg: { keyword, order, pages }；io: { fetchHtml, ensureTab()→{tabId,opened}, innertubeViaTab(...), closeTab(tabId) }。
// tab 惰性：仅续页需要时 ensure（复用用户已开的非活跃 tab 优先）；finally 只关自建的后台 tab。
export async function runYtSearchAction(msg, io) {
  const keyword = typeof msg?.keyword === 'string' && msg.keyword.trim() ? msg.keyword.trim() : null;
  if (!keyword) throw new Error('keyword required');
  const pages = Number.isInteger(msg?.pages) && msg.pages > 0 ? msg.pages : 1;
  let ytTab = null;
  try {
    return await runYtSearch({
      fetchHtml: io.fetchHtml,
      searchContinuation: async (key, ver, token) => {
        if (!ytTab) ytTab = await io.ensureTab();
        return io.innertubeViaTab(ytTab.tabId, 'search', key, ver, token);
      },
    }, { keyword, order: msg.order, pages });
  } finally {
    if (ytTab?.opened) await io.closeTab(ytTab.tabId);
  }
}
