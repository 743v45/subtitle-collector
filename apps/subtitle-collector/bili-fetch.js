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
