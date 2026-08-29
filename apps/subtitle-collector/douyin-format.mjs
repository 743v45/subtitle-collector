// apps/subtitle-collector/douyin-format.mjs
// 抖音数据形态归一（纯函数，无 chrome.* 依赖，node:test 可测）。
// 依据 S1 spike 实测（docs/plans/douyin/spike-findings.md，原始样例 _spike-raw/）：
//   /video/<id> 页走 detail XHR（snake_case aweme_detail，148 键）
//   /jingxuan?modal_id= 分享落地走 SSR `SSR_RENDER_DATA.app.videoDetail`（camelCase，69 键）
// 两路都实现、内部统一到 snake_case aweme_detail 形态（字段更全、与参考项目/S2 映射一致），
// SSR 形态做一层字段名映射（本文件 ssrVideoDetailToAwemeDetail）。

/**
 * SSR videoDetail（camelCase）→ aweme_detail（snake_case）字段映射。
 * 对照表来自 spike-findings §1.3（69 键摘录）；SSR 版本会漂移，缺字段容忍缺省（不抛错），
 * XHR hook 路是主路径（抖音自家 SPA 依赖的接口，更稳），SSR 只作兜底。
 * 2026-08-29 S8 台账性重构：五个子结构各自拆为独立映射函数（复杂度台账达标），表达式逐字原样搬移。
 * @param {object|null|undefined} vd window.SSR_RENDER_DATA.app.videoDetail
 * @returns {object} snake_case aweme_detail 同构对象（缺字段不出现/为空）
 */
export function ssrVideoDetailToAwemeDetail(vd) {
  if (!vd || typeof vd !== 'object') return {};
  // 顶层基本字段
  const base = {
    aweme_id: vd.awemeId != null ? String(vd.awemeId) : null,
    desc: vd.desc ?? null,
    caption: vd.caption ?? null,
    aweme_type: vd.awemeType ?? null,
    create_time: vd.createTime ?? null,
  };
  const mixPart = ssrMixPart(vd.mixInfo);
  const musicPart = ssrMusicPart(vd.music);
  return {
    ...base,
    statistics: ssrStatistics(vd.stats),
    video: ssrVideoPart(vd.video),
    author: ssrAuthorPart(vd.authorInfo),
    text_extra: ssrTextExtra(vd.textExtra),
    // 键序对齐原实现：mix_info 在 text_extra 后、music 最后（spread 条件保持原判据）
    ...mixPart,
    ...musicPart,
    // SSR 无 is_subtitled/cla_info（spike §1.2：该形态不发 detail XHR，字段是 detail 接口专属）
  };
}

/** 内部：SSR stats → statistics（键名对齐 XHR 形态） */
function ssrStatistics(stats) {
  const s = stats ?? {};
  return {
    play_count: s.playCount ?? null,
    digg_count: s.diggCount ?? null,
    comment_count: s.commentCount ?? null,
    share_count: s.shareCount ?? null,
    collect_count: s.collectCount ?? null,
  };
}

/** 内部：SSR video → video（playAddr [{src}] 归一为 play_addr.url_list 字符串数组，spike §1.3） */
function ssrVideoPart(video) {
  const v = video ?? {};
  const playAddr = Array.isArray(v.playAddr)
    ? v.playAddr.map((x) => (x && typeof x.src === 'string' ? x.src : null)).filter(Boolean)
    : [];
  return {
    duration: v.duration ?? null, // 毫秒（与 XHR 形态同口径）
    play_addr: { uri: v.uri ?? null, ...(playAddr.length > 0 ? { url_list: playAddr } : {}) },
  };
}

/** 内部：SSR authorInfo → author（avatarThumb 形态未实测，原样透传由 pickDouyinAvatarUrl 容错） */
function ssrAuthorPart(authorInfo) {
  const a = authorInfo ?? {};
  return {
    uid: a.uid != null ? String(a.uid) : null,
    sec_uid: a.secUid ?? null,
    nickname: a.nickname ?? null,
    ...(a.avatarThumb != null ? { avatar_thumb: a.avatarThumb } : {}),
    ...(a.avatarUri != null ? { avatar_uri: a.avatarUri } : {}),
    ...(a.followerCount != null ? { follower_count: a.followerCount } : {}),
  };
}

/** 内部：SSR textExtra → text_extra（hashtag 项，键名对齐 XHR） */
function ssrTextExtra(textExtra) {
  return (Array.isArray(textExtra) ? textExtra : []).map((t) => ({
    hashtag_id: t?.hashtagId != null ? String(t.hashtagId) : '',
    hashtag_name: t?.hashtagName ?? null,
    start: t?.start ?? null,
    end: t?.end ?? null,
    type: t?.type ?? null,
  }));
}

/** 内部：SSR mixInfo → {mix_info} spread 片段（mixId/mixName ↔ mix_id/mix_desc，spike §1.4⑤；desc 语义更贴 mix_desc） */
function ssrMixPart(mixInfo) {
  if (!(mixInfo && typeof mixInfo === 'object')) return {};
  return {
    mix_info: {
      mix_id: mixInfo.mixId != null ? String(mixInfo.mixId) : null,
      mix_desc: mixInfo.desc ?? mixInfo.mixName ?? null,
    },
  };
}

/** 内部：SSR music → {music} spread 片段（id 优先字符串形态——数字 id 超 JS 安全整数精度，spike 实测 music.id=7.6e18） */
function ssrMusicPart(music) {
  if (!(music && typeof music === 'object')) return {};
  return {
    music: { id_str: music.idStr ?? (music.id != null ? String(music.id) : null), title: music.title ?? null },
  };
}

// sec_uid 形态判据（2026-08-30 审查 M3 三处统一）：`^MS4wLjAB` 前缀（实际形态恒 MS4wLjABAAAA）
// + base64url 后段。三处口径互为镜像，改动须同步：
//   - 扩展本处（extractDouyinUpperKey）
//   - server apps/collector-server/src/tasks/douyin-url.ts 的 DOUYIN_SEC_UID_RE
//   - web apps/collector-web/src/lib/upperTarget.ts 的 SEC_UID_RE
const SEC_UID_RE = /^MS4wLjAB[A-Za-z0-9_-]+$/;

/**
 * 抖音博主页 URL → sec_uid（popup useUpperEntry 识别入口用；判据与 server 端
 * parseDouyinSecUid 对齐：/user/<sec_uid>，MS4wLjAB… base64 形态）。
 * @param {string|null|undefined} url 当前标签页 URL
 * @returns {string|null} sec_uid；非博主页/形态不符 → null
 */
export function extractDouyinUpperKey(url) {
  if (typeof url !== 'string' || url === '') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname.replace(/^(www|m)\./, '') !== 'douyin.com') return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg[0] !== 'user' || !seg[1]) return null;
  try {
    // /user/ 子页（如 /user/<id>/…）只取首段后的 ID 段；decode 失败（坏 % 序列）视同不识别
    const secUid = decodeURIComponent(seg[1]);
    return SEC_UID_RE.test(secUid) ? secUid : null;
  } catch { return null; }
}

/** 内部：毫秒数值 → 秒（null/非数 → null），cue 时间转换用 */
function msToSec(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n / 1000 : null;
}

/** 内部：单 cue {text,start_time,end_time}（毫秒）→ {from,to,content}（秒） */
function utteranceToCue(u) {
  if (!u || typeof u !== 'object') return null;
  const content = typeof u.text === 'string' ? u.text : '';
  if (!content) return null;
  return { from: msToSec(u.start_time), to: msToSec(u.end_time), content };
}

/**
 * 抖音字幕 JSON → {body:[{from,to,content}]}（B 站/YouTube 归一后 cue 同构）。
 * 兼容三种形态（cla_info 登录态样本未实测，第①种为抖音智能字幕 JSON 的通用形态推断，
 * 第②种是 B 站/已归一形态透传，第③种 captions 变体防御）：
 *   ① {utterances:[{text,start_time,end_time}]}——毫秒 → 秒
 *   ② {body:[{from,to,content}]}——已是归一形态，原样透传
 *   ③ {captions:[{text,start_time,end_time}]}——同①口径
 * 无法识别 / 空 cues → null（该轨不上报，由调用方过滤）。
 * @param {object|null|undefined} json 字幕接口响应体
 * @returns {{body:Array<{from:number|null,to:number|null,content:string}>}|null}
 */
export function normalizeDouyinCaption(json) {
  if (!json || typeof json !== 'object') return null;
  if (Array.isArray(json.body)) {
    const cues = json.body
      .map((c) => (c && typeof c === 'object' && typeof c.content === 'string' && c.content
        ? { from: c.from ?? null, to: c.to ?? null, content: c.content }
        : null))
      .filter(Boolean);
    return cues.length > 0 ? { body: cues } : null;
  }
  for (const key of ['utterances', 'captions']) {
    if (Array.isArray(json[key])) {
      const cues = json[key].map(utteranceToCue).filter(Boolean);
      if (cues.length > 0) return { body: cues };
    }
  }
  return null;
}

/**
 * post 列表「200 空体」识别（S1 spike §3 实测：匿名被 gating 时接口回 200 + content-length:0
 * 空体，静默失败非 4xx——必须当一等错误路径，不可误判「该博主 0 作品」）。
 * @param {unknown} body 响应体（text 或已解析对象）
 * @returns {boolean} true = 空体（未登录/风控 gating）
 */
export function isDouyinEmptyPostBody(body) {
  if (body == null) return true;
  if (typeof body === 'string') return body.trim().length === 0;
  return false; // 已解析对象（哪怕空对象 {}）不算空体——抖音正常响应是 {aweme_list,...}
}

/**
 * 从 aweme_detail 抽智能字幕轨（cla_info）。
 * 判据（S1 实测 §2）：is_subtitled(int) + cla_info，仅 detail 接口有（related 列表无）；
 * 匿名实测 3 视频全 0/null → 主路径 no_subtitle → ASR 兜底。
 * ⚠ cla_info 内层结构**未实测**（无登录态样本）：按 R1 定案的 cla_info.cla_infos[] 形态实现，
 * 兼容 TikTok 同源生态的 caption_infos[] / caption_formats[] 键名；遇到真实样本时补验。
 * @param {object|null|undefined} awemeDetail snake_case aweme_detail
 * @returns {Array<{lan:string, lan_doc:string, url:string, is_auto:boolean}>} 有有效 url 的轨
 */
export function extractDouyinCaptionTracks(awemeDetail) {
  const cla = awemeDetail?.cla_info;
  if (!cla || typeof cla !== 'object') return [];
  const list = cla.cla_infos ?? cla.caption_infos ?? cla.caption_formats;
  if (!Array.isArray(list)) return [];
  const firstStr = (...vals) => {
    for (const v of vals) if (typeof v === 'string' && v) return v;
    return null;
  };
  return list
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const lan = firstStr(t.language, t.lang, t.language_code, t.cla_language) ?? 'unknown';
      const url = firstStr(t.url, t.caption_url, t.cla_url);
      // 智能字幕（平台自动生成）默认按自动轨（track_type=1，B 站 AI 同义）；明确人工标记才落 2。
      // 具体标记键未实测，按 TikTok 同源常见键名防御。
      const is_auto = !(t.is_manual === true || t.caption_format === 'creator_caption' || t.caption_format === 'manual');
      return { lan, lan_doc: firstStr(t.language_desc, t.lang_desc, t.name) ?? lan, url, is_auto };
    })
    .filter((t) => typeof t.url === 'string' && t.url);
}
