// apps/subtitle-collector/vid-extract.mjs
// 从平台视频页 URL 提取 videoId 的纯函数（无 chrome.* / React / TS 依赖，便于 node:test）。
// 抽自 src/popup/platforms.ts，供 popup 与回归测试共用同一份提取逻辑。
//
// 背景：旧版只支持 /video/BVxxx（BV 在 pathname）；B 站列表型播放页（稍后再看 /list/watchlater、
// 收藏夹 /list/ml{id}、合集等）BV 在 query 参数 ?bvid=...。两类页都要支持，且不破坏旧 /video/ 页。

const BILI_PATH_RE = /bilibili\.com\/video\/(BV[0-9A-Za-z]+)/;
const BILI_BVID_RE = /^BV[0-9A-Za-z]+$/;
const YT_VID_RE = /[?&]v=([A-Za-z0-9_-]{11})/;

/**
 * 从 B 站视频页 URL 提取 BV 号。
 * 先试 pathname 的 /video/BVxxx（旧页，零行为变更），无则试 query 的 bvid（列表播放页）。
 * @param {string} urlStr
 * @returns {string | null} BV 号，或 null（非视频页 / 脏值 / 无法解析）
 */
export function extractBiliVid(urlStr) {
  if (typeof urlStr !== 'string') return null;
  // 旧 /video/BVxxx 路径（保持与原 urlPattern 完全等价的匹配）
  const pathMatch = BILI_PATH_RE.exec(urlStr);
  if (pathMatch) return pathMatch[1];
  // 列表型播放页：bvid 在 query。new URL 解析失败（相对 URL / 非 URL）→ null。
  try {
    const bvid = new URL(urlStr).searchParams.get('bvid');
    if (bvid && BILI_BVID_RE.test(bvid)) return bvid;
  } catch {
    // urlStr 非 absolute URL（new URL 抛）→ 无 query 可提，返回 null
  }
  return null;
}

/**
 * 从 YouTube watch 页 URL 提取 11 位 videoId。
 * 逻辑与原 platforms.ts 的 YT_VID_RE 完全一致（包装，不改行为）。
 * @param {string} urlStr
 * @returns {string | null}
 */
export function extractYoutubeVid(urlStr) {
  if (typeof urlStr !== 'string') return null;
  return YT_VID_RE.exec(urlStr)?.[1] ?? null;
}
