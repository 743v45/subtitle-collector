// 诊断会员字幕视频：以游客身份查 view / player/wbi/v2 / subtitle/web/view 的实际结构。
// 用途：定位 subtitle-collector popup 为何拿不到会员视频字幕。
// 跑法：node apps/subtitle-collector/scripts/diag-vip-subtitle.mjs <bvid>
import md5 from '../../../node_modules/.pnpm/md5@2.3.0/node_modules/md5/md5.js';

const BVID = process.argv[2] || 'BV1FyVv6TE5o';
const API = 'https://api.bilibili.com';
const t0 = Date.now();
const el = (m) => console.log(`[${Date.now() - t0}ms] ${m}`);

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
function getMixinKey(raw) { return MIXIN_KEY_ENC_TAB.map((n) => raw[n]).join('').slice(0, 32); }
function encWbi(params, imgKey, subKey, wts = Math.round(Date.now() / 1000)) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const chrFilter = /[!'()*]/g;
  const withWts = { ...params, wts };
  const query = Object.keys(withWts).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withWts[k]).replace(chrFilter, ''))}`).join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', Referer: 'https://www.bilibili.com/' };
async function gj(url) {
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, len: text.length, ct: res.headers.get('content-type'), json, text };
}

el(`诊断 bvid=${BVID}（游客身份，无 cookie）`);

// 1. view（拿 aid/cid + rights 判断会员性质）
el('--- 1. /x/web-interface/view ---');
const view = await gj(`${API}/x/web-interface/view?bvid=${BVID}`);
const vd = view.json?.data ?? {};
el(`status=${view.status} code=${view.json?.code} msg=${view.json?.message}`);
el(`aid=${vd.aid} cid=${vd.cid} title=${vd.title}`);
el(`rights=${JSON.stringify(vd.rights)}`);
el(`status(视频状态)=${vd.state}`);

// 2. nav → wbi keys
el('--- 2. nav wbi keys ---');
const nav = await gj(`${API}/x/web-interface/nav`);
const img = nav.json?.data?.wbi_img?.img_url ?? '';
const sub = nav.json?.data?.wbi_img?.sub_url ?? '';
const imgKey = img.slice(img.lastIndexOf('/') + 1, img.lastIndexOf('.'));
const subKey = sub.slice(sub.lastIndexOf('/') + 1, sub.lastIndexOf('.'));
el(`img_key=${imgKey} sub_key=${subKey}`);

// 3. player/wbi/v2（字幕轨来源）
el('--- 3. /x/player/wbi/v2 ---');
const params = { bvid: BVID, aid: vd.aid, cid: vd.cid };
const qs = encWbi(params, imgKey, subKey);
const player = await gj(`${API}/x/player/wbi/v2?${qs}`);
const pd = player.json?.data ?? {};
el(`status=${player.status} code=${player.json?.code} msg=${player.json?.message}`);
el(`need_login_subtitle=${pd.need_login_subtitle}`);
el(`is_upower_exclusive=${pd.is_upower_exclusive} is_ugc_pay_preview=${pd.is_ugc_pay_preview}`);
el(`elec_high_level=${JSON.stringify(pd.elec_high_level)}`);
const subs = pd.subtitle?.subtitles ?? [];
el(`CC subtitles 轨数=${subs.length}`);
for (const s of subs) el(`  轨: lan=${s.lan} lan_doc=${s.lan_doc} type=${s.type} url=${s.subtitle_url}`);

// 4. subtitle/web/view（AI 字幕来源，protobuf）
el('--- 4. /x/v2/subtitle/web/view ---');
const svParams = new URLSearchParams({
  oid: String(vd.cid), pid: String(vd.aid),
  context_ext: JSON.stringify({ video_type: 1 }), type: '1', cur_production_type: '0',
});
const sv = await gj(`${API}/x/v2/subtitle/web/view?${svParams}`);
el(`status=${sv.status} ct=${sv.ct} body_len=${sv.len}`);
if (sv.json) el(`  json code=${sv.json.code} msg=${sv.json.message}`);
// 仿 fetchSubtitleView 的正则抠 URL
const text = sv.text;
const urlRe = /\/\/(?:aisubtitle|subtitle)\.[a-z0-9.]+\/[^\x00-\x1f\x7f]*?auth_key=[0-9a-f-]+/g;
const urls = [...text.matchAll(urlRe)].map((m) => 'https:' + m[0]);
const langRe = /\b(ai-zh|zh-Hans|zh-Hant|ai-en)\b/g;
const langs = [...text.matchAll(langRe)].map((m) => m[0]);
el(`正则抠出 URL 数=${urls.length}`);
urls.forEach((u, i) => el(`  [${i}] lang=${langs[i] ?? '?'} url=${u}`));
el(`含控制字符编码(%00-%1f)的 URL: ${urls.filter((u) => /%[01][0-9a-f]/i.test(u)).length}`);

// 5. 抽样：第一个 CC 轨 url 能否直接 fetch 字幕体（游客）
if (subs.length > 0 && subs[0].subtitle_url) {
  const u = subs[0].subtitle_url.startsWith('//') ? 'https:' + subs[0].subtitle_url : subs[0].subtitle_url;
  el('--- 5. 直接 fetch CC 字幕体（游客）---');
  const body = await gj(u);
  el(`status=${body.status} body_len=${body.len} ct=${body.ct}`);
  if (body.json) el(`  json ok, 字幕条数=${body.json?.body?.length ?? '?'}`);
}

el(`总耗时 ${Date.now() - t0}ms`);
