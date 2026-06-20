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

  // ---- fetch ----
  window.fetch = async function (...args) {
    const response = await ORIGINAL_FETCH.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    console.log(`[inject] fetch 调用 url=${url} isPlayer=${isPlayerApi(url)} isSubtitle=${isSubtitleUrl(url)}`);
    try {
      if (isPlayerApi(url)) {
        response.clone().json().then((json) => {
          if (json?.code !== 0) { post("RISK_CONTROL", { url }); return; }
          const d = json.data ?? {};
          if (d.need_login_subtitle === true) { post("NEED_LOGIN", { url }); return; }
          const subs = d.subtitle?.subtitles ?? [];
          const meta = {
            bvid: d.bvid, aid: d.aid, cid: d.cid,
            title: d.title ?? document.title,
            up_mid: d.up_info?.mid ?? null, up_name: d.up_info?.name ?? null,
            pic: d.pic, duration: d.video_info?.duration ?? null,
            published_at: d.pubdate ? d.pubdate * 1000 : null,
            subs: subs.map((s) => ({
              lan: s.lan, lan_doc: s.lan_doc, track_type: s.type ?? null,
              subtitle_url: normalizeUrl(s.subtitle_url),
              url_missing: !normalizeUrl(s.subtitle_url), // spec §7.1 第四情况：单轨 url 缺失标记
            })),
          };
          console.log(`[inject] player API 拦到 bvid=${meta.bvid} subs=${meta.subs.length} title=${meta.title}`);
          post("PLAYER_META", meta);
        }).catch(() => {});
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
          post("PLAYER_META", {
            bvid: d.bvid, aid: d.aid, cid: d.cid, title: d.title ?? document.title,
            up_mid: d.up_info?.mid ?? null, up_name: d.up_info?.name ?? null,
            pic: d.pic, duration: d.video_info?.duration ?? null,
            published_at: d.pubdate ? d.pubdate * 1000 : null,
            subs: subs.map((s) => ({ lan: s.lan, lan_doc: s.lan_doc, track_type: s.type ?? null, subtitle_url: normalizeUrl(s.subtitle_url), url_missing: !normalizeUrl(s.subtitle_url) })),
          });
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
