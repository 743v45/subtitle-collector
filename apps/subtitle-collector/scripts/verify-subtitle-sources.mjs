// 验收：实测文档里声称「能拿字幕」的接口，确认哪些真有字幕。
// 验证项：① player/wbi/v2 字幕轨（CC+AI）② AI 视频总结 conclusion/get ③ 投稿只读 lan/search/cid
// 用法：node apps/subtitle-collector/scripts/verify-subtitle-sources.mjs [bvid...]
// 不传则用候选 bvid 自动找一个 view code=0 的。
import md5 from '../../../node_modules/.pnpm/md5@2.3.0/node_modules/md5/md5.js';

const API = 'https://api.bilibili.com';
const t0 = Date.now();
const el = (m) => console.log(`[${Date.now() - t0}ms] ${m}`);
const CANDIDATES = ['BV1GJ411x7h7', 'BV1uv411q7Mv', 'BV1L411a7Li', 'BV1fX4y1G7Ue', 'BV1x411c7mD', 'BV1uv411q7Mv'];
const bvids = process.argv.slice(2).length ? process.argv.slice(2) : CANDIDATES;

const TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
function mixinKey(raw) { return TAB.map((n) => raw[n]).join('').slice(0, 32); }
function encWbi(params, ik, sk, wts = Math.round(Date.now() / 1000)) {
  const mk = mixinKey(ik + sk); const f = /[!'()*]/g;
  const w = { ...params, wts };
  const q = Object.keys(w).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(w[k]).replace(f, ''))}`).join('&');
  return `${q}&w_rid=${md5(q + mk)}`;
}
const H = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', Referer: 'https://www.bilibili.com/' };
async function gj(url) { const r = await fetch(url, { headers: H }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch {} return { status: r.status, ct: r.headers.get('content-type'), json: j, text: t }; }

// 1. 找一个可用 bvid
el('=== 步骤1: 找一个 view code=0 的可用 bvid ===');
let chosen = null;
for (const bv of bvids) {
  const v = await gj(`${API}/x/web-interface/view?bvid=${bv}`);
  el(`  ${bv}: code=${v.json?.code} ${v.json?.code === 0 ? '✓ ' + (v.json.data?.title || '').slice(0, 30) : v.json?.message}`);
  if (v.json?.code === 0 && !chosen) chosen = v.json.data;
}
if (!chosen) { console.error('✗ 没有可用 bvid，请手动传一个存在的'); process.exit(1); }
const { bvid, aid, cid, title } = chosen;
el(`\n选定: bvid=${bvid} aid=${aid} cid=${cid} title=${title.slice(0, 40)}`);

// nav → wbi keys
const nav = await gj(`${API}/x/web-interface/nav`);
const img = nav.json?.data?.wbi_img?.img_url ?? '';
const sub = nav.json?.data?.wbi_img?.sub_url ?? '';
const ik = img.slice(img.lastIndexOf('/') + 1, img.lastIndexOf('.'));
const sk = sub.slice(sub.lastIndexOf('/') + 1, sub.lastIndexOf('.'));
el(`wbi keys: img=${ik} sub=${sk}`);

// 2. player/wbi/v2（基础：字幕轨 CC+AI）
el('\n=== 步骤2: player/wbi/v2 字幕轨（文档: 含 CC+AI）===');
const player = await gj(`${API}/x/player/wbi/v2?${encWbi({ bvid, aid, cid }, ik, sk)}`);
const pd = player.json?.data ?? {};
const subs = pd.subtitle?.subtitles ?? [];
el(`need_login_subtitle=${pd.need_login_subtitle} 字幕轨数=${subs.length}`);
for (const s of subs) {
  const isAi = (s.lan || '').startsWith('ai-') || /aisubtitle|ai_subtitle/.test(s.subtitle_url || '');
  el(`  ${isAi ? '🤖AI' : '✍️CC '} lan=${s.lan} lan_doc=${s.lan_doc} type=${s.type} url=${(s.subtitle_url || '').slice(0, 55)}`);
}

// 3. AI 视频总结 conclusion/get（新发现，必须验）
el('\n=== 步骤3: AI 视频总结 conclusion/get（文档: model_result.subtitle 有时间轴字幕）===');
const conc = await gj(`${API}/x/web-interface/view/conclusion/get?${encWbi({ bvid, aid, cid, up_mid: 0, cloc: '' }, ik, sk)}`);
const cd = conc.json?.data ?? {};
el(`code=${conc.json?.code} msg=${conc.json?.message}`);
const mr = cd.model_result;
if (mr) {
  const concSubs = mr.subtitle ?? [];
  el(`model_result.subtitle 段数=${concSubs.length}`);
  for (const seg of concSubs.slice(0, 3)) {
    const ps = seg.part_subtitle ?? seg.subtitle ?? [];
    el(`  段: part_subtitle 条数=${ps.length}${ps.length ? '（首条: ' + JSON.stringify(ps[0]).slice(0, 80) + '）' : ''}`);
  }
  if (mr.outline) el(`  outline(大纲) 存在, 项数=${(mr.outline||[]).length}`);
  if (mr.summary) el(`  summary(纯文本总结) 存在`);
  if (cd.like_summary_summary || cd.summary) el(`  顶层 summary 存在`);
} else {
  el(`  无 model_result（该视频可能无 AI 总结，或需登录/up_mid）`);
}

// 4. 投稿只读 lan/search/cid（新发现，必须验）
el('\n=== 步骤4: 字幕投稿只读 lan/search/cid（文档: 可查有哪些语言）===');
const lan = await gj(`${API}/x/v2/dm/subtitle/lan/search/cid?type=1&oid=${cid}`);
el(`code=${lan.json?.code} msg=${lan.json?.message} ct=${lan.ct}`);
const lans = lan.json?.data?.lans ?? lan.json?.data ?? [];
if (Array.isArray(lans) && lans.length) {
  el(`  语言数=${lans.length} 样例=${JSON.stringify(lans.slice(0, 5))}`);
} else {
  el(`  无语言列表（data=${JSON.stringify(lan.json?.data ?? null)}）`);
}

// 5. 字幕正文能否 fetch（取第一条轨）
el('\n=== 步骤5: 字幕正文直接 fetch CDN（文档: 明文 JSON）===');
if (subs.length > 0 && subs[0].subtitle_url) {
  const u = subs[0].subtitle_url.startsWith('//') ? 'https:' + subs[0].subtitle_url : subs[0].subtitle_url;
  const body = await gj(u);
  const cues = body.json?.body ?? [];
  el(`首轨 ${subs[0].lan}: HTTP=${body.status} 字幕条数=${cues.length}${cues[0] ? '（首条: ' + JSON.stringify(cues[0]).slice(0, 70) + '）' : ''}`);
} else {
  el('  无字幕轨可测（need_login 或该视频无字幕）');
}

el(`\n=== 验收完成，总耗时 ${Date.now() - t0}ms ===`);
