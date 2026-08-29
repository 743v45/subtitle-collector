// 组装抖音 ingest payload（结构对齐 buildIngestPayload / buildYoutubePayload，仅 source='douyin' + 字段来源不同）。
// 数据源是归一后的 snake_case aweme_detail（XHR 原样 / SSR 经 douyin-format.mjs 转换），字段口径：
//   - extra.stat 键名完全对齐 B 站（view←play_count、like←digg_count、reply←comment_count、
//     share←share_count、favorite←collect_count）→ server/web 排序筛选统计零改动复用（T1 R5 定案）
//   - 合集存 ugc_season:{id:mix_id,title:mix_desc}（同 B 站键名）→ season 档标签复用
//   - 话题存 tags:[{tag_id:hashtag_id,tag_name:hashtag_name}]（text_extra 映射，对齐 B 站 tags）
//   - play_uri 存稳定 video_id（S4 ASR 直构直链用）；duration 毫秒→秒；create_time unix 秒→ms
//   - play_count web 端恒 0（S1 实测）：照存 0（结构对齐优先），web 展示 — 由 S5 处理，不改 schema
//   - creators.source_uid = author.sec_uid

/** 内部：任意值 → number（字符串数字/数字均可，抖音 follower_count 有字符串形态）；不可数值化 → null */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 内部：url_list 形态封面（{url_list:[...]}）→ 首个 URL；非该形态 → null */
function firstUrlOf(addr) {
  if (Array.isArray(addr?.url_list) && typeof addr.url_list[0] === 'string' && addr.url_list[0]) {
    return addr.url_list[0];
  }
  return null;
}

/**
 * author 的头像 URL（XHR avatar_thumb={url_list} / SSR avatarThumb 未实测形态 / avatarUri 兜底）。
 * @param {object|null|undefined} author aweme_detail.author
 * @returns {string|null}
 */
export function pickDouyinAvatarUrl(author) {
  const thumb = author?.avatar_thumb;
  if (typeof thumb === 'string' && thumb) return thumb; // SSR 形态未实测：可能是裸 URL 字符串
  const fromList = firstUrlOf(thumb);
  if (fromList) return fromList;
  if (typeof author?.avatar_uri === 'string' && author.avatar_uri) return author.avatar_uri;
  return null;
}

/**
 * 是否视频作品（aweme_type===0）。图集（aweme_type≠0）R3 定案范围外：批量列表过滤、
 * 单视频采集不入库回执 reason='not_video'。
 * @param {object|null|undefined} awemeDetail
 * @returns {boolean}
 */
export function isDouyinVideo(awemeDetail) {
  return awemeDetail?.aweme_type === 0;
}

/** 内部：text_extra 里的话题项（type===1 且带 hashtag_name）→ tags（B 站 tags 同构；其余项是 @用户/普通文案标记） */
function douyinTagsOf(d) {
  return (Array.isArray(d?.text_extra) ? d.text_extra : [])
    .filter((t) => t && typeof t === 'object' && t.type === 1 && t.hashtag_name)
    .map((t) => ({ tag_id: t.hashtag_id != null ? t.hashtag_id : null, tag_name: t.hashtag_name }));
}

/** 内部：mix_info → {ugc_season} spread 片段（同 B 站键名，R5 定案） */
function seasonPartOf(d) {
  const mix = d?.mix_info;
  if (!(mix && typeof mix === 'object' && mix.mix_id != null)) return {};
  return { ugc_season: { id: mix.mix_id, title: mix.mix_desc ?? null } };
}

/** 内部：video 三封面 → {cover, origin_cover, dynamic_cover} spread 片段（{url_list} 取首 URL，形态脏值 → null） */
function coverPartOf(video) {
  return {
    ...(video.cover ? { cover: firstUrlOf(video.cover) ?? null } : {}),
    ...(video.origin_cover ? { origin_cover: firstUrlOf(video.origin_cover) ?? null } : {}),
    ...(video.dynamic_cover ? { dynamic_cover: firstUrlOf(video.dynamic_cover) ?? null } : {}),
  };
}

/** 内部：music → {music} spread 片段（id_str 优先——数字 id 超 JS 安全整数精度） */
function musicPartOf(d) {
  if (!d?.music) return {};
  const musicId = d.music.id_str ?? (d.music.id != null ? String(d.music.id) : null);
  return { music: { id: musicId, title: d.music.title ?? null } };
}

/** 内部：video.dimension → {dimension} spread 片段（宽高 rotate，缺省 null 不发明值） */
function dimensionPartOf(video) {
  if (!video.dimension) return {};
  return {
    dimension: {
      width: video.dimension.width ?? null,
      height: video.dimension.height ?? null,
      rotate: video.dimension.rotate ?? null,
    },
  };
}

/** 内部：video 清晰度 → {video_quality} spread 片段（2026-08-29 用户要求补充的挖掘字段；
 * ratio 如 "720p"/"default"、format 如 "mp4"/"dash"、is_h265/is_source_HDR 0|1） */
function videoQualityPartOf(video) {
  if (!video || (video.ratio == null && video.format == null)) return {};
  return {
    video_quality: {
      ratio: video.ratio ?? null,
      format: video.format ?? null,
      is_h265: video.is_h265 ?? null,
      is_source_HDR: video.is_source_HDR ?? null,
    },
  };
}

/** 内部：chapter_list → {chapters} spread 片段（长视频章节；实测样例均为 null，子键名按
 * 常见形态 title/start_time 兜底 startTime/start，结构未实测标注于此——首例带值数据落库时核） */
function chaptersPartOf(d) {
  if (!Array.isArray(d?.chapter_list) || d.chapter_list.length === 0) return {};
  return {
    chapters: d.chapter_list.map((c) => ({
      title: c?.title ?? null,
      start: toNum(c?.start_time ?? c?.startTime ?? c?.start),
    })),
  };
}

/** 内部：aweme_detail 顶层散字段 → spread 片段（2026-08-29 补充：region 地域 / is_top 置顶 /
 * is_ads 广告标记（过滤价值）/ share_url 分享链（原始留存，带设备参数不进 web 展示）） */
function miscFlagsPartOf(d) {
  return {
    ...(d?.region ? { region: d.region } : {}),
    ...(d?.is_top != null ? { is_top: d.is_top } : {}),
    ...(d?.is_ads != null ? { is_ads: d.is_ads } : {}),
    ...(typeof d?.share_url === 'string' && d.share_url ? { share_url: d.share_url } : {}),
  };
}

/** 内部：aweme_detail → extra（R5 定案键集；B 站对齐键名优先）。2026-08-29 S8 台账性重构：
 * 五个可选子结构拆独立片段函数（复杂度台账达标），键序与表达式逐字原样搬移。 */
function buildDouyinExtra(d) {
  const stats = d?.statistics ?? {};
  const video = d?.video ?? {};
  const tags = douyinTagsOf(d);
  return {
    stat: {
      view: toNum(stats.play_count), like: toNum(stats.digg_count), reply: toNum(stats.comment_count),
      share: toNum(stats.share_count), favorite: toNum(stats.collect_count),
    },
    desc: d?.desc ?? null,
    play_uri: video?.play_addr?.uri ?? null,
    aweme_type: d?.aweme_type ?? null,
    ...(tags.length > 0 ? { tags } : {}),
    ...seasonPartOf(d),
    ...coverPartOf(video),
    ...musicPartOf(d),
    ...dimensionPartOf(video),
    ...videoQualityPartOf(video),
    ...chaptersPartOf(d),
    ...miscFlagsPartOf(d),
  };
}

/** 内部：字幕轨 → tracks payload（智能字幕=1（AI/asr，B 站语义同义）；明确人工 = 2（CC/manual）；
 * body 缺失轨 payload=null（server 侧跳过，对齐 bilibili/youtube）） */
function douyinTracksPayload(captionTracks, captionBodies) {
  return (captionTracks ?? []).map((t) => ({
    lan: t.lan,
    lan_doc: t.lan_doc,
    track_type: t.is_auto === false ? 2 : 1,
    versions: [{
      origin: 'external',
      payload: captionBodies?.[t.url] ?? null,
      source_url: t.url,
    }],
  }));
}

/** 内部：author → ingest creator（标识缺失不带 source_uid——server 契约；可选增强键
 * fans←follower_count / verify←custom_verify||enterprise_verify_reason，非空才带，2026-08-29） */
function douyinCreatorOf(author) {
  const secUid = author?.sec_uid;
  const fans = toNum(author?.follower_count);
  const verify = author?.custom_verify || author?.enterprise_verify_reason || null;
  return {
    ...(typeof secUid === 'string' && secUid ? { source_uid: secUid } : {}),
    name: author?.nickname ?? null,
    avatar: pickDouyinAvatarUrl(author),
    ...(fans != null ? { fans } : {}),
    ...(verify ? { verify } : {}),
  };
}

/** 内部：aweme_detail.video 部分（抖音无独立标题字段，desc 即标题（caption 同文兜底）） */
function douyinVideoPart(d) {
  const durationMs = d.video?.duration ?? d.duration;
  const durationSec = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs / 1000 : null;
  const publishedAt = typeof d.create_time === 'number' && Number.isFinite(d.create_time) ? d.create_time * 1000 : null;
  return {
    source_vid: d.aweme_id != null ? String(d.aweme_id) : null,
    creator: douyinCreatorOf(d.author),
    title: d.desc ?? d.caption ?? null,
    extra: buildDouyinExtra(d),
    duration: durationSec,
    published_at: publishedAt,
  };
}

/**
 * 组装 source='douyin' 的 ingest payload（与 buildIngestPayload 同构）。
 * duration：video.duration（毫秒）/1000 → 秒（顶层 duration 同为毫秒作兜底）。
 * published_at：create_time（unix 秒）×1000 → ms（对齐 B 站 pubdate×1000 口径）。
 * @param {object} awemeDetail 归一后 snake_case aweme_detail（XHR 原样或 SSR 转换）
 * @param {Array<{lan:string, lan_doc:string, url:string, is_auto:boolean}>} [captionTracks]
 *        extractDouyinCaptionTracks 抽出的字幕轨（匿名态预期空数组）
 * @param {Record<string, {body:Array<{from:number,to:number,content:string}>}>} [captionBodies]
 *        以轨 url 为 key 的已归一化 cue 数组（background 抓取并 normalizeDouyinCaption）
 * @returns {{source:'douyin', video:object, tracks:Array<object>}}
 */
export function buildDouyinPayload(awemeDetail, captionTracks = [], captionBodies = {}) {
  const d = awemeDetail ?? {};
  return {
    source: 'douyin',
    video: douyinVideoPart(d),
    tracks: douyinTracksPayload(captionTracks, captionBodies),
  };
}

/**
 * profile/other 响应 user → ingest-upper creator（博主批量 expand 顺带入库 creators，
 * 字段集对齐 B 站 get-upper-info：source_uid/name/avatar/sign/fans/following；
 * follower_count 有字符串形态，toNum 容错）。
 * @param {object|null|undefined} user /aweme/v1/web/user/profile/other/ 响应的 user 对象
 * @returns {{source_uid:string, name:string|null, avatar:string|null, sign:string|null, fans:number|null, following:number|null}|null}
 */
export function douyinCreatorFromProfile(user) {
  if (!user || typeof user !== 'object' || typeof user.sec_uid !== 'string' || !user.sec_uid) return null;
  return {
    source_uid: user.sec_uid,
    name: user.nickname ?? null,
    avatar: pickDouyinAvatarUrl(user),
    sign: user.signature ?? null,
    fans: toNum(user.follower_count),
    following: toNum(user.following_count),
  };
}
