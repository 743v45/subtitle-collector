(function () {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

  function isPlayerApi(url) {
    return typeof url === "string" && url.includes("api.bilibili.com/x/player");
  }

  function isSubtitleUrl(url) {
    if (typeof url !== "string") return false;
    return (
      url.includes("aisubtitle") ||
      url.includes("bfs/subtitle") ||
      url.includes("bfs/ai_subtitle")
    );
  }

  function post(type, data) {
    window.postMessage({ type, data }, "*");
  }

  // --- Intercept fetch ---
  window.fetch = async function (...args) {
    const response = await ORIGINAL_FETCH.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;

    if (isPlayerApi(url)) {
      response
        .clone()
        .json()
        .then((json) => {
          const subs = json?.data?.subtitle?.subtitles;
          if (subs?.length) post("BILIBILI_SUBTITLE_META", subs);
        })
        .catch(() => {});
    }

    if (isSubtitleUrl(url)) {
      response
        .clone()
        .json()
        .then((data) => post("BILIBILI_SUBTITLE_CONTENT", { url, data }))
        .catch(() => {});
    }

    return response;
  };

  // --- Intercept XHR ---
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    return ORIGINAL_XHR_OPEN.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (isPlayerApi(this._url)) {
      this.addEventListener("load", function () {
        try {
          const json = JSON.parse(this.responseText);
          const subs = json?.data?.subtitle?.subtitles;
          if (subs?.length) post("BILIBILI_SUBTITLE_META", subs);
        } catch {}
      });
    }

    if (isSubtitleUrl(this._url)) {
      this.addEventListener("load", function () {
        try {
          post("BILIBILI_SUBTITLE_CONTENT", {
            url: this._url,
            data: JSON.parse(this.responseText),
          });
        } catch {}
      });
    }

    return ORIGINAL_XHR_SEND.apply(this, args);
  };
})();
