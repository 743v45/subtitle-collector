// ── 按博主/UP/频道批量：输入目标识别（纯函数，2026-08-29 从 CollectPage 抽出 + douyin 形态）──
// 输入解析（粗判路由，细解析在 server）：裸数字 UID / space.bilibili.com/{mid} → B 站；
// @handle / UC 开头 channelId / youtube.com|youtu.be 链接 → YouTube 频道；
// 裸 sec_uid / douyin.com/user/<sec_uid> 链接 → 抖音博主。
// douyin 复用 channel 键传 sec_uid（对齐 api.ts expandUpperVideos 的 youtube 形态）。

export type UpperTarget = { source: 'bilibili'; mid: string } | { source: 'youtube'; channel: string } | { source: 'douyin'; channel: string };

// 抖音 sec_uid 固定 MS4wLjAB 前缀（实际形态恒 MS4wLjABAAAA），后段 base64url（字母数字-_）；
// 与 B 站纯数字 mid / UC 前缀 channelId 均不冲突。三处口径互为镜像（2026-08-30 审查 M3 统一），改动须同步：
// server apps/collector-server/src/tasks/douyin-url.ts 的 DOUYIN_SEC_UID_RE /
// 扩展 apps/subtitle-collector/douyin-format.mjs extractDouyinUpperKey 的 SEC_UID_RE。
const SEC_UID_RE = /^MS4wLjAB[A-Za-z0-9_-]+$/;

// URL 形态分流（parseUpperTarget 捕获 URL 后委托此处；非链接返回 null）。
// raw 为去空白后的原输入——YouTube 频道页原样透传（细解析在 server），不用 URL 规范化值。
function parseUpperUrl(u: URL, raw: string): UpperTarget | null {
  if (u.hostname === 'space.bilibili.com') {
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (seg && /^\d+$/.test(seg)) return { source: 'bilibili', mid: seg };
  }
  if (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com') || u.hostname === 'youtu.be') {
    return { source: 'youtube', channel: raw };
  }
  if (u.hostname === 'www.douyin.com' || u.hostname === 'douyin.com') {
    const seg = u.pathname.split('/').filter(Boolean);
    // /user/<sec_uid> 主页链接（带 query/子路径的页也认）
    if (seg[0] === 'user' && seg[1] && SEC_UID_RE.test(seg[1])) {
      return { source: 'douyin', channel: seg[1] };
    }
  }
  return null;
}

// 裸 token 或 URL → 平台目标；无法识别返回 null（UI 提示输入格式）
export function parseUpperTarget(text: string): UpperTarget | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return { source: 'bilibili', mid: t };
  if (/^UC[\w-]{22}$/.test(t)) return { source: 'youtube', channel: t };
  if (/^@[\w.-]{3,30}$/.test(t)) return { source: 'youtube', channel: t };
  if (SEC_UID_RE.test(t)) return { source: 'douyin', channel: t };
  try {
    return parseUpperUrl(new URL(t), t);
  } catch { /* 非 URL 忽略 */ }
  return null;
}

// 批量提交的 creatorUid 归属：B 站 mid / 抖音 sec_uid（输入已知，不依赖展开回执）/
// YouTube channelId（展开回执带，无则 undefined）——未入库/失败任务也能在历史页按 UP 筛
export function upperCreatorUid(target: UpperTarget | null, expandedChannelId: string | null | undefined): string | undefined {
  if (target?.source === 'bilibili') return target.mid;
  if (target?.source === 'douyin') return target.channel;
  return expandedChannelId ?? undefined;
}
