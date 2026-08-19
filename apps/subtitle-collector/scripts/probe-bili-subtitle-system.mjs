// 抓取 B 站字幕系统各层 API 的真实结构，用于撰写「B 站字幕设计思路」文档。
// 游客身份（无 cookie），抓：view / player/wbi/v2 / subtitle/web/view(protobuf) 的完整字段。
// 用法：node apps/subtitle-collector/scripts/probe-bili-subtitle-system.mjs <bvid> [普通bvid对比]
import md5 from '../../../node_modules/.pnpm/md5@2.3.0/node_modules/md5/md5.js';

const BVID = process.argv[2] || 'BV1FyVv6TE5o'; // 默认充电视频
const NORMAL_BVID = process.argv[3] || 'BV1L411a7Li'; // 普通视频对比（有 CC 字幕，B站官方科普向）
const API = 'https://api.bilibili.com';
const t0 = Date.now();
const el = (m) => console.log(`[${Date.now() - t0}ms] ${m}`);

const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
function getMixinKey(raw) { return MIXIN_KEY_ENC_TAB.map((n) => raw[n]).join('').slice(0, 32); }
function encWbi(params, imgKey, subKey, wts = Math.round(Date.now() / 1000)) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const f = /[!'()*]/g;
  const w = { ...params, wts };
  const q = Object.keys(w).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(w[k]).replace(f, ''))}`).join('&');
  return `${q}&w_rid=${md5(q + mixinKey)}`;
}
const H = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', Referer: 'https://www.bilibili.com/' };
async function gj(url) { const r = await fetch(url, { headers: H }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch {} return { status: r.status, ct: r.headers.get('content-type'), json: j, text: t }; }

async function probe(bvid, label) {
  el(`\n========== ${label} (${bvid}) ==========`);
  // view
  const view = await gj(`${API}/x/web-interface/view?bvid=${bvid}`);
  const vd = view.json?.data ?? {};
  el(`[view] code=${view.json?.code} aid=${vd.aid} cid=${vd.cid}`);
  el(`  title=${vd.title}`);
  el(`  rights=${JSON.stringify(vd.rights)}`);
  el(`  ugc_season=${vd.ugc_season ? JSON.stringify({ id: vd.ugc_season.id, title: vd.ugc_season.title }) : 'null'}`);

  // nav → wbi keys
  const nav = await gj(`${API}/x/web-interface/nav`);
  const img = nav.json?.data?.wbi_img?.img_url ?? '';
  const sub = nav.json?.data?.wbi_img?.sub_url ?? '';
  const imgKey = img.slice(img.lastIndexOf('/') + 1, img.lastIndexOf('.'));
  const subKey = sub.slice(sub.lastIndexOf('/') + 1, sub.lastIndexOf('.'));

  // player/wbi/v2
  const params = { bvid, aid: vd.aid, cid: vd.cid };
  const player = await gj(`${API}/x/player/wbi/v2?${encWbi(params, imgKey, subKey)}`);
  const pd = player.json?.data ?? {};
  el(`[player/wbi/v2] code=${player.json?.code}`);
  el(`  付费标志: is_upower_exclusive=${pd.is_upower_exclusive} is_ugc_pay_preview=${pd.is_ugc_pay_preview}`);
  el(`  elec_high_level=${JSON.stringify(pd.elec_high_level)}`);
  el(`  need_login_subtitle=${pd.need_login_subtitle}`);
  el(`  asr_language=${pd.asr_language} ocr_language=${pd.ocr_language}`);
  const subs = pd.subtitle?.subtitles ?? [];
  el(`  subtitle.subtitles (CC 轨) 数=${subs.length}`);
  for (const s of subs) el(`    - lan=${s.lan} lan_doc=${s.lan_doc} type=${s.type} ai_status=${s.ai_status ?? '?'} subtitle_url=${(s.subtitle_url||'').slice(0,60)}`);
  // 打印几个关键 player 字段是否存在
  el(`  字段存在性: subtitle=${!!pd.subtitle} elec_high_level=${'elec_high_level' in pd} vip=${!!pd.vip} login_mid=${pd.login_mid ?? '无'}`);

  // subtitle/web/view (protobuf)
  const svParams = new URLSearchParams({ oid: String(vd.cid), pid: String(vd.aid), context_ext: JSON.stringify({ video_type: 1 }), type: '1', cur_production_type: '0' });
  const sv = await gj(`${API}/x/v2/subtitle/web/view?${svParams}`);
  el(`[subtitle/web/view] status=${sv.status} ct=${sv.ct} body_len=${sv.text.length}`);
  if (sv.json) el(`  → json code=${sv.json.code} msg=${sv.json.message}（空响应=未登录）`);
  else {
    const urlRe = /\/\/(?:aisubtitle|subtitle)\.[a-z0-9.]+\/[^\x00-\x1f\x7f]*?auth_key=[0-9a-f-]+/g;
    const urls = [...sv.text.matchAll(urlRe)].map((m) => 'https:' + m[0]);
    const langRe = /\b(ai-zh|zh-Hans|zh-Hant|ai-en|ai-ja)\b/g;
    const langs = [...sv.text.matchAll(langRe)].map((m) => m[0]);
    el(`  → protobuf: 抠出 URL 数=${urls.length}, lang 标记=${[...new Set(langs)].join(',') || '无'}`);
    el(`  → 含控制字符编码(%00-%1f)的 URL 数=${urls.filter((u) => /%[01][0-9a-f]/i.test(u)).length}（加密）`);
    el(`  → 明文可 fetch 的 URL 数=${urls.filter((u) => !/%[01][0-9a-f]/i.test(u)).length}`);
  }
}

await probe(BVID, '充电视频（privilege_type=20）');
await probe(NORMAL_BVID, '普通视频对比（应有 CC 字幕）');
el(`\n总耗时 ${Date.now() - t0}ms`);
