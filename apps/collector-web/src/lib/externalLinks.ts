// ── 原站外链构造（与 server tasks.ts parseVideoUrl 的 URL 形态同构）──
// 视频：B 站 /video/<BV>、YouTube /watch?v=<id>、抖音 /video/<awemeId>；
// UP 主：B 站 space/<mid>、YouTube /channel/<UC…>、抖音 /user/<sec_uid>。
// source_uid 对 YouTube 是 UC 开头的 channel ID、对抖音是 MS4wLjAB 开头的 sec_uid（库内归一存储），
// /channel/、/user/ URL 均稳定可开。

export function videoUrl(source: string, sourceVid: string): string {
  if (source === 'youtube') return `https://www.youtube.com/watch?v=${sourceVid}`;
  if (source === 'douyin') return `https://www.douyin.com/video/${sourceVid}`;
  return `https://www.bilibili.com/video/${sourceVid}`;
}

export function creatorUrl(source: string, sourceUid: string): string {
  if (source === 'youtube') return `https://www.youtube.com/channel/${sourceUid}`;
  if (source === 'douyin') return `https://www.douyin.com/user/${sourceUid}`;
  return `https://space.bilibili.com/${sourceUid}`;
}
