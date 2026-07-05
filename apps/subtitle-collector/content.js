const collected = new Map(); // bvid -> { meta, bodies: Map<url, body> }
// TODO(M-2): 后续上报风控/登录事件用，预留 Set（暂只标记当前页 bvid，未消费）
const riskControl = new Set();
const needLogin = new Set();

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const { type, data } = event.data || {};
  if (type === "PLAYER_META") {
    const cur = collected.get(data.bvid) ?? { meta: data, bodies: new Map() };
    cur.meta = data;
    collected.set(data.bvid, cur);
    // 主动让 background 抓取字幕体（B 站新版播放器改用同源 protobuf endpoint，
    // inject 的 isSubtitleUrl 不再能拦到字幕请求；改由 background 用 host_permissions 免 CORS 抓取）
    fetchSubtitleBodiesViaBg(data.bvid, cur.meta.subs);
    flushIfReady(data.bvid);
  } else if (type === "SUBTITLE_BODY") {
    for (const [bvid, cur] of collected.entries()) {
      if (cur.meta.subs.some((s) => s.subtitle_url === data.url)) {
        cur.bodies.set(data.url, data.body);
        flushIfReady(bvid);
        return;
      }
    }
  } else if (type === "RISK_CONTROL") {
    if (collected.size > 0) riskControl.add([...collected.keys()].pop());
  } else if (type === "NEED_LOGIN") {
    if (collected.size > 0) needLogin.add([...collected.keys()].pop());
  }
});

// 让 background（host_permissions 免 CORS）抓取每轨字幕体，存入 bodies 后重试 flush
function fetchSubtitleBodiesViaBg(bvid, subs) {
  for (const s of subs) {
    const url = s.subtitle_url;
    if (!url || s.url_missing) continue;
    if (collected.get(bvid)?.bodies.has(url)) continue; // 已有（inject 拦到的）不重复
    // 上下文失效（扩展 reload/更新后旧 content 驻留）时 sendMessage 同步抛
    // "Extension context invalidated"；try/catch 兜底同步异常，回调查 lastError 兜底异步错误。
    try {
      chrome.runtime.sendMessage({ type: "FETCH_SUBTITLE", url }, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn(`[content] FETCH_SUBTITLE 失败 bvid=${bvid} url=${url.slice(-30)} err=${chrome.runtime.lastError.message}`);
          return;
        }
        const cur = collected.get(bvid);
        if (!cur) return;
        if (resp?.ok && resp.body) {
          cur.bodies.set(url, resp.body);
          console.log(`[content] background 抓到字幕体 bvid=${bvid} url=${url.slice(-30)} size=${JSON.stringify(resp.body).length}`);
          flushIfReady(bvid);
        } else {
          console.warn(`[content] background 抓字幕失败 bvid=${bvid} url=${url.slice(-30)} err=${resp?.error}`);
        }
      });
    } catch (e) {
      console.warn(`[content] FETCH_SUBTITLE 发送异常（扩展上下文可能已失效）bvid=${bvid} url=${url.slice(-30)} err=${e?.message}`);
    }
  }
}

function flushIfReady(bvid, force = false) {
  const cur = collected.get(bvid);
  if (!cur?.meta) return;
  const urlMissing = cur.meta.subs.filter((s) => !s.subtitle_url || s.url_missing);
  if (urlMissing.length > 0) {
    console.warn(`[collector] bvid=${bvid}: ${urlMissing.length} 轨 subtitle_url 缺失（url_missing），跳过这些轨`);
  }
  const ready = cur.meta.subs.filter((s) => cur.bodies.has(s.subtitle_url) || !s.subtitle_url);
  if (ready.length === 0) return;
  const tracks = cur.meta.subs.map((s) => {
    if (!s.subtitle_url || s.url_missing) return null; // url_missing 轨跳过，不报
    const body = cur.bodies.get(s.subtitle_url);
    if (!body) return null;
    return {
      lan: s.lan, lan_doc: s.lan_doc, track_type: s.track_type,
      versions: [{ origin: "external", payload: body, source_url: s.subtitle_url }],
    };
  }).filter(Boolean);
  if (tracks.length === 0) return;
  const record = {
    source: "bilibili",
    video: {
      source_vid: cur.meta.bvid,
      creator: { source_uid: String(cur.meta.up_mid ?? "unknown"), name: cur.meta.up_name },
      title: cur.meta.title,
      extra: cur.meta.extra ?? { aid: cur.meta.aid, cid: cur.meta.cid, pic: cur.meta.pic },
      duration: cur.meta.duration,
      published_at: cur.meta.published_at,
    },
    tracks,
  };
  console.log(`[content] INGEST bvid=${cur.meta.bvid} tracks=${tracks.length}${force ? " force=true（绕过开关）" : ""}`);
  try {
    chrome.runtime.sendMessage({ type: "INGEST", payload: record, ...(force ? { force: true } : {}) });
  } catch (e) {
    console.warn(`[content] INGEST 发送异常（扩展上下文可能已失效）bvid=${cur.meta.bvid} err=${e?.message}`);
  }
}

// operate 观察窗口：点击字幕开关后，若 inject 检测到真实字幕请求 → 视为生效
let operateWatch = { active: false, observedSubtitle: false };
window.addEventListener("message", (event) => {
  if (event.source === window && event.data?.type === "SUBTITLE_BODY") {
    operateWatch.observedSubtitle = true;
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // popup「已收集」改用本地数据源：直取 content.js 内存里 collected 的轨道/正文/extra。
  // 走 chrome.tabs.sendMessage（popup → 当前 tab 的 content script），不经 background。
  if (msg?.type === "GET_LOCAL_STATE") {
    const bvid = msg.bvid;
    const cur = bvid ? collected.get(bvid) : null;
    if (!cur?.meta) {
      sendResponse({ ok: true, state: "not-loaded" });
      return false;
    }
    const subs = cur.meta.subs ?? [];
    sendResponse({
      ok: true,
      state: subs.length === 0 ? "no-subtitle" : "has-subtitle",
      bvid,
      extra: cur.meta.extra ?? {},
      subs: subs.map((s) => ({
        lan: s.lan,
        lan_doc: s.lan_doc,
        track_type: s.track_type,
        subtitle_url: s.subtitle_url,
        url_missing: !!s.url_missing,
        has_body: cur.bodies.has(s.subtitle_url),
      })),
      bodies: Object.fromEntries(cur.bodies),
    });
    return false;
  }
  // RE_AGG：popup「手动上报」触发，强制重发已收集的 record。
  // msg.force=true 会透传到 INGEST，让 background 绕过上报开关。
  if (msg?.type === "RE_AGG") {
    const force = msg.force === true;
    for (const bvid of collected.keys()) flushIfReady(bvid, force);
    return false;
  }
  if (msg?.type === "OPERATE") {
    const { op } = msg;
    if (op === "click-subtitle-toggle") {
      const sel = ".bpx-player-ctrl-btn-icon, [aria-label*='字幕'], .subtitle-btn";
      const el = document.querySelector(sel);
      if (!el) { sendResponse({ ok: false, error: "toggle not found" }); return true; }

      operateWatch = { active: true, observedSubtitle: false };
      try { el.click(); } catch {}

      const tryWait = (clickedOk) => {
        setTimeout(() => {
          if (!operateWatch.observedSubtitle && clickedOk) {
            operateWatch.observedSubtitle = false;
            try {
              el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
              el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
              el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            } catch {}
            setTimeout(() => finish(operateWatch.observedSubtitle), 5000);
          } else {
            finish(operateWatch.observedSubtitle);
          }
          function finish(observed) {
            operateWatch.active = false;
            sendResponse({
              ok: true, clicked: true, subtitleObserved: observed,
              note: observed ? "click 触发了字幕请求" : "点击后 5s 内未观察到字幕请求，建议 CDP 降级",
            });
          }
        }, 5000);
      };
      tryWait(true);
    } else {
      sendResponse({ ok: false, error: "unknown op" });
    }
    return true;
  }
});
