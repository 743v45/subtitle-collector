// 抖音 URL / 博主标识解析（2026-08-29 douyin 平台接入，S2 server 平台化）。
// 从 tasks/tasks.ts 抽出的独立小模块（沿 db/tag-match.ts 抽出先例）：tasks.ts 已在静态台账
// 超标（复杂度 30 / 669 行），平台分支不回填主文件，防台账恶化。
// 依据 docs/plans/douyin/research-douyin-api.md §2：aweme_id 为 19 位数字；modal_id 是旧 URL
// 查询参数形态，归一到 aweme_id；note/<id> 图集路径与 video 同一 ID 空间（是否可采由扩展端
// 回执 reason='not_video' 区分，server 侧不感知）。

/** aweme_id 形态：19 位数字（入口校验强度对齐 bilibili BV 12 位 / youtube 11 位）。 */
export const DOUYIN_AWEME_ID_RE = /^\d{19}$/;

/** 分享短链域（v.douyin.com 短码 302 → 最终页 URL，expandShortLink 跟随展开）。 */
export const DOUYIN_SHORT_HOSTS: ReadonlySet<string> = new Set(['v.douyin.com']);

/** 标准页域（短链展开后的最终落点，parseVideoUrl 接受解析；含 iesdouyin 分享页形态）。 */
export const DOUYIN_PAGE_HOSTS: ReadonlySet<string> = new Set([
  'www.douyin.com', 'douyin.com', 'www.iesdouyin.com', 'iesdouyin.com',
]);

/** 归一后的 watch URL（collect_tasks.url 列 / 扩展端导航目标共用形态）。 */
export function douyinWatchUrl(id: string): string {
  return `https://www.douyin.com/video/${id}`;
}

/**
 * 解析抖音标准页 URL → { source_vid: aweme_id, url: watch URL }；不匹配返回 null。
 * 三形态归一：/video/<id> 路径 → ?modal_id=<id> 旧查询参数 → /note/<id> 图集路径。
 * ID 一律过 19 位校验（DOUYIN_AWEME_ID_RE），短数字/非数字不收。
 */
export function parseDouyinUrl(u: URL): { source_vid: string; url: string } | null {
  const video = u.pathname.match(/\/video\/(\d+)/);
  const modal = u.searchParams.get('modal_id');
  const note = u.pathname.match(/\/note\/(\d+)/);
  const id = video?.[1] ?? modal ?? note?.[1] ?? '';
  return DOUYIN_AWEME_ID_RE.test(id) ? { source_vid: id, url: douyinWatchUrl(id) } : null;
}

/**
 * 博主标识解析（/api/upper-videos/expand 的 douyin 分支，对齐 youtube parseYtChannelArg 模式）：
 * sec_uid 直传（MS4wLjA… base64 形态）或用户主页 URL（…/user/<sec_uid>…）→ sec_uid；
 * 无法识别抛错（http 层转 400）。S5 web 端可直接透传用户粘贴的主页链接。
 */
export function parseDouyinSecUid(arg: string): string {
  const a = arg.trim();
  if (/^MS4wLjA[\w-]+$/.test(a)) return a;
  try {
    const u = new URL(a);
    const m = u.pathname.match(/\/user\/([^/?]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch { /* 非 URL → 落到下面统一报错 */ }
  throw new Error(`无法识别的抖音博主参数：${arg}（支持 sec_uid / 用户主页链接）`);
}
