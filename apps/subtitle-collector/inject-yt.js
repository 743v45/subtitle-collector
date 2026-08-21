// MAIN world（document_start）注入：YouTube 字幕轨发现 + timedtext 拦截。
// 与 B 站 inject.js 同构（轮询读全局变量 + hook fetch/XHR），独立文件、独立消息源标记 'yt-sub-ext'。
// 契约依据：docs/superpowers/specs/2026-07-19-youtube-collector-design.md §5.1 / §3 / §6 / §7。
//
// 两条消息（window.postMessage → content-yt.js，信封 {source:'yt-sub-ext', type, data}）：
//   CAPTION_TRACKS  轮询读到 ytInitialPlayerResponse.captions 后发（轨元数据，可能空 = 无字幕）
//   TIMEDTEXT_BODY  hook 拦播放器自己发的 /api/timedtext（含 pot）响应体（仅成功且非空 body）

(function () {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

  const MSG_SOURCE = "yt-sub-ext";
  const POLL_INTERVAL = 500; // ms
  const MAX_POLLS = 40;      // 40 * 500ms = 20s（spec §7：document_start 时全局变量未就绪的轮询窗口）

  function post(type, data) {
    window.postMessage({ source: MSG_SOURCE, type, data }, "*");
  }

  // videoId 从 location.search 的 ?v= 抽（11 位 [A-Za-z0-9_-]，spec §5.1）；SPA 导航时 URL 先于 pr 更新。
  function currentPageVideoId() {
    const m = location.search.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    return m ? m[1] : "";
  }

  function isTimedTextUrl(url) {
    return typeof url === "string" && url.includes("/api/timedtext");
  }

  // 从 url 的 fmt= 参数判；只认 json3/xml，其余（srv1/2/3、缺省）返 null 交归一化函数按内容嗅探（spec §5.1）。
  function parseFmtFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const fmt = u.searchParams.get("fmt");
      if (fmt === "json3") return "json3";
      if (fmt === "xml") return "xml";
      return null;
    } catch {
      return null;
    }
  }

  // captionTrack.name 可能是 {simpleText} / {runs:[{text}]} / 字符串 / 缺省；统一抽成字符串（spec §5.1：name.simpleText）。
  function readTrackName(name) {
    if (name == null) return "";
    if (typeof name === "string") return name;
    if (typeof name.simpleText === "string") return name.simpleText;
    if (Array.isArray(name.runs)) return name.runs.map((r) => r?.text ?? "").join("");
    return "";
  }

  // 组装 CAPTION_TRACKS data。ytInitialPlayerResponse 未就绪或 videoId 与当前 URL 不符（SPA 导航中）返 null。
  function extractMeta() {
    const pr = window.ytInitialPlayerResponse;
    if (!pr || !pr.videoDetails) return null; // 全局变量未就绪，继续轮询
    const urlVid = currentPageVideoId();
    // SPA 导航期间 pr 可能仍是上一视频的：等 videoDetails.videoId 对上当前 URL 再发，避免发旧视频的轨。
    if (urlVid && pr.videoDetails.videoId && pr.videoDetails.videoId !== urlVid) return null;
    const vd = pr.videoDetails;
    const tracksRaw = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const tracks = Array.isArray(tracksRaw) ? tracksRaw : [];
    // 发布时间：microformat.playerMicroformatRenderer.publishDate（ISO 字符串，如
    // "2009-10-25T06:57:33-07:00" 或日期段 "2009-10-25"；uploadDate 同构兜底）。原始串透传，
    // 由 content-yt 用 parseYtPublishDateMs 转毫秒（对齐 B 站 pubdate×1000 口径）；缺失传 null。
    // dateText 是本地化人读串（如 "Oct 25, 2009"）非 ISO，不可靠解析，不用。
    const mf = pr?.microformat?.playerMicroformatRenderer;
    const publishDateRaw = typeof mf?.publishDate === "string" && mf.publishDate
      ? mf.publishDate
      : (typeof mf?.uploadDate === "string" && mf.uploadDate ? mf.uploadDate : null);
    return {
      videoId: urlVid || vd.videoId || "",
      title: vd.title ?? null,
      channelId: vd.channelId ?? null,
      channelName: vd.author ?? null,
      duration: vd.lengthSeconds ? Number(vd.lengthSeconds) : null, // 秒（videoDetails.lengthSeconds 是字符串）
      publishDate: publishDateRaw, // ISO 串；content-yt 转毫秒入 payload（published_at）
      viewCount: vd.viewCount ?? null,   // videoDetails.viewCount（字符串），popup 统计展示
      likeCount: vd.likeCount ?? null,   // videoDetails.likeCount（字符串）
      shortDescription: vd.shortDescription ?? null, // 简介（popup extra.desc 展示）
      captionTracks: tracks.map((t) => ({
        // baseUrl 含 signature/key/expire/c=WEB（可能含 pot）；YouTube 内联里 & 编码成 &amp;，fetch 前还原（spec §7）。
        baseUrl: typeof t.baseUrl === "string" ? t.baseUrl.replace(/&amp;/g, "&") : "",
        languageCode: t.languageCode ?? "",
        kind: t.kind ?? null, // 'asr'=自动生成；人工轨为 null
        name: readTrackName(t.name),
        vssId: t.vssId ?? "", // '.en' 人工 / 'a.en' asr
        isTranslatable: t.isTranslatable ?? false,
      })),
    };
  }

  // ---- 轮询读 ytInitialPlayerResponse（document_start 时可能未就绪，spec §7 同 B 站 __playinfo__ 模式）----
  let metaSent = false;
  let pollCount = 0;
  function pollMeta() {
    if (metaSent) return;
    const meta = extractMeta();
    if (meta) {
      metaSent = true;
      console.log(`[inject-yt] CAPTION_TRACKS videoId=${meta.videoId} tracks=${meta.captionTracks.length} title=${meta.title}`);
      post("CAPTION_TRACKS", meta);
      return;
    }
    pollCount++;
    if (pollCount >= MAX_POLLS) {
      console.warn(`[inject-yt] ytInitialPlayerResponse 轮询 ${MAX_POLLS} 次（~${(MAX_POLLS * POLL_INTERVAL) / 1000}s）未就绪，放弃`);
      return;
    }
    setTimeout(pollMeta, POLL_INTERVAL);
  }
  pollMeta();

  // YouTube 是 SPA：同一 tab 内点另一个视频不重载页面、document_start 不再触发。
  // 监听 yt 完成导航事件，重置并重轮询（pr 会被 yt 更新为新视频；extractMeta 的 videoId 守卫等其就绪）。
  window.addEventListener("yt-navigate-finish", () => {
    metaSent = false;
    pollCount = 0;
    console.log("[inject-yt] yt-navigate-finish，重新轮询 captionTracks");
    pollMeta();
  });

  // ---- fetch hook：拦 /api/timedtext 响应（含播放器拼好的 pot）；仅发成功且非空 body 的（spec §6 路径 A / §7 pot 空 200 不发）----
  window.fetch = async function (...args) {
    const response = await ORIGINAL_FETCH.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    try {
      if (isTimedTextUrl(url) && response.ok) {
        // clone() 后读 text()：不影响页面原响应；text 兼容 json3/xml 两种格式（归一化按 fmt/嗅探分发）。
        response.clone().text().then((text) => {
          if (text && text.trim().length > 0) {
            console.log(`[inject-yt] timedtext(fetch) videoId=${currentPageVideoId()} fmt=${parseFmtFromUrl(url)} size=${text.length}`);
            post("TIMEDTEXT_BODY", {
              videoId: currentPageVideoId(),
              url,
              fmt: parseFmtFromUrl(url),
              body: text,
            });
          } else {
            console.warn(`[inject-yt] timedtext(fetch) 空 body（可能 pot 受限）url=${String(url).slice(-60)}`);
          }
        }).catch((e) => console.error("[inject-yt] timedtext(fetch) parse error", e));
      }
    } catch (e) {
      console.error("[inject-yt] fetch hook error", e);
    }
    return response;
  };

  // ---- XHR hook：同上，兼容 responseType（text/arraybuffer，播放器可能用 arraybuffer 接字幕）----
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ytUrl = url;
    return ORIGINAL_XHR_OPEN.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isTimedTextUrl(this._ytUrl)) {
      this.addEventListener("load", function () {
        try {
          if (this.status < 200 || this.status >= 300) return; // 仅成功响应
          const r = this.response;
          let text = typeof r === "string" ? r : "";
          if (r instanceof ArrayBuffer) text = new TextDecoder().decode(r);
          if (text && text.trim().length > 0) {
            console.log(`[inject-yt] timedtext(xhr) videoId=${currentPageVideoId()} fmt=${parseFmtFromUrl(this._ytUrl)} size=${text.length}`);
            post("TIMEDTEXT_BODY", {
              videoId: currentPageVideoId(),
              url: this._ytUrl,
              fmt: parseFmtFromUrl(this._ytUrl),
              body: text,
            });
          } else {
            console.warn(`[inject-yt] timedtext(xhr) 空 body（可能 pot 受限）`);
          }
        } catch {}
      });
    }
    return ORIGINAL_XHR_SEND.apply(this, args);
  };
})();
