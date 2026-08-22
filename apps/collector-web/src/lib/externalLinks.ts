// ── 原站外链构造（与 server tasks.ts parseVideoUrl 的 URL 形态同构）──
// 视频：B 站 /video/<BV>、YouTube /watch?v=<id>；UP 主：B 站 space/<mid>、YouTube /channel/<UC…>
// source_uid 对 YouTube 是 UC 开头的 channel ID（库内归一存储），/channel/ URL 稳定可开。

export function videoUrl(source: string, sourceVid: string): string {
  return source === 'youtube'
    ? `https://www.youtube.com/watch?v=${sourceVid}`
    : `https://www.bilibili.com/video/${sourceVid}`;
}

export function creatorUrl(source: string, sourceUid: string): string {
  return source === 'youtube'
    ? `https://www.youtube.com/channel/${sourceUid}`
    : `https://space.bilibili.com/${sourceUid}`;
}
