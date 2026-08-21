#!/usr/bin/env node
// 列 YouTube 频道近 N 个月视频(uploads playlist + ytInitialData,无需 API key)。
// 用法: node scripts/youtube-collect-videos.mjs [channelId|@handle] [月数,默认6]
// 输出: videoId<TAB>publishedText<TAB>title(可 > 到文件供下一步采字幕)
// 日志纪律(CLAUDE.md §9):全部诊断走 stderr、带 [step] 前缀;失败必须携带可定位根因的
// 上下文(页面特征/结构命中计数/每步输入输出数),禁止「解析失败(反爬?)」式盲报。
import { setTimeout as sleep } from 'node:timers/promises';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const input = process.argv[2] || 'UCswG6FSbgZjbWtdf_hMLaow'; // 默认 Matt Pocock
const MONTHS = Number(process.argv[3] || 6);

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// 页面特征摘要:任何「内容不符合预期」的失败都要带上它,区分反爬/consent/改版/空页。
function pageDiag(html) {
  const title = (html.match(/<title[^>]*>([^<]{0,120})/)?.[1] ?? '').trim();
  const feats = [];
  if (/consent\.youtube\.com|consentButton|consent-/.test(html)) feats.push('consent');
  if (/g-recaptcha|captcha-container|class="captcha/.test(html)) feats.push('captcha');
  if (/ytInitialData/.test(html)) feats.push('ytInitialData');
  if (/ytInitialPlayerResponse/.test(html)) feats.push('ytInitialPlayerResponse');
  return `len=${html.length} title="${title}" feats=[${feats.join(',') || '-'}]`;
}

async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } });
  } catch (e) {
    // fetch failed 是网络层(DNS/代理/防火墙/TLS),cause 才是根因(ENOTFOUND/ECONNREFUSED/…)
    const cause = e.cause ? ` cause=${e.cause.code ?? e.cause.message ?? e.cause}` : '';
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '(无)';
    throw new Error(`fetch 网络层失败: ${e.message}${cause};proxy=${proxy}(undici 不读系统代理,需 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY)`);
  }
  const text = await res.text();
  log(`[fetch] HTTP ${res.status} ${url}`);
  log(`[fetch]   ${pageDiag(text)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return text;
}

// @handle → channelId(从频道页 canonical / ytInitialData)
async function handleToChannelId(handle) {
  const html = await fetchText(`https://www.youtube.com/${handle}`);
  const m = html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/) || html.match(/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (!m) throw new Error(`解析 ${handle} channelId 失败;页面特征 ${pageDiag(html)}(反爬/consent/改版,按特征定位)`);
  log(`[handle] ${handle} → channelId ${m[1]}`);
  return m[1];
}

// uploads playlist(UU + channelId 去 UC 前缀)→ ytInitialData
async function fetchPlaylistData(channelId) {
  const playlistId = 'UU' + channelId.slice(2);
  const html = await fetchText(`https://www.youtube.com/playlist?list=${playlistId}`);
  // 用 indexOf 切片(避免 regex 非贪婪早停在 JSON 内部 }):ytInitialData = {...}; 后紧跟 </script>
  const start = html.indexOf('ytInitialData');
  if (start < 0) throw new Error(`ytInitialData 未找到;页面特征 ${pageDiag(html)}(反爬/consent/改版,按特征定位)`);
  const objStart = html.indexOf('{', start);
  const scriptEnd = html.indexOf('</script>', objStart);
  if (objStart < 0 || scriptEnd < 0) throw new Error(`ytInitialData 切片失败: start=${start} objStart=${objStart} scriptEnd=${scriptEnd};页面特征 ${pageDiag(html)}`);
  const jsonStr = html.slice(objStart, scriptEnd).replace(/;\s*$/, '');
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`ytInitialData JSON.parse 失败(${e.message});切片长度 ${jsonStr.length},尾部 80 字符: ${JSON.stringify(jsonStr.slice(-80))}`);
  }
  log(`[playlist] ${playlistId} ytInitialData 解析 OK(切片 ${jsonStr.length} 字符)`);
  return data;
}

// 结构命中统计:遍历时计数所有 *Renderer/*ViewModel 键。0 视频时输出 top 计数,
// 分辨「YouTube 改版(出现新的 renderer 键)」与「页面被反爬替换(几乎无 renderer)」。
function countStructKeys(obj, stats = new Map()) {
  if (!obj || typeof obj !== 'object') return stats;
  for (const [k, v] of Object.entries(obj)) {
    if (/(Renderer|ViewModel)$/.test(k)) stats.set(k, (stats.get(k) ?? 0) + 1);
    countStructKeys(v, stats);
  }
  return stats;
}

// YouTube 新 UI:playlist 视频用 lockupViewModel(非旧 playlistVideoRenderer)。
// videoId 藏在 contentId(若 11 位)或 thumbnail url /vi/{vid}/;标题在
// metadata.lockupMetadataViewModel.title.content(对齐扩展共享解析器 yt-channel.mjs parseLockup,
// 不挂 lv.title——该路径不存在,曾致 100/100 命中视频标题全空);
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
    const title = lv.metadata?.lockupMetadataViewModel?.title?.content ?? '';
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
  log(`[main] channelId: ${channelId}`);
  const data = await fetchPlaylistData(channelId);
  const videos = findVideos(data);
  const titleHit = videos.filter(v => v.title).length;
  const timeHit = videos.filter(v => v.publishedText).length;
  log(`[parse] lockupViewModel 命中视频 ${videos.length} 条;标题 ${titleHit}/${videos.length}、时间 ${timeHit}/${videos.length}(任一命中率骤降 = 对应字段结构改版)`);
  if (videos.length === 0) {
    const top = [...countStructKeys(data).entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([k, n]) => `${k}:${n}`).join(' ');
    log(`[parse] ⚠️ 0 视频,结构命中 top10: ${top || '(无任何 Renderer/ViewModel 键——页面非正常播放列表,疑反爬)'}`);
  }
  // 去重(playlist 可能重复项) + 按时间倒序(uploads playlist 本身倒序)
  const seen = new Set();
  const uniq = videos.filter(v => (seen.has(v.videoId) ? false : seen.add(v.videoId)));
  const noTime = uniq.filter(v => !v.publishedText).length;
  const recent = uniq.filter(v => monthsAgo(v.publishedText) <= MONTHS);
  log(`[filter] 近 ${MONTHS} 月 ${recent.length}/${uniq.length} 条(去重剔除 ${videos.length - uniq.length};无时间文本 ${noTime} 条按超龄剔除——若大,疑 metadata 结构改版)`);
  for (const v of recent) console.log([v.videoId, v.publishedText, v.title].join('\t'));
}

main().catch(e => { log(`失败: ${e.message}`); process.exit(1); });
