// B 站 wbi 签名（CLI 侧移植自扩展 [subtitle-collector/wbi.js](../../../subtitle-collector/wbi.js)，2026-08-26）。
// 消费方：asr backfill 的 playurl 音轨下载（宿主直连 B 站，server 不直连平台的分工不变——
// 本模块只在宿主 CLI 进程内用）。签名算法与测试向量同源 bilibili-API-collect wbi.md，
// 与扩展实现保持逐行等价（测试向量两边共用，防移植漂移）。
import { createHash } from 'node:crypto';

// 社区公开的 64 项重排表（bilibili-API-collect wbi.md）
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** 对 imgKey+subKey 重排，取前 32 字符 → mixin_key。 */
export function getMixinKey(raw: string): string {
  return MIXIN_KEY_ENC_TAB.map((n) => raw[n]).join('').slice(0, 32);
}

/** Wbi 签名：返回完整 query string（含 wts + w_rid）。wts 缺省取当前秒。 */
export function encWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  wts: number = Math.round(Date.now() / 1000),
): string {
  const mixinKey = getMixinKey(imgKey + subKey);
  const chrFilter = /[!'()*]/g;
  const withWts: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(withWts)
    .sort()
    .map((key) => {
      const value = String(withWts[key]).replace(chrFilter, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const wRid = createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/** 从 nav 接口响应抽 img_key / sub_key（去 URL 前缀和 .png 后缀）。 */
export function extractKeysFromNav(navData: unknown): { img_key: string; sub_key: string } {
  const d = (navData as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } })?.data;
  const img = d?.wbi_img?.img_url ?? '';
  const sub = d?.wbi_img?.sub_url ?? '';
  return {
    img_key: img.slice(img.lastIndexOf('/') + 1, img.lastIndexOf('.')),
    sub_key: sub.slice(sub.lastIndexOf('/') + 1, sub.lastIndexOf('.')),
  };
}

/** playurl 的 wbi 签名参数（返回已含 w_rid 的完整 query string；fnval=16 只要 DASH，qn 不影响音轨档）。
 * 2026-08-26 随 asr backfill 自 asr-bili.ts 归位（wbi 应用封装）。 */
export function buildPlayurlQuery(bvid: string, cid: number, imgKey: string, subKey: string): string {
  return encWbi({ bvid, cid, qn: 64, fnval: 16, fnver: 0 }, imgKey, subKey);
}
