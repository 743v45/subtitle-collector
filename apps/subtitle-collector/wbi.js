import md5 from 'md5';

// 社区公开的 64 项重排表（bilibili-API-collect wbi.md）
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

// 对 imgKey+subKey 重排，取前 32 字符 → mixin_key
export function getMixinKey(raw) {
  return MIXIN_KEY_ENC_TAB.map((n) => raw[n]).join('').slice(0, 32);
}

// Wbi 签名：返回完整 query string（含 wts + w_rid）。wts 缺省取当前秒。
export function encWbi(params, imgKey, subKey, wts = Math.round(Date.now() / 1000)) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const chrFilter = /[!'()*]/g;
  const withWts = { ...params, wts };
  const query = Object.keys(withWts)
    .sort()
    .map((key) => {
      const value = String(withWts[key]).replace(chrFilter, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const wRid = md5(query + mixinKey);
  return `${query}&w_rid=${wRid}`;
}

// 从 nav 接口响应抽 img_key / sub_key（去 URL 前缀和 .png 后缀）
export function extractKeysFromNav(navData) {
  const img = navData?.data?.wbi_img?.img_url ?? '';
  const sub = navData?.data?.wbi_img?.sub_url ?? '';
  return {
    img_key: img.slice(img.lastIndexOf('/') + 1, img.lastIndexOf('.')),
    sub_key: sub.slice(sub.lastIndexOf('/') + 1, sub.lastIndexOf('.')),
  };
}
