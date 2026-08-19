#!/usr/bin/env node
// 列 YouTube 频道近 N 个月视频(uploads playlist + ytInitialData,无需 API key)。
// 用法: node scripts/youtube-collect-videos.mjs [channelId|@handle] [月数,默认6]
// 输出: videoId<TAB>publishedText<TAB>title(可 > 到文件供下一步采字幕)
import { setTimeout as sleep } from 'node:timers/promises';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const input = process.argv[2] || 'UCswG6FSbgZjbWtdf_hMLaow'; // 默认 Matt Pocock
const MONTHS = Number(process.argv[3] || 6);

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// @handle → channelId(从频道页 canonical / ytInitialData)
async function handleToChannelId(handle) {
  const html = await fetchText(`https://www.youtube.com/${handle}`);
  const m = html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/) || html.match(/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (!m) throw new Error(`解析 ${handle} channelId 失败(反爬?)`);
  return m[1];
}

// uploads playlist(UU + channelId 去 UC 前缀)→ ytInitialData
async function fetchPlaylistData(channelId) {
  const playlistId = 'UU' + channelId.slice(2);
  const html = await fetchText(`https://www.youtube.com/playlist?list=${playlistId}`);
  // 用 indexOf 切片(避免 regex 非贪婪早停在 JSON 内部 }):ytInitialData = {...}; 后紧跟 </script>
  const start = html.indexOf('ytInitialData');
  if (start < 0) throw new Error('ytInitialData 未找到(反爬/YouTube 改版?)');
  const objStart = html.indexOf('{', start);
  const scriptEnd = html.indexOf('</script>', objStart);
  if (objStart < 0 || scriptEnd < 0) throw new Error('ytInitialData 切片失败');
  const jsonStr = html.slice(objStart, scriptEnd).replace(/;\s*$/, '');
  return JSON.parse(jsonStr);
}

// YouTube 新 UI:playlist 视频用 lockupViewModel(非旧 playlistVideoRenderer)。
// videoId 藏在 contentId(若 11 位)或 thumbnail url /vi/{vid}/;title 在 title.content;
// publishedTime 埋在 metadata.contentMetadataViewModels,递归找 "X ... ago"。
function findVideos(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (obj.lockupViewModel) {
    const lv = obj.lockupViewModel;
    let videoId = typeof lv.contentId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(lv.contentId) ? lv.contentId : null;
    if (!videoId) {
      const m = JSON.stringify(lv).match(/\/vi\/([A-Za-z0-9_-]{11})\//);
      if (m) videoId = m[1];
    }
    const title = lv.title?.content ?? '';
    const publishedText = lv.metadata ? findPubTime(lv.metadata) : '';
    if (videoId) out.push({ videoId, title: String(title).trim(), publishedText });
  }
  for (const v of Object.values(obj)) findVideos(v, out);
  return out;
}

// 递归找 "X ... ago"(publishedTimeText 在 metadata 深处)
function findPubTime(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return /\bago\b/.test(obj) ? obj : '';
  if (typeof obj !== 'object') return '';
  for (const v of Object.values(obj)) {
    const r = findPubTime(v);
    if (r) return r;
  }
  return '';
}

// "3 months ago" / "2 weeks ago" / "1 year ago" → 月数(估算);空 → Infinity(剔除)
function monthsAgo(text) {
  if (!text) return Infinity;
  const m = text.match(/(\d+)\s*(year|month|week|day|hour)/i);
  if (!m) return Infinity;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 'year': return n * 12;
    case 'month': return n;
    case 'week': return n / 4.3;
    case 'day': return n / 30;
    default: return 0; // hour → 近期
  }
}

async function main() {
  let channelId = input;
  if (input.startsWith('@')) channelId = await handleToChannelId(input);
  process.stderr.write(`channelId: ${channelId}\n`);
  const data = await fetchPlaylistData(channelId);
  const videos = findVideos(data);
  process.stderr.write(`uploads playlist 首批 ${videos.length} 视频\n`);
  // 去重(playlist 可能重复项) + 按时间倒序(uploads playlist 本身倒序)
  const seen = new Set();
  const uniq = videos.filter(v => (seen.has(v.videoId) ? false : seen.add(v.videoId)));
  const recent = uniq.filter(v => monthsAgo(v.publishedText) <= MONTHS);
  process.stderr.write(`近 ${MONTHS} 月: ${recent.length} 视频\n`);
  for (const v of recent) console.log([v.videoId, v.publishedText, v.title].join('\t'));
}

main().catch(e => { process.stderr.write(`失败: ${e.message}\n`); process.exit(1); });
