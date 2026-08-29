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
//   PROFILE_OTHER_ERROR profile/other 异常终态（2026-08-30 spike：docs/plans/douyin/
//                     upper-page-spike.md——sec_uid 已注销的博主页回 200 + status_code:2
//                     「UserId不合法」+ user:{}，旧 user-truthiness 判定会让 {} 穿透伪装成功；
//                     双保险判据 status_code!==0 或 user 缺 sec_uid 即报，status_msg 透传；
//                     空体/坏 JSON 同归此消息，与 POST_LIST_EMPTY 对称，不再静默丢弃）
// hook 约束：fetch/XHR 包装不可避免全局，但只处理上述 URL 的响应，其余请求零处理直透。
// host/版本登记（2026-08-30 spike §6.6，暂无需动作）：拦截按路径子串匹配，host 为
// www.douyin.com 或灰度 www-hj.douyin.com 均天然兼容；post 请求自带 version_code=290100/
// version_name=29.1.0（其余接口 17.4.0 灰度差异）——若未来加 host/参数白名单需回头查这两处。
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

  // profile 资料透传（匿名可用，S1 实测）。2026-08-30 spike：sec_uid 已注销的博主页 profile/other
  // 回 200 + status_code:2「UserId不合法」+ user:{}——user:{} 对 truthiness 判定穿透（伪装 ok+
  // total:0），故双保险判据：status_code!==0 或 user 缺 sec_uid → PROFILE_OTHER_ERROR
  //（status_msg 透传，content-dy 置「博主不存在」错误态秒级失败，不耗 20s 无进展窗口）。
  function postProfileMessage(url, json) {
    const secUid = secUidFromUrl(url);
    const userOk = json.user && typeof json.user === "object"
      && typeof json.user.sec_uid === "string" && json.user.sec_uid !== "";
    if (json.status_code !== 0 || !userOk) {
      const statusMsg = typeof json.status_msg === "string" ? json.status_msg : "";
      console.warn(`[inject-dy] PROFILE_OTHER_ERROR secUid=${secUid} status_code=${json.status_code ?? "?"} status_msg=${statusMsg || "?"}（博主不存在/profile 异常）`);
      post("PROFILE_OTHER_ERROR", { secUid, kind: "status", statusCode: json.status_code ?? null, statusMsg });
      return;
    }
    console.log(`[inject-dy] PROFILE_OTHER secUid=${secUid} nickname=${json.user.nickname}`);
    post("PROFILE_OTHER", { secUid, user: json.user });
  }

  // 空体分发（复杂度台账拆分）：post → POST_LIST_EMPTY（未登录/风控 gating 一等错误）；
  // profile → PROFILE_OTHER_ERROR（2026-08-30 spike ③，与 POST_LIST_EMPTY 对称，不再静默丢弃）。
  // 返回是否已处理（调用方处理后即 return）。
  function handleEmptyBody(url) {
    if (isPostUrl(url)) {
      console.warn(`[inject-dy] post 列表 200 空体（未登录/风控 gating）secUid=${secUidFromUrl(url)}`);
      post("POST_LIST_EMPTY", { secUid: secUidFromUrl(url) });
      return true;
    }
    if (isProfileUrl(url)) {
      console.warn(`[inject-dy] profile/other 200 空体 secUid=${secUidFromUrl(url)}（profile 异常终态）`);
      post("PROFILE_OTHER_ERROR", { secUid: secUidFromUrl(url), kind: "empty-body", statusCode: null, statusMsg: "" });
      return true;
    }
    return false;
  }

  // 坏 JSON 分发（复杂度台账拆分）：profile 归 PROFILE_OTHER_ERROR（明确报错，不再让 M2 兜底
  // 文案误报「页面改版或未注入」）；其余 URL 维持告警丢弃（原行为）。
  function handleBadJson(url, body) {
    if (isProfileUrl(url)) {
      console.warn(`[inject-dy] profile/other 响应 JSON 解析失败 secUid=${secUidFromUrl(url)} size=${body.length}`);
      post("PROFILE_OTHER_ERROR", { secUid: secUidFromUrl(url), kind: "bad-json", statusCode: null, statusMsg: "" });
      return;
    }
    console.warn(`[inject-dy] 响应 JSON 解析失败 url=${String(url).slice(-60)} size=${body.length}`);
  }

  // 非对象响应体分发（复杂度台账拆分）：profile 的 "null"/裸标量形态同归 bad-json 错误；
  // 其余 URL 维持静默跳过（原行为）。
  function handleNonObjectBody(url) {
    if (isProfileUrl(url)) post("PROFILE_OTHER_ERROR", { secUid: secUidFromUrl(url), kind: "bad-json", statusCode: null, statusMsg: "" });
  }

  // 统一分发：body 为 string（text 响应，可能空串）或已解析对象（responseType=json 的 XHR）。
  // 2026-08-29 S8 台账性重构：三类 URL 各自拆透传函数（复杂度台账达标），逻辑逐字原样搬移。
  function handlePayload(url, body) {
    try {
      const emptyBody = body == null || (typeof body === "string" && body.trim().length === 0);
      if (emptyBody && handleEmptyBody(url)) return;
      let json = body;
      if (typeof body === "string") {
        try { json = JSON.parse(body); } catch { handleBadJson(url, body); return; }
      }
      if (!json || typeof json !== "object") { handleNonObjectBody(url); return; }
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
