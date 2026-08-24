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

// uploads playlist(UU + channelId 去 UC 前缀)→ ytInitialData + 续页 token/InnerTube 凭据
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
  // InnerTube 续页凭据（2026-08-24 补全量分页：首页只有 100 条，频道数百视频需 browse 续页）
  const innertubeKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? null;
  const clientVersion = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? null;
  log(`[playlist] ${playlistId} ytInitialData 解析 OK(切片 ${jsonStr.length} 字符;innertubeKey=${innertubeKey ? '有' : '无'})`);
  return { data, innertubeKey, clientVersion };
}

// JSON 树递归收集指定 key（yt-channel.mjs collect 同构；script 侧零依赖复制）
function collectKey(node, key, out = []) {
  if (Array.isArray(node)) { for (const v of node) collectKey(v, key, out); }
  else if (node && typeof node === 'object') {
    if (key in node) out.push(node[key]);
    for (const v of Object.values(node)) collectKey(v, key, out);
  }
  return out;
}

// 续页 token 提取（2026-08-24 适配新结构）：旧 UI 在 continuationCommand.token；
// 新 UI 嵌套为 continuationCommand.trigger + .continuationCommand.innertubeCommand.continuationCommand.token。
// 对全部 continuationCommand 节点逐层下钻取第一个非空 token 字符串。
function findContinuationToken(json) {
  for (const cmd of collectKey(json, 'continuationCommand')) {
    const t = cmd?.token ?? cmd?.continuationCommand?.token ?? cmd?.innertubeCommand?.continuationCommand?.token;
    if (typeof t === 'string' && t) return t;
  }
  return null;
}

// InnerTube browse 续页（node fetch 直连——同层已验证可通；扩展 tab 注入路径另有 'browse HTTP parse' 故障，
// 该路径在扩展侧修复前，全量列表以本脚本为准）。返回 { json, status }。
async function browseContinuation(innertubeKey, clientVersion, token) {
  let res;
  try {
    res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${innertubeKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
        continuation: token,
      }),
    });
  } catch (e) {
    return { status: 0, json: null, cause: String(e.cause?.code ?? e.message) };
  }
  const json = await res.json().catch(() => null);
  log(`[browse] HTTP ${res.status} (${json ? 'JSON OK' : '非 JSON！'})`);
  return { status: res.status, json };
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
  const { data, innertubeKey, clientVersion } = await fetchPlaylistData(channelId);
  const videos = findVideos(data);
  // 全量续页（2026-08-24）：首页 SSR 只有 ~100 条，browse continuation 拉满（频道页 total 对照）
  let token = findContinuationToken(data);
  let page = 1;
  let noNewStreak = 0;
  while (token && typeof token === 'string' && innertubeKey && clientVersion) {
    const r = await browseContinuation(innertubeKey, clientVersion, token);
    if (r.status !== 200 || !r.json) throw new Error(`browse 续页失败: HTTP ${r.status}${r.cause ? ` cause=${r.cause}` : ''}(首页 ${videos.length} 条已保留——续页凭据失效或被拦)`);
    const pageVideos = findVideos(r.json);
    const before = new Set(videos.map(v => v.videoId));
    const added = pageVideos.filter(v => !before.has(v.videoId));
    videos.push(...added);
    token = findContinuationToken(r.json);
    page++;
    noNewStreak = added.length > 0 ? 0 : noNewStreak + 1;
    if (noNewStreak >= 3) { log(`[browse] 连续 3 页无新视频，判定分页停滞终止(已得 ${videos.length} 条)`); break; }
    log(`[browse] 第 ${page - 1} 轮续页: +${added.length}(累计 ${videos.length})`);
    await sleep(600); // 页间节流
  }
  if (!token && page > 1) log(`[browse] 续页拉满: 共 ${page - 1} 轮,累计 ${videos.length} 条`);
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
