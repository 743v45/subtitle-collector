(function () {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

  function isPlayerApi(url) {
    return typeof url === "string" && url.includes("api.bilibili.com/x/player");
  }
  function isSubtitleUrl(url) {
    return typeof url === "string" && (url.includes("aisubtitle") || url.includes("bfs/subtitle") || url.includes("bfs/ai_subtitle"));
  }
  function normalizeUrl(url) {
    if (typeof url !== "string") return "";
    return url.startsWith("//") ? "https:" + url : url;
  }
  function post(type, data) { window.postMessage({ type, data }, "*"); }

  // 从页面 __INITIAL_STATE__.videoData 补充结构性 + 统计字段（player API 不含这些）。
  // __INITIAL_STATE__ 由 B 站 SSR 写入 HTML，PLAYER_META 触发时（已拦到 player API）通常已就绪；
  // 取不到则降级为只含 player API 的 aid/cid/pic，不阻塞字幕采集。
  function readVideoExtra(d) {
    const extra = { aid: d.aid ?? null, cid: d.cid ?? null, pic: d.pic ?? null };
    try {
      const vd = window.__INITIAL_STATE__?.videoData;
      if (!vd) return extra;
      if (vd.desc != null) extra.desc = vd.desc;
      if (vd.ctime != null) extra.ctime = vd.ctime;
      if (vd.tid != null) extra.tid = vd.tid;
      if (vd.tname != null) extra.tname = vd.tname;
      if (vd.copyright != null) extra.copyright = vd.copyright;
      if (vd.state != null) extra.state = vd.state;
      const publoc = vd.pub_location ?? vd.publocation;
      if (publoc != null) extra.publocation = publoc;
      // B 站 SSR 把视频标签放在 __INITIAL_STATE__.tags（顶层，非 videoData.tags）；
      // 主动路径另由 background 调 /x/tag/archive/tags 兜底。两源都无则不设。
      const tagSrc = Array.isArray(window.__INITIAL_STATE__?.tags) ? window.__INITIAL_STATE__.tags : (Array.isArray(vd.tags) ? vd.tags : null);
      if (tagSrc) extra.tags = tagSrc.map((t) => ({ tag_id: t.tag_id, tag_name: t.tag_name }));
      if (vd.dimension) extra.dimension = { width: vd.dimension.width, height: vd.dimension.height, rotate: vd.dimension.rotate };
      if (Array.isArray(vd.pages)) extra.pages = vd.pages.map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration }));
      if (vd.rights) extra.rights = vd.rights;
      if (vd.honor_reply) extra.honor = vd.honor_reply;
      if (vd.ugc_season) extra.ugc_season = { id: vd.ugc_season.id, title: vd.ugc_season.title };
      if (vd.stat) {
        const s = vd.stat;
        extra.stat = {
          view: s.view ?? null, danmaku: s.danmaku ?? null, reply: s.reply ?? null,
          favorite: s.favorite ?? null, coin: s.coin ?? null, share: s.share ?? null,
          like: s.like ?? null, now_rank: s.now_rank ?? null, his_rank: s.his_rank ?? null,
        };
      }
    } catch (e) { console.warn("[inject] readVideoExtra 解析失败，降级为基本 extra", e); }
    return extra;
  }

  // 统一组装 PLAYER_META（fetch/XHR 共用），含从 __INITIAL_STATE__ 读到的 extra
  function buildPlayerMeta(d, subs) {
    return {
      bvid: d.bvid, aid: d.aid, cid: d.cid,
      title: d.title ?? document.title,
      up_mid: d.up_info?.mid ?? null, up_name: d.up_info?.name ?? null,
      pic: d.pic, duration: d.video_info?.duration ?? null,
      published_at: d.pubdate ? d.pubdate * 1000 : null,
      extra: readVideoExtra(d),
      subs: subs.map((s) => ({
        lan: s.lan, lan_doc: s.lan_doc, track_type: s.type ?? null,
        subtitle_url: normalizeUrl(s.subtitle_url),
        url_missing: !normalizeUrl(s.subtitle_url), // spec §7.1 第四情况：单轨 url 缺失标记
      })),
    };
  }

  // ---- fetch ----
  window.fetch = async function (...args) {
    const response = await ORIGINAL_FETCH.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    console.log(`[inject] fetch 调用 url=${url} isPlayer=${isPlayerApi(url)} isSubtitle=${isSubtitleUrl(url)}`);
    try {
      if (isPlayerApi(url)) {
        response.clone().json().then((json) => {
          console.log(`[inject] player API 响应 code=${json?.code} data keys=${Object.keys(json?.data ?? {}).join(',')}`);
          if (json?.code !== 0) { console.warn('[inject] player API 风控 code=', json?.code); post("RISK_CONTROL", { url }); return; }
          const d = json.data ?? {};
          if (d.need_login_subtitle === true) { console.warn('[inject] player API need_login_subtitle=true（建议登录，但已登录用户可能仍可拿字幕，继续检查 subtitles 数组）'); }
          const subs = d.subtitle?.subtitles ?? [];
          if (subs.length === 0) {
            // 无字幕（subtitles 数组空），区分风控/登录/真无字幕：
            if (d.need_login_subtitle === true) { console.warn('[inject] player API 真需登录（subtitles 数组空 + need_login_subtitle=true）'); post("NEED_LOGIN", { url }); }
            else { console.log('[inject] player API 无字幕（subtitles 数组空）'); }
            return;
          }
          const meta = buildPlayerMeta(d, subs);
          console.log(`[inject] player API 拦到 bvid=${meta.bvid} subs=${meta.subs.length} title=${meta.title}`);
          post("PLAYER_META", meta);
        }).catch((e) => console.error('[inject] player API parse error', e));
      }
      if (isSubtitleUrl(url)) {
        response.clone().json().then((data) => {
          const text = JSON.stringify(data);
          console.log(`[inject] subtitle body 拦到 url=${normalizeUrl(url)} body_size=${text.length}`);
          post("SUBTITLE_BODY", { url: normalizeUrl(url), body: data, body_size: text.length });
        }).catch((e) => console.error('[inject] subtitle parse error', e));
      }
    } catch (e) { console.error('[inject] fetch hook error', e); }
    return response;
  };

  // ---- XHR ----
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url; return ORIGINAL_XHR_OPEN.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isPlayerApi(this._url)) {
      this.addEventListener("load", function () {
        try {
          const json = JSON.parse(this.responseText);
          if (json?.code !== 0) { post("RISK_CONTROL", { url: this._url }); return; }
          const d = json.data ?? {};
          if (d.need_login_subtitle === true) { post("NEED_LOGIN", { url: this._url }); return; }
          const subs = d.subtitle?.subtitles ?? [];
          post("PLAYER_META", buildPlayerMeta(d, subs));
        } catch {}
      });
    }
    if (isSubtitleUrl(this._url)) {
      this.addEventListener("load", function () {
        try { post("SUBTITLE_BODY", { url: normalizeUrl(this._url), body: JSON.parse(this.responseText), body_size: this.responseText.length }); } catch {}
      });
    }
    return ORIGINAL_XHR_SEND.apply(this, args);
  };
})();
