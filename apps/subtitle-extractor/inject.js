// apps/subtitle-extractor/inject.js
// MAIN world:从 window.__playinfo__ 读 B站 DASH 音轨。
// 关键修正:dash 音视频地址不在 /x/player/wbi/v2(那是字幕/元信息),而在 playurl 响应里;
// B站视频页 SSR 把 playurl 结果写进 window.__playinfo__(播放器自己也用它),直接读这个全局最可靠。
// 不依赖拦 playurl 请求(播放器在 puppeteer/未交互时可能根本不发 playurl)。
(function () {
  function normalizeUrl(url) {
    if (typeof url !== "string") return "";
    return url.startsWith("//") ? "https:" + url : url;
  }
  function post(type, data) {
    window.postMessage({ type, data }, "*");
  }
  function currentPageBvid() {
    const m = location.pathname.match(/(BV[a-zA-Z0-9]+)/);
    return m ? m[1] : "";
  }

  // __playinfo__ = playurl 响应 JSON。字段 snake_case(base_url/backup_url)与 camelCase(baseUrl/backupUrl)都兼容。
  // dash.audio[] 按码率降序,首个是最高音质。baseUrl 即 m4s(fragmented MP4),CDN 带 auth_key 时效。
  function tryReadPlayinfo() {
    try {
      const pi = window.__playinfo__;
      if (!pi) return null;
      const dash = pi?.data?.dash;
      if (!dash || !Array.isArray(dash.audio) || dash.audio.length === 0) return null;
      const a = dash.audio[0];
      const url = normalizeUrl(a.baseUrl || a.base_url);
      if (!url) return null;
      const backup = a.backupUrl || a.backup_url || [];
      return {
        bvid: currentPageBvid(),
        title: document.title,
        audioUrl: url,
        backupUrls: Array.isArray(backup)
          ? backup.map(normalizeUrl).filter(Boolean)
          : [],
        duration: pi.data?.timelength
          ? pi.data.timelength / 1000
          : dash.duration ?? null,
      };
    } catch (e) {
      console.warn("[inject] tryReadPlayinfo error", e);
      return null;
    }
  }

  // 轮询 __playinfo__(document_start 注入时 SSR 可能还没写入,等它就绪)
  let tries = 0;
  const timer = setInterval(() => {
    const tracks = tryReadPlayinfo();
    if (tracks) {
      clearInterval(timer);
      console.log(
        `[inject] __playinfo__ 取到音轨: url=...${tracks.audioUrl.slice(-40)} backup=${tracks.backupUrls.length} bvid=${tracks.bvid}`,
      );
      post("AUDIO_TRACKS", tracks);
    } else if (++tries > 40) {
      // ~20s
      clearInterval(timer);
      console.warn(
        "[inject] __playinfo__ 20s 未就绪(SSR 未写入?需登录?wbi 风控降级?)",
      );
    }
  }, 500);
})();
