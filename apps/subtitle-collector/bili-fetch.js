import { encWbi } from './wbi.js';

const BILI_API = 'https://api.bilibili.com';

// 把 B 站响应体归一化：code:0 → data；-101 → need_login；-412 → risk_control；其余透传 code。
export function parseBiliResponse(body) {
  if (!body || typeof body.code !== 'number') {
    return { ok: false, code: 'malformed', message: 'non-json or missing code' };
  }
  if (body.code === 0) return { ok: true, data: body.data };
  if (body.code === -101) return { ok: false, code: 'need_login' };
  if (body.code === -412) return { ok: false, code: 'risk_control' };
  return { ok: false, code: `bili_${body.code}`, message: body.message ?? '' };
}

// search/type response.data → { total, items:[{bvid,title,up,mid,play,duration,pubdate}] }
export function formatSearchResult(data) {
  const items = Array.isArray(data?.result) ? data.result.map((r) => ({
    bvid: r.bvid, title: (r.title || '').replace(/<em[^>]*>|<\/em>/g, ''), up: r.author, mid: r.mid,
    play: r.play ?? 0, duration: r.duration ?? 0, pubdate: r.pubdate ?? 0,
  })) : [];
  return { total: data?.page?.count ?? items.length, items };
}

// AI 字幕独立接口 /x/v2/subtitle/web/view（B 站新版播放器用，返回 protobuf/octet-stream）。
// player/wbi/v2 的 subtitle.subtitles 只含 CC 字幕；AI 字幕（ai-zh 等）走这个接口。
// 未登录返回空（content-length 2）；登录态（cookie 自动带）返回 protobuf，字幕 URL 明文可正则提取。
// 背景：充电专属等「只有 AI 字幕、无 CC」的视频，player/wbi/v2 subtitles 为空，必须补这个接口才采得到。
// 提取策略：protobuf 的 string 字段是明文 length-delimited，字幕 URL（//subtitle.bilibili.com/<id>?auth_key=...
//   或 //aisubtitle.hdslb.com/...）是连续 ASCII（%编码 id），用正则直接抠，无需 protobuf schema/依赖。
export async function fetchSubtitleView(cid, aid) {
  const params = new URLSearchParams({
    oid: String(cid),
    pid: String(aid),
    context_ext: JSON.stringify({ video_type: 1 }),
    type: '1',
    cur_production_type: '0',
  });
  const url = BILI_API + '/x/v2/subtitle/web/view?' + params.toString();
  let res;
  try {
    res = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/' } });
  } catch { return []; }
  if (!res.ok) return [];
  // protobuf 是任意字节流；UTF-8 解码会让非 ASCII 的 length/varint 字节变 U+FFFD，但 URL/lang 是 ASCII，不受影响。
  const text = new TextDecoder('utf-8').decode(await res.arrayBuffer());
  const urlRe = /\/\/(?:aisubtitle|subtitle)\.[a-z0-9.]+\/[^\x00-\x1f\x7f]*?auth_key=[0-9a-f-]+/g;
  const urls = [...text.matchAll(urlRe)].map((m) => 'https:' + m[0]);
  if (urls.length === 0) return [];
  // 语言码也在响应里明文（ai-zh 等），按出现顺序与 URL 配对；配不上默认 ai-zh（AI 字幕）。
  const langRe = /\b(ai-zh|zh-Hans|zh-Hant|ai-en)\b/g;
  const langs = [...text.matchAll(langRe)].map((m) => m[0]);
  const LAN_DOC = { 'ai-zh': 'AI（简中）', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', 'ai-en': 'AI（English）' };
  return urls
    .map((u, i) => ({
      subtitle_url: u,
      lan: langs[i] ?? 'ai-zh',
      lan_doc: LAN_DOC[langs[i]] ?? langs[i] ?? 'AI（简中）',
      type: 1, // track_type: 1=AI（对齐 player API 的 type 语义）
    }))
    .filter((s) => !/%[01][0-9a-f]/i.test(s.subtitle_url));
    // 过滤含控制字符(%00-%1f)编码的「加密 URL」：新版 AI 字幕的 subtitle.bilibili.com URL 是
    // 播放器内部解码的密文（含 %00 等），Chrome fetch 会以 "Failed to fetch" 拒绝（URL 含 null）。
    // 这类 URL 扩展不可直接 fetch，靠被动采集（inject 拦播放器实际请求的明文 aisubtitle URL）兜底。
}

// 浏览器侧 fetch 编排：扩展 background 调用，cookie 自动带。
//   wbi:true → 先算 Wbi 签名（需 wbiKeys）；headers 固定 Referer。
//   返回 { ok, data } 或 { ok:false, code }（供 action 处理器直接回执）。
export async function biliFetch(pathname, { wbi = false, params = {}, wbiKeys = null } = {}) {
  let url = BILI_API + pathname;
  if (wbi) {
    if (!wbiKeys) throw new Error('wbiKeys required for wbi request');
    url += '?' + encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
  } else {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += '?' + qs;
  }
  const res = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/' } });
  const body = await res.json().catch(() => null);
  return parseBiliResponse(body);
}
