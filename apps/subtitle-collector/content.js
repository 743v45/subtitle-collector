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
    chrome.runtime.sendMessage({ type: "FETCH_SUBTITLE", url }, (resp) => {
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
  }
}

function flushIfReady(bvid) {
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
      extra: { aid: cur.meta.aid, cid: cur.meta.cid, pic: cur.meta.pic },
      duration: cur.meta.duration,
      published_at: cur.meta.published_at,
    },
    tracks,
  };
  console.log(`[content] INGEST bvid=${cur.meta.bvid} tracks=${tracks.length}`);
  chrome.runtime.sendMessage({ type: "INGEST", payload: record });
}

// operate 观察窗口：点击字幕开关后，若 inject 检测到真实字幕请求 → 视为生效
let operateWatch = { active: false, observedSubtitle: false };
window.addEventListener("message", (event) => {
  if (event.source === window && event.data?.type === "SUBTITLE_BODY") {
    operateWatch.observedSubtitle = true;
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // RE_AGG：手动补采按钮触发，强制重发已收集的 record（修复 review I-3）
  if (msg?.type === "RE_AGG") {
    for (const bvid of collected.keys()) flushIfReady(bvid);
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
