// MAIN world（document_start）注入：抖音视频详情 / 博主列表 / 博主资料拦截。
// 与 inject-yt.js 同构（hook fetch/XHR + 轮询全局变量），独立文件、独立消息源标记 'dy-sub-ext'。
// 依据 S1 spike 实测（docs/plans/douyin/spike-findings.md §1）——抖音 API URL 带全套页面签名
//（a_bogus/msToken/x-secsdk-web-signature，server 侧不可直构），页面上下文 hook 是唯一正路：
//   AWEME_DETAIL      hook 拦 /aweme/v1/web/aweme/detail/ 响应（snake_case aweme_detail 原样透传，
//                     /video/<id> SPA 主路径，比 SSR 稳——抖音自家 SPA 依赖的接口）
//   SSR_VIDEO_DETAIL  轮询 window.SSR_RENDER_DATA.app.videoDetail（camelCase 原样透传，
//                     /jingxuan?modal_id= 分享落地 SSR 形态；content-dy 负责归一）
//   POST_LIST         hook 拦 /aweme/v1/web/aweme/post/ 响应（博主作品列表游标翻页，
//                     博主批量 expand 用；secUid 从请求 URL 的 sec_user_id 抽）
//   POST_LIST_EMPTY   post 接口 200 空体（S1 实测：匿名被 gating 的静默失败，非 4xx——
//                     一等错误路径，不可误判「0 作品」）
//   PROFILE_OTHER     hook 拦 /aweme/v1/web/user/profile/other/ 响应（博主资料，匿名可用）
// hook 约束：fetch/XHR 包装不可避免全局，但只处理上述四类 URL 的响应，其余请求零处理直透。
(function () {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

  const MSG_SOURCE = "dy-sub-ext";
  const POLL_INTERVAL = 500; // ms
  const MAX_POLLS = 40;      // 40 * 500ms = 20s（document_start 时 SSR_RENDER_DATA 未挂的轮询窗口）

  function post(type, data) {
    window.postMessage({ source: MSG_SOURCE, type, data }, "*");
  }

  function isDetailUrl(url) {
    return typeof url === "string" && url.includes("/aweme/v1/web/aweme/detail/");
  }
  function isPostUrl(url) {
    return typeof url === "string" && url.includes("/aweme/v1/web/aweme/post/");
  }
  function isProfileUrl(url) {
    return typeof url === "string" && url.includes("/aweme/v1/web/user/profile/other/");
  }

  // detail 响应归一：标准形 {status_code, aweme_detail}；容忍响应体直接是 aweme_detail 本体
  function extractDetailBody(json) {
    if (!json || typeof json !== "object") return null;
    if (json.aweme_detail && typeof json.aweme_detail === "object") return json.aweme_detail;
    if (json.aweme_id != null) return json;
    return null;
  }

  // post/profile 的 sec_user_id 从请求 URL query 抽（回传供 content-dy 按 secUid 聚合过滤）
  function secUidFromUrl(url) {
    try {
      return new URL(url, location.origin).searchParams.get("sec_user_id") || "";
    } catch {
      return "";
    }
  }

  // detail 响应透传（页面自身会发多次 detail XHR——S1 实测单页 3 次，每次都透传，content-dy 按
  // aweme_id 幂等覆盖）
  function postDetailMessage(url, json) {
    const detail = extractDetailBody(json);
    if (detail) {
      console.log(`[inject-dy] AWEME_DETAIL aweme=${detail.aweme_id} keys=${Object.keys(detail).length}`);
      post("AWEME_DETAIL", { awemeId: detail.aweme_id != null ? String(detail.aweme_id) : "", detail });
    } else {
      console.warn(`[inject-dy] detail 响应无 aweme_detail（status_code=${json.status_code}）`);
    }
  }

  // post 列表透传（空列表 aweme_list:[] + has_more:false 是「翻完/真没了」，与空体不同：照常透传）
  function postListMessage(url, json) {
    if (json.aweme_list && Array.isArray(json.aweme_list)) {
      console.log(`[inject-dy] POST_LIST secUid=${secUidFromUrl(url)} n=${json.aweme_list.length} has_more=${json.has_more === true}`);
      post("POST_LIST", {
        secUid: secUidFromUrl(url),
        hasMore: json.has_more === true,
        awemeList: json.aweme_list,
      });
    } else {
      console.warn(`[inject-dy] post 响应无 aweme_list（status_code=${json.status_code}）`);
    }
  }

  // profile 资料透传（匿名可用，S1 实测）
  function postProfileMessage(url, json) {
    if (json.user && typeof json.user === "object") {
      console.log(`[inject-dy] PROFILE_OTHER secUid=${secUidFromUrl(url)} nickname=${json.user.nickname}`);
      post("PROFILE_OTHER", { secUid: secUidFromUrl(url), user: json.user });
    } else {
      console.warn(`[inject-dy] profile/other 响应无 user（status_code=${json.status_code}）`);
    }
  }

  // 统一分发：body 为 string（text 响应，可能空串）或已解析对象（responseType=json 的 XHR）。
  // 2026-08-29 S8 台账性重构：三类 URL 各自拆透传函数（复杂度台账达标），逻辑逐字原样搬移。
  function handlePayload(url, body) {
    try {
      if (isPostUrl(url) && (body == null || (typeof body === "string" && body.trim().length === 0))) {
        // 200 空体 = 未登录/风控 gating（S1 实测两次复现）——显式上报让上层报「需登录」
        console.warn(`[inject-dy] post 列表 200 空体（未登录/风控 gating）secUid=${secUidFromUrl(url)}`);
        post("POST_LIST_EMPTY", { secUid: secUidFromUrl(url) });
        return;
      }
      let json = body;
      if (typeof body === "string") {
        try { json = JSON.parse(body); } catch {
          console.warn(`[inject-dy] 响应 JSON 解析失败 url=${String(url).slice(-60)} size=${body.length}`);
          return;
        }
      }
      if (!json || typeof json !== "object") return;
      if (isDetailUrl(url)) postDetailMessage(url, json);
      else if (isPostUrl(url)) postListMessage(url, json);
      else if (isProfileUrl(url)) postProfileMessage(url, json);
    } catch (e) {
      console.error("[inject-dy] hook 处理异常", e);
    }
  }

  // ---- 轮询读 SSR_RENDER_DATA.app.videoDetail（/jingxuan?modal_id= 分享落地形态；document_start 时未挂）----
  let ssrSent = false;
  let ssrPollCount = 0;
  function pollSsr() {
    if (ssrSent) return;
    const vd = window.SSR_RENDER_DATA?.app?.videoDetail;
    if (vd && typeof vd === "object") {
      ssrSent = true;
      console.log(`[inject-dy] SSR_VIDEO_DETAIL aweme=${vd.awemeId} keys=${Object.keys(vd).length}`);
      post("SSR_VIDEO_DETAIL", { videoDetail: vd });
      return;
    }
    ssrPollCount++;
    if (ssrPollCount >= MAX_POLLS) {
      // /video/ 页 SSR 本就不含 videoDetail（S1 实测），此告警在多数页面是正常路径，降为 debug 语气
      console.log(`[inject-dy] SSR_RENDER_DATA.videoDetail 轮询 ${MAX_POLLS} 次（~${(MAX_POLLS * POLL_INTERVAL) / 1000}s）未出现（/video/ 页属正常，走 detail XHR 路）`);
      return;
    }
    setTimeout(pollSsr, POLL_INTERVAL);
  }
  pollSsr();

  // ---- fetch hook：clone 后读 text，不影响页面原响应 ----
  window.fetch = async function (...args) {
    const response = await ORIGINAL_FETCH.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    try {
      if ((isDetailUrl(url) || isPostUrl(url) || isProfileUrl(url)) && response.ok) {
        response.clone().text().then((text) => handlePayload(url, text)).catch((e) => console.error("[inject-dy] fetch clone 读体失败", e));
      }
    } catch (e) {
      console.error("[inject-dy] fetch hook error", e);
    }
    return response;
  };

  // ---- XHR hook：兼容 responseType（''/text → responseText；json → response 对象）----
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._dyUrl = url;
    return ORIGINAL_XHR_OPEN.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._dyUrl;
    if (isDetailUrl(url) || isPostUrl(url) || isProfileUrl(url)) {
      this.addEventListener("load", function () {
        try {
          if (this.status < 200 || this.status >= 300) {
            console.warn(`[inject-dy] XHR 非 2xx status=${this.status} url=${String(url).slice(-60)}`);
            return;
          }
          if (this.responseType === "json" || (this.responseType !== "" && this.responseType !== "text")) {
            handlePayload(url, this.response); // json 类型直接拿对象（responseText 会抛 InvalidStateError）
          } else {
            handlePayload(url, this.responseText); // ''/text 类型读文本（空体 = '' 由 handlePayload 识别）
          }
        } catch {}
      });
    }
    return ORIGINAL_XHR_SEND.apply(this, args);
  };
})();
