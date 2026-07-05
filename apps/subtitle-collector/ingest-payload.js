// 从 /x/web-interface/view 响应抽 extra（字段集对齐 inject.js readVideoExtra / schema.sql extra 注释）
export function extractExtraFromView(v) {
  const extra = { aid: v?.aid ?? null, cid: v?.cid ?? null, pic: v?.pic ?? null };
  if (!v) return extra;
  if (v.desc != null) extra.desc = v.desc;
  if (v.ctime != null) extra.ctime = v.ctime;
  if (v.tid != null) extra.tid = v.tid;
  if (v.copyright != null) extra.copyright = v.copyright;
  if (v.state != null) extra.state = v.state;
  const publoc = v.pub_location ?? v.publocation;
  if (publoc != null) extra.publocation = publoc;
  if (Array.isArray(v.tags)) extra.tags = v.tags.map((t) => ({ tag_id: t.tag_id, tag_name: t.tag_name }));
  if (v.dimension) extra.dimension = { width: v.dimension.width, height: v.dimension.height, rotate: v.dimension.rotate };
  if (Array.isArray(v.pages)) extra.pages = v.pages.map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration }));
  if (v.rights) extra.rights = v.rights;
  if (v.honor_reply) extra.honor = v.honor_reply;
  if (v.ugc_season) extra.ugc_season = { id: v.ugc_season.id, title: v.ugc_season.title };
  if (v.stat) {
    const s = v.stat;
    extra.stat = {
      view: s.view ?? null, danmaku: s.danmaku ?? null, reply: s.reply ?? null,
      favorite: s.favorite ?? null, coin: s.coin ?? null, share: s.share ?? null,
      like: s.like ?? null, now_rank: s.now_rank ?? null, his_rank: s.his_rank ?? null,
    };
  }
  return extra;
}

// 规整 /x/tag/archive/tags 响应 data → [{tag_id, tag_name}]（对齐 extra.tags schema）
export function normalizeTags(data) {
  if (!Array.isArray(data)) return [];
  return data.map((t) => ({ tag_id: t.tag_id, tag_name: t.tag_name }));
}

// // → https: 归一化（对齐 Task 5 plan 调用方：fetch 需要 https，故 bodies 的 key 为 normalize 后的 url）
export function normalizeUrl(u) {
  return typeof u === 'string' && u.startsWith('//') ? 'https:' + u : u;
}

// 组装 ingest payload（结构对齐 content.js flushIfReady 的 record）
// 注：subtitle_url 查找键与 source_url 均经 normalizeUrl 归一化，与 Task 5 plan 调用方存 bodies 的 key 对齐。
// tags：B 站视频标签须单独调 /x/tag/archive/tags（view 响应无 tags 数组），由调用方传入并覆盖默认空。
export function buildIngestPayload(view, subs, subtitleBodies, tags) {
  const extra = extractExtraFromView(view);
  if (Array.isArray(tags) && tags.length > 0) extra.tags = tags;
  return {
    source: 'bilibili',
    video: {
      source_vid: view.bvid,
      creator: {
        source_uid: String(view.owner?.mid ?? 'unknown'),
        name: view.owner?.name ?? null,
        avatar: view.owner?.face ?? null,
      },
      title: view.title,
      extra,
      duration: view.duration ?? null,
      published_at: view.pubdate ? view.pubdate * 1000 : null,
    },
    tracks: (subs ?? []).map((s) => ({
      lan: s.lan, lan_doc: s.lan_doc, track_type: s.type ?? null,
      versions: [{
        origin: 'external',
        payload: subtitleBodies[normalizeUrl(s.subtitle_url)] ?? null,
        source_url: normalizeUrl(s.subtitle_url),
      }],
    })),
  };
}
